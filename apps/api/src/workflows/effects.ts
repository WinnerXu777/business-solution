import type { Approval, CallEnvelope, Denied } from '@bs/contracts';
import type { ToolGateway } from '@bs/core';
import type { FastifyInstance } from 'fastify';
import { canonicalJson, connectorKey } from '../../../../packages/core/src/workflows/definition.ts';
import type { Effect, EffectResult, Relay } from './worker.ts';

type Sign = (scope: CallEnvelope, id: string) => Promise<Approval | Denied>;
type Prepared = { material: string; previewId: string; approval: Approval };

export function nativeDrafts(
  app: FastifyInstance,
  resolveKey: (scope: CallEnvelope) => Promise<string | undefined> | string | undefined,
): Relay {
  return async ({ scope, phase, input, kind }, signal) => {
    if (kind !== 'llm-draft' || phase !== 'read') return { state: 'denied' };
    const key = await resolveKey(scope);
    if (!key) return { state: 'denied' };
    signal.throwIfAborted();
    const response = await app.inject({
      method: 'POST',
      url: '/llm/v1/chat/completions',
      headers: { authorization: 'Bearer ' + key },
      payload: {
        model: input.model,
        messages: [{ role: 'user', content: input.prompt }],
        max_completion_tokens: 512,
        stream: false,
      },
    });
    if (response.statusCode >= 400)
      return { state: response.statusCode < 500 ? 'denied' : 'failed' };
    const result = response.json<{
      choices?: { finish_reason?: string; message?: { content?: unknown; tool_calls?: unknown } }[];
    }>();
    const choice = result.choices?.[0];
    return choice?.finish_reason === 'stop' &&
      typeof choice.message?.content === 'string' &&
      !choice.message.tool_calls
      ? { state: 'ok', text: choice.message.content }
      : { state: 'failed' };
  };
}

export function createWorkflowEffects(options: {
  gateway: ToolGateway;
  sign: Sign;
  authorize: (effect: Effect) => boolean | Promise<boolean>;
  draft?: Relay;
  governed?: Relay;
  connectors?: ReadonlySet<string>;
}): Relay {
  const collections = (input: Effect['input']) =>
    input.purpose === 'collections' &&
    !Object.hasOwn(input, 'body') &&
    ['email', 'sms', 'voice'].includes(String(input.channel));
  const stamp = (effect: Effect) =>
    canonicalJson([effect.scope.tenantId, effect.scope.actor, effect.kind, effect.input]);
  const failure = (state: string): EffectResult => ({
    state: state === 'failed' || state === 'denied' ? state : 'unknown',
  });

  return async (effect, signal) => {
    const { scope, kind, phase, input, decision, approvalId, binding } = effect;
    if (!(await options.authorize(effect))) return { state: 'denied' };
    signal.throwIfAborted();
    if (kind === 'llm-draft') return options.draft?.(effect, signal) ?? { state: 'denied' };
    if (
      kind === 'http' &&
      !options.connectors?.has(connectorKey(String(input.connector), String(input.operation)))
    )
      return { state: 'denied' };

    if (kind !== 'message' || !collections(input))
      return options.governed?.(effect, signal) ?? { state: 'denied' };

    const channel = input.channel as 'email' | 'sms' | 'voice';
    const tool = ('collections.' + channel + '.send') as
      | 'collections.email.send'
      | 'collections.sms.send'
      | 'collections.voice.send';
    const tenant = scope.tenantId;
    if (phase === 'prepare') {
      const result = await options.gateway.call({
        tool: 'message.preview',
        envelope: scope,
        input: { invoiceId: String(input.sourceId), channel },
      });
      if (result.state !== 'ok') return failure(result.state);
      const preview = result.output;
      if (
        preview.tenantId !== tenant ||
        preview.sourceId !== input.sourceId ||
        preview.customerId !== input.recipientId ||
        preview.channel !== channel
      )
        return { state: 'denied' };
      signal.throwIfAborted();
      const pending = await options.gateway.call({
        tool,
        envelope: scope,
        input: { previewId: preview.id, approvalId: null },
      });
      if (pending.state !== 'pending_approval') return failure(pending.state);
      const approval = pending.approval;
      if (
        approval.tenantId !== tenant ||
        approval.subjectId !== preview.id ||
        approval.tool !== tool ||
        approval.requestedBy !== scope.actor.id ||
        approval.state !== 'pending'
      )
        return { state: 'denied' };
      const expiresAt = Date.parse(approval.expiresAt);
      if (!Number.isSafeInteger(expiresAt)) return { state: 'denied' };
      return {
        state: 'pending_approval',
        approval: { id: approval.id, approverId: approval.approverId, expiresAt },
        binding: { material: stamp(effect), previewId: preview.id, approval } satisfies Prepared,
        review: {
          channel,
          recipient: preview.recipient,
          subject: preview.subject,
          body: preview.body,
          sourceVersion: preview.sourceVersion,
        },
      };
    }
    // The private worker carries this binding across a checkpoint. The gateway still
    // validates the actual grant, exact message, and current source and consent.
    const grant = binding as Prepared | undefined;
    if (!grant || grant.material !== stamp(effect) || grant.approval.id !== approvalId)
      return { state: 'denied' };
    if (phase === 'sign') {
      if (
        !decision ||
        decision.tenantId !== tenant ||
        decision.actor.kind !== 'person' ||
        decision.actor.id !== grant.approval.approverId ||
        decision.actor.id === scope.actor.id
      )
        return { state: 'denied' };
      const signed = await options.sign(decision, grant.approval.id);
      return {
        state: signed.state === 'approved' && signed.id === grant.approval.id ? 'ok' : 'denied',
      };
    }
    if (phase !== 'execute' || !approvalId) return { state: 'denied' };
    const outcome = await options.gateway.call({
      tool,
      envelope: scope,
      input: { previewId: grant.previewId, approvalId },
    });
    return outcome.state === 'ok' ? { state: 'ok' } : failure(outcome.state);
  };
}
