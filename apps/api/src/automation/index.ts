import { createHash, randomUUID } from 'node:crypto';
import {
  loadDemoFixtures,
  type Actor,
  type Approval,
  type CallEnvelope,
  type Denied,
  type MessageChannel,
  type MessagePreview,
  type RunChatInput,
  type RunWorkflowTemplateOutput,
  type ToolCall,
  type ToolResult,
  type ToolResultMap,
} from '@bs/contracts';
import type { ToolGateway } from '@bs/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  createFixtureRouter,
  createRouteAudit,
} from '../../../../packages/adapters/src/llm/index.ts';
import { createWorker, type ApprovalMaterial } from './worker.ts';
import { registerRuntimeRoutes, type RuntimeCapability } from './runtime-routes.ts';

type Identity = { tenantId: string; actor: Actor };
type Options = {
  gateway: ToolGateway;
  identity: (request: FastifyRequest, role: 'requester' | 'approver') => Identity | undefined;
  sign: (
    envelope: CallEnvelope,
    approvalId: string,
  ) => Approval | Denied | Promise<Approval | Denied>;
  python?: string;
  authorizeRuntime?: (
    scope: CallEnvelope,
    capability: RuntimeCapability,
  ) => boolean | Promise<boolean>;
  pendingApprovals?: (tenantId: string) => Promise<Approval[]>;
  approvalPreviews?: (
    tenantId: string,
    approvalId: string,
  ) => Promise<MessagePreview[] | undefined>;
};

type InboxItem = ApprovalMaterial & {
  execute: (decision: CallEnvelope) => Promise<ToolResult>;
  onSettled?: (result: ToolResult) => void;
  outcome?: Promise<ToolResult>;
  result?: ToolResult;
};
type Run = {
  id: string;
  mode: 'preview' | 'run';
  status:
    | RunWorkflowTemplateOutput['status']
    | 'pending_approval'
    | 'denied'
    | 'failed'
    | 'unknown';
  previews: MessagePreview[];
  receipts: RunWorkflowTemplateOutput['receipts'];
  approvalId?: string;
};

