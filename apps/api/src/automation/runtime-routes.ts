import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Approval, CallEnvelope, RunChatInput, ToolResult } from '@bs/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ToolProposal } from '../../../../packages/adapters/src/llm/index.ts';
import type { OnSettledTurn } from '../channels/settled.ts';
import {
  WorkerRejection,
  type ApprovalMaterial,
  type BotEvent,
  type BotView,
  type Worker,
  type WorkflowInput,
  type WorkflowView,
} from './worker.ts';

export type RuntimeCapability = 'bot' | 'workflow' | 'publish' | 'trigger';

type Context = {
  worker: Worker;
  scope: (
    request: FastifyRequest,
    source: CallEnvelope['source'],
    approver?: boolean,
  ) => CallEnvelope | undefined;
  authorize: (scope: CallEnvelope, capability: RuntimeCapability) => boolean | Promise<boolean>;
  sign: (scope: CallEnvelope, approval: Approval) => Promise<ToolResult | undefined>;
  addApproval: (
    material: ApprovalMaterial,
    execute: (decision: CallEnvelope) => Promise<ToolResult>,
    settled?: (result: ToolResult) => void,
  ) => void;
  chatInput: (sessionId: string, prompt: string, route: 'native' | 'byo') => RunChatInput;
  propose: (input: RunChatInput) => ToolProposal | null;
  onSettledTurn?: OnSettledTurn;
};

type BotEntry = {
  scope: CallEnvelope;
  fingerprint: string;
  view: BotView;
  events: BotEvent[];
  changed: AbortController;
  cancelRequested: boolean;
  needsRecovery?: boolean;
  task: Promise<void>;
  resumingApproval?: Approval;
  resumeDenial?: ToolResult;
};

const id = { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' };
const version = { type: 'integer', minimum: 1, maximum: 2_147_483_647 };
const params = { type: 'object', properties: { runId: id }, required: ['runId'] };
const botBody = {
  botId: id,
  version,
  sessionId: id,
  prompt: { type: 'string', minLength: 1, maxLength: 500 },
  route: { enum: ['native', 'byo'] },
};
const targetBody = {
  definitionId: id,
  version,
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['trigger'],
    properties: {
      trigger: {
        type: 'object',
        additionalProperties: false,
        required: ['kind'],
        properties: { kind: { enum: ['manual', 'event', 'schedule'] }, name: id, key: id },
      },
      values: {
        type: 'object',
        maxProperties: 32,
        additionalProperties: {},
      },
    },
  },
};

const statusCodes = {
  not_found: 404,
  forbidden: 403,
  invalid_input: 400,
  conflict: 409,
  quota_exceeded: 429,
  unavailable: 503,
} as const;

function reject(reply: FastifyReply, code: keyof typeof statusCodes) {
  return reply.code(statusCodes[code]).send({ code });
}

function body(properties: Record<string, object>) {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
  };
}

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function owns(entry: BotEntry | undefined, scope: CallEnvelope): entry is BotEntry {
  return (
    entry !== undefined &&
    entry.scope.tenantId === scope.tenantId &&
    entry.scope.actor.id === scope.actor.id &&
    entry.scope.actor.kind === scope.actor.kind
  );
}

function matches(approval: Approval | undefined, scope: CallEnvelope, approvalId: string) {
  return (
    approval?.id === approvalId &&
    approval.tenantId === scope.tenantId &&
    approval.approverId === scope.actor.id &&
    approval.requestedBy !== scope.actor.id &&
    scope.actor.kind === 'person'
  );
}

function wake(entry: BotEntry) {
  entry.changed.abort();
  entry.changed = new AbortController();
}

async function* eventStream(entry: BotEntry, after: number) {
  for (;;) {
    const events = entry.events.slice(after);
    for (const event of events) {
      after = event.id;
      yield 'id: ' +
        event.id +
        '\nevent: ' +
        event.kind +
        '\ndata: ' +
        JSON.stringify(event) +
        '\n\n';
    }
    if (after < entry.events.length) continue;
    if (entry.view.status !== 'queued' && entry.view.status !== 'running') return;
    const signal = AbortSignal.any([entry.changed.signal, AbortSignal.timeout(15_000)]);
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    if (
      after === entry.events.length &&
      (entry.view.status === 'running' || entry.view.status === 'queued')
    ) {
      yield ': keepalive\n\n';
    }
  }
}

