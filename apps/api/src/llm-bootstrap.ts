import { createFixtureModelAdapter } from '../../../packages/adapters/src/llm/index.ts';
import {
  catalogPriceVersion,
  PlatformError,
  type MutationContext,
  type PlatformServices,
  type ResolvedBinding,
} from '../../../packages/core/src/platform/index.ts';
import type { Capability, LlmPluginOptions, Route } from './llm/index.ts';

const adapter = createFixtureModelAdapter();

function route(provider: ResolvedBinding['provider'], capability: Capability): Route {
  const native = provider.mode === 'native';
  const alias = capability === 'llm' ? 'fixture-chat' : 'fixture-embedding';
  return {
    adapter: { ...adapter, provider: provider.providerId },
    routeId: provider.providerId,
    priceVersion: native ? catalogPriceVersion : 'simulation-v1',
    chargeMode: native ? 'native' : 'byo',
    models: { [alias]: native ? alias : provider.providerId + '-' + alias },
    estimateInputTokens: (input) => Buffer.byteLength(JSON.stringify(input)),
  };
}

export function platformLlm(services: PlatformServices, now: () => string): LlmPluginOptions {
  return {
    now: () => Date.parse(now()),
    async verifyApiKey(key, endpoint) {
      const match =
        /^([a-zA-Z0-9_-]{1,128})\.(connection-[a-f0-9-]{36})\.(fixture_[a-zA-Z0-9_-]{43})$/.exec(
          key,
        );
      if (!match) return null;
      const [, tenantId, id, secret] = match;
      if ((await services.directory.activeVersion(tenantId)) === undefined) return null;
      const authorized = await services.connections.authenticate(
        tenantId,
        id,
        secret,
        'api_client',
        'llm.' + endpoint,
      );
      return authorized && (await services.directory.activeVersion(tenantId)) !== undefined
        ? { tenantId }
        : null;
    },
    async resolveBinding(tenantId, capability) {
      const modules = await services.entitlements.listing(tenantId, []);
      if (!modules.some((entry) => entry.moduleId === 'ai' && entry.enabled)) return null;
      const plan = await services.billing.plan(tenantId);
      const allowance = plan.allowances.find(
        ({ skuId, unit }) => skuId === 'platform' && unit === 'tokens',
      );
      if (!allowance || allowance.used >= allowance.included) return null;
      try {
        const binding = await services.resolveBinding(tenantId, capability, {
          operation: 'inference',
          dataClasses: ['synthetic'],
        });
        return {
          version: String(binding.version),
          primary: route(binding.provider, capability),
          ...(binding.fallbackPolicy && {
            inferenceFallback: route(binding.fallbackPolicy.provider, capability),
          }),
        };
      } catch (error) {
        if (error instanceof PlatformError) return null;
        throw error;
      }
    },
    async emitUsage(record) {
      if (record.inputTokens === null || record.outputTokens === null) return;
      const quantity = record.inputTokens + record.outputTokens;
      if (!quantity) return;
      const context: MutationContext = {
        tenantId: record.tenantId,
        actor: { id: 'service-llm', kind: 'service' },
        source: 'rest',
        traceId: record.requestId,
        correlationId: record.requestId,
      };
      const usage = {
        skuId: 'platform' as const,
        outcomeId: record.eventId,
        unit: 'tokens',
        occurredAt: now(),
        quantity,
      };
      await services.billing.recordUsage(context, {
        ...usage,
        kind: 'outcome',
        priceVersion: catalogPriceVersion,
      });
      if (record.chargeMode === 'byo') {
        const premium = ['amazon-bedrock', 'cohere-vault'].includes(record.provider);
        await services.billing.recordUsage(context, {
          ...usage,
          kind: 'provider',
          attemptId: record.eventId,
          providerId: record.provider,
          region: premium ? 'ca-central-1' : 'global',
          mode: premium ? 'premium' : 'byo',
          priceVersion: record.priceVersion,
        });
      }
    },
  };
}
