export const catalogPriceVersion = 'cad-v1';
export const currency = 'CAD';

type Meter = { unit: string; allowance: number; aggregation: 'sum' | 'peak' | 'weekly_peak' };

function meter(unit: string, allowance: number, aggregation: Meter['aggregation'] = 'sum'): Meter {
  return { unit, allowance, aggregation };
}

const catalog = {
  platform: { name: 'Platform', monthlyCents: 65_000, meters: [meter('tokens', 1_000_000)] },
  erp: { name: 'Native or connected ERP', monthlyCents: 40_000, meters: [meter('orders', 1_000)] },
  crm: {
    name: 'Native or connected CRM',
    monthlyCents: 25_000,
    meters: [meter('active_records', 10_000, 'peak')],
  },
  'inbound-chat': {
    name: 'Inbound chat',
    monthlyCents: 20_000,
    meters: [meter('conversations', 500)],
  },
  'inbound-voice': {
    name: 'Inbound voice',
    monthlyCents: 40_000,
    meters: [meter('audio_seconds', 60_000)],
  },
  procurement: { name: 'PR-to-PO', monthlyCents: 30_000, meters: [meter('requisitions', 100)] },
  'collections-email': {
    name: 'Collections email',
    monthlyCents: 30_000,
    meters: [meter('messages', 500)],
  },
  'collections-outbound': {
    name: 'Collections outbound AI voice and SMS',
    monthlyCents: 35_000,
    meters: [meter('audio_seconds', 15_000), meter('sms_segments', 500)],
  },
  workflows: {
    name: 'Customer workflow builder',
    monthlyCents: 35_000,
    meters: [meter('runs', 1_000)],
  },
  fraud: { name: 'Fraud review', monthlyCents: 50_000, meters: [meter('orders', 5_000)] },
  forecasting: {
    name: 'Sales and demand prediction',
    monthlyCents: 40_000,
    meters: [meter('series', 500, 'weekly_peak')],
  },
  profiling: { name: 'Customer profiling', monthlyCents: 50_000, meters: [meter('profiles', 500)] },
};

export type SkuId = keyof typeof catalog;
export type AddOnId = Exclude<SkuId, 'platform'>;

export function isSku(id: string): id is SkuId {
  return Object.hasOwn(catalog, id);
}

export function sku(id: SkuId) {
  return { id, ...structuredClone(catalog[id]), currency, priceVersion: catalogPriceVersion };
}

export function billingSkus() {
  return (Object.keys(catalog) as SkuId[]).map(sku);
}