export function registerRuntimeRoutes(app: FastifyInstance, ctx: Context) {
  const bots = new Map<string, BotEntry>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;
  app.addHook('onClose', () => {
    closed = true;
    for (const timer of timers.values()) clearTimeout(timer);
  });

  function scoped(
    capability: RuntimeCapability,
    run: (request: FastifyRequest, reply: FastifyReply, scope: CallEnvelope) => unknown,
    approver = false,
  ) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const source = capability === 'bot' ? 'chat' : 'workflow';
        const scope = ctx.scope(request, source, approver);
        if (!scope || !(await ctx.authorize(scope, capability))) return reject(reply, 'forbidden');
        return await run(request, reply, scope);
      } catch (error) {
        if (error instanceof WorkerRejection) return reject(reply, error.code);
        request.log.error({ err: error }, 'Fixture runtime command failed');
        return reject(reply, 'unavailable');
      }
    };
  }

  function event(entry: BotEntry, update: BotEvent) {
    if (update.id <= entry.events.length) return;
    if (update.kind === 'started') entry.view = { ...entry.view, status: 'running' };
    entry.events.push(update);
    wake(entry);
  }

  function track(entry: BotEntry, task: Promise<BotView>) {
    const previousStatus = entry.view.status;
    entry.task = task
      .then(async (view) => {
        entry.view = view;
        if (
          view.sessionId &&
          view.status !== previousStatus &&
          view.status !== 'pending_approval' &&
          ctx.onSettledTurn
        ) {
          try {
            await ctx.onSettledTurn({
              tenantId: entry.scope.tenantId,
              conversationId: view.sessionId,
              turnId: view.id,
              channel: 'web',
              outcome: view.status,
              audioSeconds: null,
            });
          } catch (error) {
            app.log.error({ err: error, runId: view.id }, 'Bot turn outcome callback failed');
          }
        }
      })
      .catch(() => {
        bots.delete(entry.view.id);
        entry.view = {
          ...entry.view,
          status: 'unknown',
          pending: null,
          result: {
            state: 'unknown',
            actionId: entry.view.id,
            message: 'Reconcile the run before dispatching again.',
          },
        };
      })
      .finally(() => wake(entry));
    return entry.task;
  }

  const controls = (entry: BotEntry) => ({
    onEvent: (update: BotEvent) => event(entry, update),
    cancelled: () => entry.cancelRequested,
  });

  async function lookup(runId: string, scope: CallEnvelope, approvalId?: string) {
    const local = bots.get(runId);
    if (local) return local;
    try {
      const snapshot = await ctx.worker.invoke({
        kind: 'bot-inspect',
        envelope: scope,
        runId,
        approvalId,
      });
      const concurrent = bots.get(runId);
      if (concurrent) return concurrent;
      const entry: BotEntry = {
        scope: snapshot.envelope,
        fingerprint: snapshot.fingerprint ?? '',
        view: snapshot.view,
        events: snapshot.events,
        changed: new AbortController(),
        cancelRequested: false,
        needsRecovery: snapshot.view.status === 'running',
        task: Promise.resolve(),
      };
      bots.set(runId, entry);
      return entry;
    } catch (error) {
      if (error instanceof WorkerRejection && error.code === 'not_found') return;
      throw error;
    }
  }

  function recover(entry: BotEntry) {
    if (!entry.needsRecovery) return;
    entry.needsRecovery = false;
    void track(
      entry,
      ctx.worker
        .invoke(
          { kind: 'bot-recover', runId: entry.view.id, envelope: entry.scope },
          controls(entry),
        )
        .then(({ view, events }) => {
          entry.events = events;
          return view;
        }),
    );
  }

  app.get(
    '/bots',
    scoped('bot', () => ctx.worker.invoke({ kind: 'bot-list' })),
  );
  app.get(
    '/bots/sessions/:sessionId/turns',
    {
      schema: {
        params: { type: 'object', properties: { sessionId: id }, required: ['sessionId'] },
      },
    },
    scoped('bot', (request, _reply, envelope) =>
      ctx.worker.invoke({
        kind: 'bot-session',
        envelope,
        sessionId: (request.params as { sessionId: string }).sessionId,
      }),
    ),
  );
  app.post(
    '/bots/runs',
    { schema: { body: body(botBody) } },
    scoped('bot', async (request, reply, scope) => {
      const input = request.body as {
        botId: string;
        version: number;
        sessionId: string;
        prompt: string;
        route: 'native' | 'byo';
      };
      const runId = hash([scope.tenantId, scope.actor, 'bot-runtime', scope.idempotencyKey]);
      const fingerprint = hash([
        input.botId,
        input.version,
        input.sessionId,
        input.prompt,
        input.route,
      ]);
      const prior = await lookup(runId, scope);
      if (prior) {
        if (!owns(prior, scope)) return reject(reply, 'not_found');
        if (prior.fingerprint !== fingerprint) return reject(reply, 'conflict');
        recover(prior);
        return reply.code(202).send(prior.view);
      }
      const definitions = await ctx.worker.invoke({ kind: 'bot-list' });
      if (!definitions.some(({ id, version }) => id === input.botId && version === input.version)) {
        return reject(reply, 'not_found');
      }
      const concurrent = bots.get(runId);
      if (concurrent) {
        return concurrent.fingerprint === fingerprint
          ? reply.code(202).send(concurrent.view)
          : reject(reply, 'conflict');
      }
      const chat = ctx.chatInput(input.sessionId, input.prompt, input.route);
      const entry: BotEntry = {
        scope,
        fingerprint,
        view: {
          id: runId,
          botId: input.botId,
          version: input.version,
          status: 'queued',
          result: null,
          pending: null,
          sessionId: input.sessionId,
        },
        events: [],
        changed: new AbortController(),
        cancelRequested: false,
        task: Promise.resolve(),
      };
      bots.set(runId, entry);
      void track(
        entry,
        ctx.worker.invoke(
          {
            kind: 'bot-start',
            runId,
            botId: input.botId,
            version: input.version,
            fingerprint,
            envelope: scope,
            chat,
            proposal: ctx.propose(chat),
          },
          controls(entry),
        ),
      );
      return reply.code(202).send(entry.view);
    }),
  );

  app.get(
    '/bots/runs/:runId',
    { schema: { params } },
    scoped('bot', async (request, reply, scope) => {
      const entry = await lookup((request.params as { runId: string }).runId, scope);
      if (!owns(entry, scope)) return reject(reply, 'not_found');
      recover(entry);
      return entry.view;
    }),
  );

  app.get(
    '/bots/runs/:runId/events',
    { schema: { params } },
    scoped('bot', async (request, reply, scope) => {
      const entry = await lookup((request.params as { runId: string }).runId, scope);
      if (!owns(entry, scope)) return reject(reply, 'not_found');
      const cursor = request.headers['last-event-id'] ?? '0';
      if (
        typeof cursor !== 'string' ||
        !/^\d{1,10}$/.test(cursor) ||
        Number(cursor) > entry.events.length
      ) {
        return reject(reply, 'invalid_input');
      }
      recover(entry);
      return reply
        .header('cache-control', 'no-store')
        .header('x-accel-buffering', 'no')
        .type('text/event-stream')
        .send(Readable.from(eventStream(entry, Number(cursor))));
    }),
  );

  app.post(
    '/bots/runs/:runId/resume',
    { schema: { params, body: body({ approvalId: id }) } },
    scoped(
      'bot',
      async (request, reply, scope) => {
        const { runId } = request.params as { runId: string };
        const { approvalId } = request.body as { approvalId: string };
        const entry = await lookup(runId, scope, approvalId);
        if (!entry) return reject(reply, 'not_found');
        if (matches(entry.resumingApproval, scope, approvalId)) {
          await entry.task;
          if (entry.resumeDenial) return reply.code(403).send(entry.resumeDenial);
          return entry.view;
        }
        const approval = entry.view.pending?.approval;
        if (!approval || !matches(approval, scope, approvalId) || entry.cancelRequested)
          return reject(reply, 'not_found');
        const waiting = entry.view;
        entry.resumeDenial = undefined;
        entry.resumingApproval = approval;
        entry.view = { ...entry.view, status: 'running', pending: null };
        wake(entry);
        await track(
          entry,
          (async () => {
            const rejected = await ctx.sign(scope, approval);
            if (rejected) {
              entry.resumeDenial = rejected;
              return waiting;
            }
            if (entry.cancelRequested) {
              return ctx.worker.invoke(
                { kind: 'bot-cancel', runId, envelope: entry.scope },
                controls(entry),
              );
            }
            return ctx.worker.invoke(
              { kind: 'bot-resume', runId, envelope: scope, approvalId },
              controls(entry),
            );
          })(),
        );
        if (entry.resumeDenial) {
          entry.resumingApproval = undefined;
          return reply.code(403).send(entry.resumeDenial);
        }
        return entry.view;
      },
      true,
    ),
  );

  app.post(
    '/bots/runs/:runId/cancel',
    { schema: { params } },
    scoped('bot', async (request, reply, scope) => {
      const { runId } = request.params as { runId: string };
      const entry = await lookup(runId, scope);
      if (!owns(entry, scope)) return reject(reply, 'not_found');
      entry.cancelRequested = true;
      await entry.task;
      if (entry.view.status === 'pending_approval' || entry.view.status === 'running') {
        await track(
          entry,
          ctx.worker.invoke({ kind: 'bot-cancel', runId, envelope: scope }, controls(entry)),
        );
      }
      return entry.view;
    }),
  );

  function follow(
    view: WorkflowView,
    envelope: CallEnvelope,
    previews?: ApprovalMaterial['previews'],
    settled?: (result: ToolResult) => void,
  ) {
    if (view.dueAt !== null && !closed) {
      const runId = view.id;
      clearTimeout(timers.get(runId));
      const timer = setTimeout(
        async () => {
          timers.delete(runId);
          try {
            // The pinned requester is rechecked at dispatch by the gateway relay.
            follow(
              await ctx.worker.invoke({ kind: 'workflow-tick', envelope, runId, now: Date.now() }),
              envelope,
            );
          } catch (error) {
            app.log.error({ err: error, runId }, 'Fixture workflow tick failed');
          }
        },
        Math.max(0, view.dueAt - Date.now()),
      );
      timer.unref();
      timers.set(runId, timer);
    }
    if (view.approval) {
      const approval = view.approval;
      ctx.addApproval(
        { approval, previews },
        async (decision) => {
          const next = follow(
            await ctx.worker.invoke({
              kind: 'workflow-approve',
              envelope: decision,
              approvalId: approval.id,
              runId: view.id,
              now: Date.now(),
            }),
            envelope,
          );
          if (next.approval) return { state: 'pending_approval', approval: next.approval };
          return (
            next.result ?? {
              state: 'failed',
              code: 'unavailable',
              message: 'Workflow is still running.',
              retryable: false,
            }
          );
        },
        settled,
      );
    }
    return view;
  }

  app.get(
    '/workflows/definitions',
    scoped('workflow', (_request, _reply, envelope) =>
      ctx.worker.invoke({ kind: 'workflow-definitions', envelope }),
    ),
  );
  app.post(
    '/workflows/definitions',
    {
      schema: {
        body: body({
          id,
          version,
          nodes: { type: 'array', minItems: 2, maxItems: 40, items: { type: 'object' } },
        }),
      },
    },
    scoped('publish', async (request, reply, envelope) => {
      const definition = request.body as { id: string; version: number; nodes: unknown[] };
      return reply
        .code(201)
        .send(await ctx.worker.invoke({ kind: 'workflow-publish', envelope, definition }));
    }),
  );

  app.post(
    '/workflows/preview',
    { schema: { body: body(targetBody) } },
    scoped('workflow', (request, _reply, envelope) => {
      const target = request.body as {
        definitionId: string;
        version: number;
        input: WorkflowInput;
      };
      return ctx.worker.invoke({ kind: 'workflow-preview', envelope, ...target });
    }),
  );

  app.post(
    '/workflows/runs',
    { schema: { body: body(targetBody) } },
    scoped('workflow', async (request, reply, envelope) => {
      const target = request.body as {
        definitionId: string;
        version: number;
        input: WorkflowInput;
      };
      if (target.input.trigger.kind !== 'manual' && !(await ctx.authorize(envelope, 'trigger'))) {
        return reject(reply, 'forbidden');
      }
      const view = await ctx.worker.invoke({
        kind: 'workflow-start',
        envelope,
        ...target,
        now: Date.now(),
      });
      return reply.code(202).send(follow(view, envelope));
    }),
  );

  app.get(
    '/workflows/runs',
    scoped('workflow', (_request, _reply, envelope) =>
      ctx.worker.invoke({ kind: 'workflow-runs', envelope, deadOnly: false }),
    ),
  );
  app.get(
    '/workflows/dead-letters',
    scoped('workflow', (_request, _reply, envelope) =>
      ctx.worker.invoke({ kind: 'workflow-runs', envelope, deadOnly: true }),
    ),
  );
  app.get(
    '/workflows/runs/:runId/history',
    { schema: { params } },
    scoped('workflow', (request, _reply, envelope) =>
      ctx.worker.invoke({
        kind: 'workflow-history',
        envelope,
        ...(request.params as { runId: string }),
      }),
    ),
  );
  app.post(
    '/workflows/runs/:runId/replay',
    { schema: { params } },
    scoped('workflow', async (request, reply, envelope) => {
      const view = await ctx.worker.invoke({
        kind: 'workflow-replay',
        envelope,
        ...(request.params as { runId: string }),
        now: Date.now(),
      });
      return reply.code(202).send(follow(view, envelope));
    }),
  );

  return { follow };
}