const id = { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' };
const route = { type: 'string', enum: ['native', 'byo'] };
const channel = { type: 'string', enum: ['email', 'voice', 'sms'] };
const text = { type: 'string', minLength: 1, maxLength: 500 };
const mode = { type: 'string', enum: ['preview', 'run'] };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unauthorized: Denied = {
  state: 'denied',
  code: 'forbidden',
  message: 'Fixture identity required.',
};
const missing: Denied = { state: 'denied', code: 'not_found', message: 'Record unavailable.' };

export async function registerAutomation(app: FastifyInstance, options: Options) {
  const fixtures = loadDemoFixtures();
  const router = createFixtureRouter();
  const audit = createRouteAudit();
  const gateway: ToolGateway = {
    async call<Request extends ToolCall>(
      request: Request,
    ): Promise<ToolResultMap[Request['tool']]> {
      const result = await options.gateway.call(request);
      if (
        request.tool === 'llm.complete' &&
        result.state === 'ok' &&
        result.output &&
        'route' in result.output
      ) {
        audit.record(request.envelope, result.output.route);
      }
      return result;
    },
  };
  const authorize =
    options.authorizeRuntime ??
    ((_scope: CallEnvelope, capability: RuntimeCapability) =>
      capability === 'bot' || capability === 'workflow');
  const worker = createWorker(gateway, options.python, (call) =>
    authorize(call.envelope, call.envelope.source === 'workflow' ? 'workflow' : 'bot'),
  );
  app.addHook('onClose', async () => worker.close());

  const inbox = new Map<string, InboxItem>();
  const histories = new Map<string, Map<string, Run>>();
  const chats = new Map<
    string,
    { fingerprint: string; reply: ReturnType<typeof worker.invoke<'chat'>> }
  >();

  function envelope(identity: Identity, request: FastifyRequest, source: CallEnvelope['source']) {
    const traceId = randomUUID();
    return {
      ...identity,
      version: 'v1' as const,
      source,
      traceId,
      correlationId: traceId,
      idempotencyKey: digest([source, request.headers['idempotency-key'] ?? traceId]),
    };
  }

  function get<P>(
    path: string,
    run: (params: P, scope: CallEnvelope) => unknown,
    approval = false,
  ) {
    app.get<{ Params: P }>(path, async (request, reply) => {
      const identity = options.identity(request, approval ? 'approver' : 'requester');
      if (!identity) return reply.code(403).send(unauthorized);
      return run(request.params as P, envelope(identity, request, 'portal'));
    });
  }

  function post<B>(
    path: string,
    properties: Record<keyof B, object>,
    source: CallEnvelope['source'],
    run: (body: B, scope: CallEnvelope) => unknown,
    approval = false,
  ) {
    app.post<{ Body: B }>(
      path,
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties,
            required: Object.keys(properties),
          },
        },
      },
      async (request, reply) => {
        const identity = options.identity(request, approval ? 'approver' : 'requester');
        if (!identity) return reply.code(403).send(unauthorized);
        return run(request.body as B, envelope(identity, request, source));
      },
    );
  }

  function addApproval(
    material: ApprovalMaterial,
    execute: InboxItem['execute'],
    onSettled?: InboxItem['onSettled'],
  ) {
    if (material.approval.state === 'pending' && !inbox.has(material.approval.id)) {
      inbox.set(material.approval.id, { ...material, execute, onSettled });
    }
  }

  function canApprove(scope: CallEnvelope, approval: Approval) {
    return (
      scope.tenantId === approval.tenantId &&
      scope.actor.id === approval.approverId &&
      scope.actor.id !== approval.requestedBy
    );
  }

  async function signAndExecute(decision: CallEnvelope, item: InboxItem) {
    if (item.approval.tool !== 'purchase.order.approve') {
      const signed = await options.sign(decision, item.approval.id);
      if ('code' in signed) return signed;
    }
    return item.execute(decision);
  }

  async function chat(scope: CallEnvelope, input: RunChatInput) {
    const threadId = digest([scope.tenantId, scope.actor, scope.source, scope.idempotencyKey]);
    const fingerprint = digest(input);
    let turn = chats.get(threadId);
    if (turn && turn.fingerprint !== fingerprint) {
      return {
        state: 'denied',
        code: 'idempotency_conflict',
        message: 'This request key is already bound to a different turn.',
      } satisfies Denied;
    }
    if (!turn) {
      const proposal = router.propose(input);
      turn = {
        fingerprint,
        reply: worker.invoke({ kind: 'chat', threadId, envelope: scope, chat: input, proposal }),
      };
      chats.set(threadId, turn);
    }
    const answer = await turn.reply;
    if (answer.pending) {
      const approvalId = answer.pending.approval.id;
      addApproval(
        answer.pending,
        async (decision) =>
          (
            await worker.invoke({
              kind: 'resume',
              threadId,
              approvalId,
              envelope: { ...decision, idempotencyKey: approvalId + ':approve' },
            })
          ).result,
      );
    }
    return answer.result;
  }

  function chatInput(
    sessionId: string,
    prompt: string,
    selected: 'native' | 'byo',
    fixture?: { id: string; orderId: string },
  ): RunChatInput {
    return {
      sessionId,
      turns: [{ role: 'user', content: prompt }],
      orderId: fixture?.orderId ?? null,
      audioFixtureId: fixture?.id ?? null,
      route: fixtures.llmRoutes.find((binding) => binding.kind === selected)!,
    };
  }

  const runtime = registerRuntimeRoutes(app, {
    worker,
    authorize,
    scope(request, source, approver) {
      const identity = options.identity(request, approver ? 'approver' : 'requester');
      return identity && envelope(identity, request, source);
    },
    async sign(scope, approval) {
      if (approval.tool === 'purchase.order.approve') return;
      const result = await options.sign(scope, approval.id);
      if ('code' in result) return result;
    },
    addApproval,
    pendingApprovals: options.pendingApprovals,
    chatInput,
    propose: router.propose,
  });

  get<{ orderId: string }>('/orders/:orderId', ({ orderId }, scope) => {
    if (!new RegExp(id.pattern).test(orderId)) return missing;
    return gateway.call({ envelope: scope, tool: 'order.read', input: { orderId } });
  });
  post<{ sessionId: string; prompt: string; route: 'native' | 'byo' }>(
    '/chat',
    { sessionId: id, prompt: text, route },
    'chat',
    (body, scope) => chat(scope, chatInput(body.sessionId, body.prompt, body.route)),
  );
  post<{ sessionId: string; fixtureId: string; route: 'native' | 'byo' }>(
    '/voice',
    { sessionId: id, fixtureId: id, route },
    'browser_voice',
    async (body, scope) => {
      const fixture = fixtures.audio.find(({ id }) => id === body.fixtureId);
      if (!fixture) return { transcript: null, result: missing };
      return {
        transcript: fixture.transcript,
        result: await chat(
          scope,
          chatInput(body.sessionId, fixture.transcript, body.route, fixture),
        ),
      };
    },
  );

  post<{ requestId: string }>(
    '/purchase-orders/draft',
    { requestId: id },
    'portal',
    async (input, scope) => {
      const result = await gateway.call({ envelope: scope, tool: 'purchase.order.draft', input });
      if (result.state === 'ok') {
        const { approval, draft } = result.output;
        addApproval(result.output, (decision) =>
          gateway.call({
            envelope: { ...decision, idempotencyKey: approval.id + ':approve' },
            tool: 'purchase.order.approve',
            input: { draftId: draft.id, approvalId: approval.id },
          }),
        );
      }
      return result;
    },
  );

  post<{ invoiceId: string; channel: MessageChannel }>(
    '/collections/preview',
    { invoiceId: id, channel },
    'portal',
    ({ invoiceId, channel }, scope) =>
      channel === 'email'
        ? gateway.call({ envelope: scope, tool: 'collections.email.draft', input: { invoiceId } })
        : gateway.call({ envelope: scope, tool: 'message.preview', input: { invoiceId, channel } }),
  );

  post<{ invoiceId: string; channel: MessageChannel }>(
    '/collections/request',
    { invoiceId: id, channel },
    'portal',
    async (input, scope) => {
      const preview = await gateway.call({
        envelope: { ...scope, idempotencyKey: scope.idempotencyKey + ':preview' },
        tool: 'message.preview',
        input,
      });
      if (preview.state !== 'ok') return preview;
      const previewId = preview.output.id;
      const tool = `collections.${input.channel}.send` as const;
      const result = await gateway.call({
        envelope: scope,
        tool,
        input: { previewId, approvalId: null },
      });
      if (result.state === 'pending_approval') {
        const approvalId = result.approval.id;
        addApproval({ approval: result.approval, previews: [preview.output] }, () =>
          gateway.call({
            envelope: { ...scope, idempotencyKey: approvalId + ':execute' },
            tool,
            input: { previewId, approvalId },
          }),
        );
      }
      return result;
    },
  );

  get(
    '/approvals',
    (_params, scope) =>
      Promise.all(
        [...inbox.values()]
          .filter((item) => canApprove(scope, item.approval))
          .map(async ({ approval, draft, previews, result }) => ({
            approval,
            draft,
            result,
            previews: previews ?? (await options.approvalPreviews?.(scope.tenantId, approval.id)),
          })),
      ),
    true,
  );
  post<{ approvalId: string }>(
    '/approvals/approve',
    { approvalId: id },
    'portal',
    ({ approvalId }, scope) => {
      const item = inbox.get(approvalId);
      if (!item || !canApprove(scope, item.approval)) return missing;
      return (item.outcome ??= signAndExecute(scope, item)
        .catch(
          (): ToolResult => ({
            state: 'unknown',
            actionId: approvalId,
            message: 'Approval outcome needs reconciliation.',
          }),
        )
        .then((result) => {
          item.result = result;
          item.onSettled?.(result);
          return result;
        }));
    },
    true,
  );

  const historyKey = (scope: CallEnvelope) => JSON.stringify([scope.tenantId, scope.actor]);
  get('/workflows/history', (_params, scope) =>
    [...(histories.get(historyKey(scope))?.values() ?? [])].reverse(),
  );
  post<{ mode: 'preview' | 'run' }>(
    '/workflows/win-back-v1',
    { mode },
    'workflow',
    async ({ mode }, scope) => {
      const key = historyKey(scope);
      const history = histories.get(key) ?? new Map<string, Run>();
      histories.set(key, history);
      // The base fixture has immutable source records. Obtain a review copy through
      // the gateway, where preview is guaranteed to bypass delivery.
      let previews: MessagePreview[] = [];
      if (mode === 'run') {
        const review = (
          await worker.invoke({
            kind: 'workflow',
            envelope: { ...scope, idempotencyKey: scope.idempotencyKey + ':review' },
            mode: 'preview',
            approvalId: null,
          })
        ).result;
        if (review.state !== 'ok') return review;
        previews = (review.output as RunWorkflowTemplateOutput).previews;
      }
      const runScope = {
        ...scope,
        idempotencyKey: digest(['legacy-win-back', scope.idempotencyKey]),
      };
      const execution =
        mode === 'run'
          ? await worker.invoke({
              kind: 'workflow-start',
              envelope: runScope,
              definitionId: 'win-back-v1',
              version: 1,
              input: { trigger: { kind: 'manual' } },
              now: Date.now(),
            })
          : undefined;
      const result: ToolResult = execution
        ? execution.approval
          ? { state: 'pending_approval', approval: execution.approval }
          : execution.result!
        : (await worker.invoke({ kind: 'workflow', envelope: scope, mode, approvalId: null }))
            .result;
      if (result.state === 'ok') {
        const output = result.output as RunWorkflowTemplateOutput;
        history.set(output.runId, {
          id: output.runId,
          mode,
          status: output.status,
          previews: output.previews,
          receipts: output.receipts,
        });
      }
      if (result.state === 'pending_approval' && !inbox.has(result.approval.id)) {
        const approvalId = result.approval.id;
        const run: Run = {
          id: approvalId,
          mode,
          status: result.state,
          previews,
          receipts: [],
          approvalId,
        };
        history.set(approvalId, run);
        runtime.follow(execution!, runScope, previews, (settlement) => {
          if (settlement.state === 'ok') {
            const output = settlement.output as RunWorkflowTemplateOutput;
            history.set(approvalId, {
              ...run,
              id: output.runId,
              status: output.status,
              receipts: output.receipts,
            });
          } else if (settlement.state !== 'pending_approval') {
            history.set(approvalId, { ...run, status: settlement.state });
          }
        });
      }
      return result;
    },
  );
  get('/llm/audit', (_params, scope) =>
    audit
      .entries()
      .filter((entry) => entry.tenantId === scope.tenantId && entry.actorId === scope.actor.id),
  );
}
