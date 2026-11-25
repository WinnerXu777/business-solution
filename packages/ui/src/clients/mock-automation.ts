import type { DemoFixtures, MessagePreview } from '@bs/contracts';
import { PlatformError, canOperate, canReview } from '../platform-client.ts';
import type { PlatformIdentity } from '../platform-client.ts';
import type {
  AutomationClient,
  BotEvent,
  BotRun,
  BotStart,
  WorkflowHistory,
} from './automation.ts';
import { mockApproval, requireFixture, requireRole } from './mock-records.ts';
import { resolveWorkflow, validateWorkflow, winBackWorkflow } from './workflow-definition.ts';
import type { WorkflowDefinition, WorkflowStep, WorkflowTarget } from './workflow-definition.ts';

type BotEntry = {
  view: BotRun;
  events: BotEvent[];
  requester: string;
  fingerprint: string;
  update: () => void;
};
type WorkflowEntry = {
  view: WorkflowHistory;
  requester: string;
  fingerprint: string;
  nextStep: number;
  steps: WorkflowStep[];
};

export class MockAutomationState {
  readonly bots = new Map<string, BotEntry>();
  readonly botKeys = new Map<string, BotEntry>();
  readonly definitions = new Map<string, WorkflowDefinition>();
  readonly workflows = new Map<string, WorkflowEntry>();
  botSequence = 0;
  runSequence = 0;
}

