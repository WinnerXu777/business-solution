import { PlatformError } from './audit.ts';
import { catalogPriceVersion, isSku, sku, type SkuId } from './billing-catalog.ts';

interface UsageIdentity {
  skuId: SkuId;
  outcomeId: string;
  unit: string;
  quantity: number;
  occurredAt: string;
  priceVersion: string;
}

export interface OutcomeUsage extends UsageIdentity {
  kind: 'outcome';
}

export interface ProviderUsage extends UsageIdentity {
  kind: 'provider';
  attemptId: string;
  providerId: string;
  accountRef?: string;
  region: string;
  mode: 'byo' | 'premium';
  vendorCostCents?: number;
}

export type BillingUsage = OutcomeUsage | ProviderUsage;

export interface ProviderPrice {
  version: string;
  providerId: string;
  unit: string;
  mode: ProviderUsage['mode'];
  chargeMode: 'informational' | 'pass_through' | 'uplift';
  upliftUnitCents?: number;
}

export interface OveragePrice {
  skuId: SkuId;
  unit: string;
  unitCents: number;
}

export interface RatedUsage {
  event: BillingUsage;
  chargeMode: 'included' | ProviderPrice['chargeMode'];
  amountCents: number;
}

export function nonnegativeInteger(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function cents(value: number) {
  if (!nonnegativeInteger(value)) throw new PlatformError('forbidden', 'Invalid CAD cents.');
  return value;
}

export function usageKey(event: BillingUsage) {
  const { skuId, unit } = event;
  return JSON.stringify(
    event.kind === 'outcome'
      ? ['outcome', skuId, event.outcomeId, unit]
      : ['provider', skuId, event.providerId, event.attemptId, unit],
  );
}

export function rateUsage(
  event: BillingUsage,
  providerPrices: readonly ProviderPrice[],
): RatedUsage {
  if (
    !isSku(event.skuId) ||
    !event.outcomeId ||
    !event.unit ||
    !nonnegativeInteger(event.quantity) ||
    event.quantity === 0
  ) {
    throw new PlatformError('forbidden', 'Invalid billing usage event.');
  }
  if (event.kind === 'outcome') {
    if (
      event.priceVersion !== catalogPriceVersion ||
      !sku(event.skuId).meters.some(({ unit }) => unit === event.unit)
    ) {
      throw new PlatformError('forbidden', 'Unknown outcome meter or price version.');
    }
    return { event, chargeMode: 'included', amountCents: 0 };
  }
  if (event.kind !== 'provider' || !event.attemptId || !event.providerId || !event.region) {
    throw new PlatformError('forbidden', 'Invalid provider attempt.');
  }
  if (event.vendorCostCents !== undefined) cents(event.vendorCostCents);
  const price = providerPrices.find(
    (item) =>
      item.version === event.priceVersion &&
      item.providerId === event.providerId &&
      item.unit === event.unit &&
      item.mode === event.mode,
  );
  if (
    !price ||
    (price.chargeMode === 'pass_through' &&
      (event.mode !== 'premium' || event.vendorCostCents === undefined))
  ) {
    throw new PlatformError('forbidden', 'Provider price version or charge mode is unavailable.');
  }
  const amountCents =
    price.chargeMode === 'pass_through'
      ? event.vendorCostCents!
      : price.chargeMode === 'uplift'
        ? cents(event.quantity * cents(price.upliftUnitCents ?? NaN))
        : 0;
  return { event, chargeMode: price.chargeMode, amountCents };
}
