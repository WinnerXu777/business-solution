import { AsyncLocalStorage } from 'node:async_hooks';
import type { Approval, CallEnvelope, Denied, Failed } from '@bs/contracts';
import type { GovernedGateway } from '@bs/core';
import {
  PlatformError,
  type MutationContext,
  type PlatformServices,
} from '../../../packages/core/src/platform/index.ts';

function decisionEnvelope(context: MutationContext, idempotencyKey: string): CallEnvelope {
  return { ...context, version: 'v1', idempotencyKey };
}

function requireApproval(result: Approval | Denied | Failed) {
  if ('code' in result) {
    throw new PlatformError(
      result.state === 'failed'
        ? 'invalid_approval'
        : result.code === 'suppressed'
          ? 'invalid_approval'
          : result.code,
    );
  }
  return result;
}

/** Bind the platform routes' synchronous fixture reporting interface to the verified request. */
export function connectPlatformGateway(services: PlatformServices, gateway: GovernedGateway) {
  const reports = new AsyncLocalStorage<
    Awaited<ReturnType<GovernedGateway['reportingSnapshot']>>
  >();
  const transport = Object.assign(services.gateway, {
    call: gateway.call.bind(gateway),
    signApproval: gateway.signApproval.bind(gateway),
    listApprovals: async (tenantId: string, state?: Exclude<Approval['state'], 'denied'>) =>
      (await gateway.listApprovals(tenantId, state)).filter((grant) => grant.state !== 'denied'),
    async sign(context: MutationContext, id: string) {
      const grant = (await gateway.listApprovals(context.tenantId)).find(
        ({ id: key }) => key === id,
      );
      const envelope = decisionEnvelope(context, 'sign-' + id);
      if (grant?.tool !== 'purchase.order.approve')
        return requireApproval(await gateway.signApproval(envelope, id));

      const result = await gateway.call({
        envelope,
        tool: grant.tool,
        input: { draftId: grant.subjectId, approvalId: id },
      });
      if (result.state === 'denied') {
        throw new PlatformError(result.code === 'suppressed' ? 'invalid_approval' : result.code);
      }
      if (result.state !== 'ok') throw new PlatformError('unavailable');
      return { ...grant, state: 'consumed' as const };
    },
    async reject(context: MutationContext, id: string, reason: string) {
      return requireApproval(
        await gateway.rejectApproval(decisionEnvelope(context, 'reject-' + id), id, reason),
      );
    },
    async setModule(context: MutationContext, module: string, enabled: boolean) {
      return services.entitlements.setEnabled(
        context,
        module,
        enabled,
        await gateway.listUsage(context.tenantId),
      );
    },
    audit: () => reports.getStore()?.audit ?? [],
    usage: () => reports.getStore()?.usage ?? [],
    exportAudit: gateway.exportAudit.bind(gateway),
    listUsage: gateway.listUsage.bind(gateway),
    listDeadLetters: gateway.listDeadLetters.bind(gateway),
  });

  return { transport, reports };
}
