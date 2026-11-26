import { ConnectorLifecycle, type Installation } from './lifecycle.ts';
import {
  ConnectorError,
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
  connectionId: string;
  material: string;
  resolution: EffectResolution;
}

export class ConnectorWrites {
  private readonly lifecycle: ConnectorLifecycle;
  private readonly authorize: WriteAuthorizer;

  constructor(lifecycle: ConnectorLifecycle, authorize: WriteAuthorizer) {
    this.lifecycle = lifecycle;
    this.authorize = authorize;
  }

  setFrozen(tenantId: string, capability: Capability, frozen: boolean) {
    this.lifecycle.repository.put(tenantId, 'writes', keyOf('manual', capability), frozen);
  }

  isFrozen(tenantId: string, capability: Capability): boolean {
    return (
      Boolean(this.lifecycle.repository.get(tenantId, 'writes', keyOf('manual', capability))) ||
      Object.values(this.attempts(tenantId, capability)).some(
        ({ resolution }) => resolution.status === 'unknown',
      )
    );
  }

  write(actor: WriteActor, ref: BindingRef, original: WriteIntent) {
    this.checkTenant(actor, ref);
    const intent = structuredClone(original);
    const { capability } = this.lifecycle.manifest(ref);
    return this.lifecycle.repository.lease(ref.tenantId, keyOf('writes', capability), () =>
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
        const attempts = this.attempts(ref.tenantId, capability);
        const prior = attempts[effectId];
        if (prior) {
          if (prior.material !== material) throw new ConnectorError('conflict');
          return { ...prior.resolution };
        }
        if (this.isFrozen(ref.tenantId, capability)) throw new ConnectorError('write_frozen');
        const attempt: Attempt = {
          connectionId: ref.connectionId,
          material,
          resolution: { status: 'unknown', effectId },
        };
        attempts[effectId] = attempt;
        this.save(ref.tenantId, capability, attempts);
        try {
          attempt.resolution = normalizeResolution(
            await connector.write(context, { ...intent, effectId }),
            effectId,
          );
        } catch {
          // Invocation began. A transport failure leaves the effect unresolved.
        }
        this.save(ref.tenantId, capability, attempts);
        return { ...attempt.resolution };
      }),
    );
  }

  reconcile(ref: BindingRef, effectId: string) {
    const { capability } = this.lifecycle.manifest(ref);
    return this.lifecycle.repository.lease(ref.tenantId, keyOf('writes', capability), () =>
      this.lifecycle.withActive(ref, 'reconcile', async ({ connector, context }) => {
        if (!connector.reconcile) throw new ConnectorError('unsupported');
        const attempts = this.attempts(ref.tenantId, capability);
        const attempt = Object.hasOwn(attempts, effectId) ? attempts[effectId] : undefined;
        if (!attempt || attempt.connectionId !== ref.connectionId)
          throw new ConnectorError('not_found');
        if (attempt.resolution.status !== 'unknown') return { ...attempt.resolution };
        const providerEffectId = attempt.resolution.providerEffectId;
        const result = normalizeResolution(
          await connector.reconcile(context, providerEffectId ?? effectId),
          effectId,
          providerEffectId,
        );
        attempt.resolution = result;
        this.save(ref.tenantId, capability, attempts);
        return { ...result };
      }),
    );
  }

  private checkTenant(actor: WriteActor, ref: BindingRef) {
    if (actor.tenantId !== ref.tenantId || !actor.actorId) throw new ConnectorError('not_found');
  }

  private attempts(tenantId: string, capability: Capability) {
    return (
      this.lifecycle.repository.get<Record<string, Attempt>>(tenantId, 'writes', capability) ?? {}
    );
  }

  private save(tenantId: string, capability: Capability, attempts: Record<string, Attempt>) {
    this.lifecycle.repository.put(tenantId, 'writes', capability, attempts);
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