export function createMockAutomation(
  me: PlatformIdentity,
  fixtures: DemoFixtures,
  now: string,
  state: MockAutomationState,
  enabled: (module: 'ai' | 'workflows') => boolean,
  updateBot: (input: BotStart, view: BotRun) => void,
  published: () => void,
): AutomationClient {
  const tenant = me.tenant.id;
  const prefix = tenant + ':';
  const owner = me.actor.id;
  const bots = [
    {
      id: 'fixture-chat',
      version: 1,
      maxActions: 4,
      maxSeconds: 30,
      allowedTools: ['order.read', 'purchase.order.draft'],
    },
  ];
  const messages: MessagePreview[] = fixtures.customers
    .filter(
      (item) =>
        item.tenantId === tenant &&
        ['cust-008', 'cust-009'].includes(item.id) &&
        item.outreachAllowed,
    )
    .map((item) => ({
      id: 'win-back-' + item.id,
      tenantId: tenant,
      channel: 'email',
      customerId: item.id,
      customerVersion: item.version,
      recipient: item.email,
      sourceId: 'win-back-v1',
      sourceVersion: 1,
      subject: 'Your Rivetquay supply account',
      body: 'Hello ' + item.name + ', would you like an updated quote for your next supply order?',
    }));
  function moduleAccess(module: 'ai' | 'workflows') {
    if (!enabled(module)) throw new PlatformError('module_disabled');
  }
  function bot(id: string, owned = true) {
    const entry = requireFixture(state.bots.get(prefix + id));
    if (owned && entry.requester !== owner) throw new PlatformError('not_found');
    return entry;
  }
  function event(entry: BotEntry, kind: string, details: Partial<BotEvent> = {}) {
    entry.events.push({ id: entry.events.length + 1, kind, runId: entry.view.id, ...details });
  }
  function finishBot(entry: BotEntry) {
    entry.view.status = 'completed';
    entry.view.pending = null;
    entry.view.result = {
      state: 'ok',
      output: {
        sessionId: 'fixture-session',
        reply: 'Rivetquay fixture run completed.',
        order: null,
        handoff: false,
      },
    };
    event(entry, 'reply_delta', { delta: 'Rivetquay fixture ' });
    event(entry, 'reply_delta', { delta: 'run completed.' });
    event(entry, 'settled', { status: 'completed' });
    entry.update();
  }
  function transition(entry: WorkflowEntry, kind: string) {
    const { history, nodeId, status } = entry.view;
    history.push({
      id: history.length + 1,
      at: Date.parse(now) + history.length * 1000,
      kind,
      nodeId,
      status,
    });
  }
  function advanceWorkflow(entry: WorkflowEntry) {
    const { view } = entry;
    view.status = 'running';
    while (entry.nextStep < entry.steps.length) {
      const step = entry.steps[entry.nextStep++];
      view.nodeId = step.nodeId;
      if (step.kind === 'approval') {
        view.approval = mockApproval(
          { ...me, actor: { ...me.actor, id: entry.requester } },
          'approval-workflow-run-' + ++state.runSequence,
          'workflow.template.run',
          view.definitionId,
          now,
        );
        view.status = 'pending_approval';
        transition(entry, 'approval_required');
        return;
      }
      transition(entry, step.kind);
      if (step.tool === 'order.read') {
        const input = step.input as { orderId: string };
        const order = fixtures.orders.find(
          (item) => item.tenantId === tenant && item.id === input.orderId,
        );
        if (!order) {
          view.result = { state: 'denied', code: 'not_found', message: 'Record unavailable.' };
          view.status = 'denied';
          transition(entry, 'denied');
          return;
        }
        view.result = { state: 'ok', output: order };
      }
    }
    view.nodeId = null;
    view.status = 'completed';
    transition(entry, 'completed');
  }
  function workflow(id: string) {
    const entry = requireFixture(state.workflows.get(prefix + id));
    if (entry.requester !== owner) throw new PlatformError('not_found');
    return entry;
  }
  const definitionKey = (id: string, version: number) => prefix + id + ':' + version;
  function definition(target: WorkflowTarget) {
    if (target.definitionId === winBackWorkflow.id && target.version === winBackWorkflow.version)
      return winBackWorkflow;
    return requireFixture(
      state.definitions.get(definitionKey(target.definitionId, target.version)),
    );
  }
  if (tenant === 'tenant-rivetquay' && canOperate(me.role)) {
    const id = 'workflow-dead-letter-' + owner;
    if (!state.workflows.has(prefix + id)) {
      const entry: WorkflowEntry = {
        requester: owner,
        fingerprint: '',
        nextStep: 0,
        steps: [],
        view: {
          id,
          definitionId: winBackWorkflow.id,
          version: 1,
          status: 'failed',
          nodeId: 'send',
          dueAt: null,
          approval: null,
          replayable: true,
          result: {
            state: 'failed',
            code: 'provider_error',
            message: 'Simulated transient failure',
            retryable: true,
          },
          history: [],
        },
      };
      transition(entry, 'failed');
      state.workflows.set(prefix + id, entry);
    }
  }

  return {
    async listBots() {
      moduleAccess('ai');
      return structuredClone(bots);
    },
    async startBot(input: BotStart, key) {
      moduleAccess('ai');
      requireRole(canOperate(me.role));
      requireFixture(
        bots.find((item) => item.id === input.botId && item.version === input.version),
      );
      if (!input.prompt.trim() || input.prompt.length > 500)
        throw new PlatformError('invalid_input');
      const fingerprint = JSON.stringify(input);
      const scopedKey = JSON.stringify([tenant, owner, key]);
      const previous = state.botKeys.get(scopedKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new PlatformError('idempotency_conflict');
        return structuredClone(previous.view);
      }
      const id = 'bot-run-' + ++state.botSequence;
      const entry: BotEntry = {
        requester: owner,
        update: () => updateBot(input, entry.view),
        fingerprint,
        events: [],
        view: {
          id,
          botId: input.botId,
          version: input.version,
          status: 'queued',
          result: null,
          pending: null,
        },
      };
      state.bots.set(prefix + id, entry);
      state.botKeys.set(scopedKey, entry);
      event(entry, 'started');
      const draftRequest = /\b(draft|purchase|pr-001)\b/i.test(input.prompt);
      const tool = draftRequest ? 'purchase.order.draft' : 'order.read';
      event(entry, 'step_started', { stepId: 'tool-1', tool });
      if (draftRequest) {
        const request = fixtures.purchaseRequests.find((item) => item.tenantId === tenant);
        if (request) {
          const approval = mockApproval(
            me,
            'approval-bot-' + state.botSequence,
            'purchase.order.approve',
            request.id,
            now,
          );
          entry.view.pending = {
            approval,
            materialPreview: {
              requestId: request.id,
              vendorId: request.vendorId,
              lines: request.lines,
            },
          };
          event(entry, 'approval_required');
        }
      }
      if (!entry.view.pending) {
        event(entry, 'step_settled', { stepId: 'tool-1', state: 'ok' });
        finishBot(entry);
      } else {
        entry.view.status = 'pending_approval';
        entry.update();
      }
      return { ...structuredClone(entry.view), status: 'queued', pending: null, result: null };
    },
    async getBotRun(id) {
      moduleAccess('ai');
      return structuredClone(bot(id).view);
    },
    async *streamBot(id, after, signal) {
      moduleAccess('ai');
      for (const update of bot(id).events) {
        await Promise.resolve();
        if (signal.aborted) return;
        if (update.id > after) yield { ...update };
      }
    },
    async resumeBot(id, approvalId) {
      moduleAccess('ai');
      requireRole(canReview(me.role));
      const entry = bot(id, false);
      const approval = entry.view.pending?.approval;
      if (
        !approval ||
        approval.id !== approvalId ||
        approval.approverId !== owner ||
        approval.requestedBy === owner
      ) {
        throw new PlatformError('not_found');
      }
      if (Date.parse(approval.expiresAt) <= Date.parse(now))
        throw new PlatformError('invalid_approval');
      event(entry, 'resumed');
      event(entry, 'step_settled', { stepId: 'tool-1', state: 'ok' });
      finishBot(entry);
      return structuredClone(entry.view);
    },
    async cancelBot(id) {
      moduleAccess('ai');
      const entry = bot(id);
      if (['queued', 'running', 'pending_approval'].includes(entry.view.status)) {
        entry.view.status = 'cancelled';
        entry.view.pending = null;
        event(entry, 'cancelled');
        entry.update();
      }
      return structuredClone(entry.view);
    },
    async listDefinitions() {
      moduleAccess('workflows');
      return structuredClone([
        winBackWorkflow,
        ...[...state.definitions.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([, item]) => item),
      ]);
    },
    async publish(item) {
      moduleAccess('workflows');
      requireRole(canOperate(me.role));
      if (validateWorkflow(item)) throw new PlatformError('invalid_input');
      const key = definitionKey(item.id, item.version);
      if (state.definitions.has(key) || (item.id === winBackWorkflow.id && item.version === 1))
        throw new PlatformError('idempotency_conflict');
      state.definitions.set(key, structuredClone(item));
      published();
      return structuredClone(item);
    },
    async preview(target) {
      moduleAccess('workflows');
      const steps = resolveWorkflow(definition(target), target.input);
      return {
        steps,
        messages: steps.some((step) => step.tool === 'workflow.template.run')
          ? structuredClone(messages)
          : [],
      };
    },
    async previewMessages() {
      moduleAccess('workflows');
      return structuredClone(messages);
    },
    async startWorkflow(target, key) {
      moduleAccess('workflows');
      requireRole(canOperate(me.role));
      const id = 'workflow-run-' + owner + ':' + key;
      const fingerprint = JSON.stringify(target);
      const previous = state.workflows.get(prefix + id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new PlatformError('idempotency_conflict');
        return structuredClone(previous.view);
      }
      const steps = resolveWorkflow(definition(target), target.input);
      const entry: WorkflowEntry = {
        requester: owner,
        fingerprint,
        steps,
        nextStep: 0,
        view: {
          id,
          definitionId: target.definitionId,
          version: target.version,
          status: 'running',
          nodeId: null,
          dueAt: null,
          approval: null,
          result: null,
          replayable: false,
          history: [],
        },
      };
      transition(entry, 'started');
      advanceWorkflow(entry);
      state.workflows.set(prefix + id, entry);
      return structuredClone(entry.view);
    },
    async listWorkflowRuns() {
      moduleAccess('workflows');
      return structuredClone(
        [...state.workflows.entries()]
          .reverse()
          .filter(([key, item]) => key.startsWith(prefix) && item.requester === owner)
          .map(([, { view }]) => view),
      );
    },
    async getWorkflowHistory(id) {
      moduleAccess('workflows');
      return structuredClone(workflow(id).view);
    },
    async listDeadLetters() {
      moduleAccess('workflows');
      return structuredClone(
        [...state.workflows.entries()]
          .reverse()
          .filter(
            ([key, item]) =>
              key.startsWith(prefix) &&
              item.requester === owner &&
              ['failed', 'unknown'].includes(item.view.status),
          )
          .map(([, { view }]) => view),
      );
    },
    async replayWorkflow(id) {
      moduleAccess('workflows');
      requireRole(canOperate(me.role));
      const entry = workflow(id);
      if (!entry.view.replayable) throw new PlatformError('invalid_input');
      transition(entry, 'replayed');
      Object.assign(entry.view, { status: 'completed', replayable: false, result: null });
      transition(entry, 'completed');
      return structuredClone(entry.view);
    },
    async listWorkflowApprovals() {
      moduleAccess('workflows');
      requireRole(canReview(me.role));
      return structuredClone(
        [...state.workflows.entries()].flatMap(([key, { view }]) =>
          key.startsWith(prefix) &&
          view.approval?.approverId === owner &&
          view.approval.requestedBy !== owner
            ? [{ approval: view.approval, previews: messages }]
            : [],
        ),
      );
    },
    async approveWorkflow(id) {
      moduleAccess('workflows');
      requireRole(canReview(me.role));
      const entry = requireFixture(
        [...state.workflows.entries()].find(
          ([key, { view }]) =>
            key.startsWith(prefix) &&
            view.approval?.id === id &&
            view.approval.approverId === owner,
        )?.[1],
      );
      if (Date.parse(entry.view.approval!.expiresAt) <= Date.parse(now))
        throw new PlatformError('invalid_approval');
      entry.view.approval = null;
      transition(entry, 'approved');
      advanceWorkflow(entry);
    },
  };
}
