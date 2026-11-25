import { ConnectorLifecycle, type Installation } from './lifecycle.ts';
import {
  ConnectorError,
  SerialQueue,
  canonical,
  keyOf,
  stableId,
  type BindingRef,
  type Capability,
  type EffectResolution,
  type WriteIntent,
} from './sdk.ts';

export interface WriteActor {
  actorId: string;
  tenantId: string;
}

/** Throw a typed failure unless the exact intent is currently permitted and approved. */
export type WriteAuthorizer = (request: {
  actor: WriteActor;
  binding: Installation;
  intent: WriteIntent;
}) => Promise<void>;

interface Attempt {
  material: string;
  resolution: EffectResolution;
}

export class ConnectorWrites {
  private readonly manualFreezes = new Set<string>();
  private readonly unknown = new Map<string, Set<string>>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly queue = new SerialQueue();
  private readonly lifecycle: ConnectorLifecycle;
  private readonly authorize: WriteAuthorizer;

  constructor(lifecycle: ConnectorLifecycle, authorize: WriteAuthorizer) {
    this.lifecycle = lifecycle;
    this.authorize = authorize;
  }

  setFrozen(tenantId: string, capability: Capability, frozen: boolean) {
    const key = keyOf(tenantId, capability);
    if (frozen) this.manualFreezes.add(key);
    else this.manualFreezes.delete(key);
  }

  isFrozen(tenantId: string, capability: Capability): boolean {
    const key = keyOf(tenantId, capability);
    return this.manualFreezes.has(key) || Boolean(this.unknown.get(key)?.size);
  }

  write(actor: WriteActor, ref: BindingRef, original: WriteIntent) {
    this.checkTenant(actor, ref);
    const intent = structuredClone(original);
    const { capability } = this.lifecycle.manifest(ref);
    const key = keyOf(ref.tenantId, capability);
    return this.queue.run(key, () =>
      this.lifecycle.withActive(ref, 'write', async ({ binding, connector, context }) => {
        if (!connector.write || !connector.reconcile) throw new ConnectorError('unsupported');
        if (!connector.manifest.authoritativeFor.includes(intent.recordClass)) {
          throw new ConnectorError('permission_denied');
        }
        if (!intent.idempotencyKey || !intent.externalId || !intent.expectedVersion) {
          throw new ConnectorError('validation_failed');
        }
        await this.authorize({
          actor: { ...actor },
          binding: { ...binding },
          intent: structuredClone(intent),
        });
        const material = stableId(
          canonical({
            actorId: actor.actorId,
            recordClass: intent.recordClass,
            externalId: intent.externalId,
            expectedVersion: intent.expectedVersion,
            fields: intent.fields,
          }),
        );
        const effectId = stableId(
          ref.tenantId,
          ref.connectionId,
          binding.accountId,
          intent.idempotencyKey,
        );
        const attemptKey = this.attemptKey(ref, effectId);
        const prior = this.attempts.get(attemptKey);
        if (prior) {
          if (prior.material !== material) throw new ConnectorError('conflict');
          return { ...prior.resolution };
        }
        if (this.isFrozen(ref.tenantId, capability)) throw new ConnectorError('write_frozen');
        const attempt: Attempt = { material, resolution: { status: 'unknown', effectId } };
        const holds = this.unknown.get(key) ?? new Set<string>();
        holds.add(effectId);
        this.unknown.set(key, holds);
        this.attempts.set(attemptKey, attempt);
        try {
          attempt.resolution = normalizeResolution(
            await connector.write(context, { ...intent, effectId }),
            effectId,
          );
        } catch {
          // Invocation began. A transport failure leaves the effect unresolved.
        }
        if (attempt.resolution.status !== 'unknown') this.release(key, effectId);
        return { ...attempt.resolution };
      }),
    );
  }

  reconcile(ref: BindingRef, effectId: string) {
    const { capability } = this.lifecycle.manifest(ref);
    const key = keyOf(ref.tenantId, capability);
    return this.queue.run(key, () =>
      this.lifecycle.withActive(ref, 'reconcile', async ({ connector, context }) => {
        if (!connector.reconcile) throw new ConnectorError('unsupported');
        const attempt = this.attempts.get(this.attemptKey(ref, effectId));
        if (!attempt) throw new ConnectorError('not_found');
        if (attempt.resolution.status !== 'unknown') return { ...attempt.resolution };
        const providerEffectId = attempt.resolution.providerEffectId;
        const result = normalizeResolution(
          await connector.reconcile(context, providerEffectId ?? effectId),
          effectId,
          providerEffectId,
        );
        attempt.resolution = result;
        if (result.status !== 'unknown') this.release(key, effectId);
        return { ...result };
      }),
    );
  }

  private checkTenant(actor: WriteActor, ref: BindingRef) {
    if (actor.tenantId !== ref.tenantId || !actor.actorId) throw new ConnectorError('not_found');
  }

  private attemptKey(ref: BindingRef, effectId: string) {
    return keyOf(ref.tenantId, ref.connectionId, effectId);
  }

  private release(key: string, effectId: string) {
    const holds = this.unknown.get(key);
    holds?.delete(effectId);
    if (holds?.size === 0) this.unknown.delete(key);
  }
}

function normalizeResolution(
  result: EffectResolution,
  effectId: string,
  providerEffectId?: string,
): EffectResolution {
  if (
    !result ||
    !['applied', 'not_applied', 'unknown'].includes(result.status) ||
    (result.effectId !== effectId && result.effectId !== providerEffectId) ||
    (result.providerEffectId !== undefined && typeof result.providerEffectId !== 'string')
  )
    throw new ConnectorError('validation_failed');
  return {
    status: result.status,
    effectId,
    providerEffectId: result.providerEffectId ?? providerEffectId,
  };
}
