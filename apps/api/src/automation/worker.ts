import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type {
  Approval,
  CallEnvelope,
  MessagePreview,
  PurchaseOrderDraft,
  RunChatInput,
  ToolCall,
  ToolResult,
} from '@bs/contracts';
import type { ToolGateway } from '@bs/core';
import type { ToolProposal } from '../../../../packages/adapters/src/llm/index.ts';

export type ApprovalMaterial = {
  approval: Approval;
  draft?: PurchaseOrderDraft;
  previews?: MessagePreview[];
};

export type BotEvent = {
  id: number;
  kind: string;
  runId: string;
  [key: string]: unknown;
};

export type BotView = {
  id: string;
  botId: string;
  version: number;
  status: string;
  result: ToolResult | null;
  pending: ApprovalMaterial | null;
  sessionId?: string | null;
};

type BotSnapshot = {
  view: BotView;
  events: BotEvent[];
  envelope: CallEnvelope;
  fingerprint?: string | null;
};

export type WorkflowView = {
  id: string;
  definitionId: string;
  version: number;
  status: string;
  nodeId: string | null;
  dueAt: number | null;
  approval: Approval | null;
  result: ToolResult | null;
  replayable: boolean;
  history?: unknown[];
};

export type WorkflowInput = {
  trigger: { kind: 'manual' | 'schedule' | 'event'; name?: string; key?: string };
  values?: Record<string, string | number | boolean | null>;
};

type BotStart = {
  envelope: CallEnvelope;
  chat: RunChatInput;
  proposal: ToolProposal | null;
};

type ApprovalDecision = { envelope: CallEnvelope; approvalId: string };
type WorkflowDefinition = { id: string; version: number; nodes: unknown[] };
type WorkflowTarget = {
  envelope: CallEnvelope;
  definitionId: string;
  version: number;
  input: WorkflowInput;
};
type WorkflowRun = { envelope: CallEnvelope; runId: string };
type WorkerReply = { result: ToolResult; pending?: ApprovalMaterial };

type Commands = {
  chat: [BotStart & { threadId: string }, WorkerReply];
  resume: [ApprovalDecision & { threadId: string }, WorkerReply];
  'bot-list': [
    object,
    {
      id: string;
      version: number;
      allowedTools: string[];
      maxActions: number;
      maxSeconds: number;
    }[],
  ];
  'bot-start': [
    BotStart & { runId: string; botId: string; version: number; fingerprint?: string },
    BotView,
  ];
  'bot-inspect': [WorkflowRun & { approvalId?: string }, BotSnapshot];
  'bot-recover': [WorkflowRun, BotSnapshot];
  'bot-session': [{ envelope: CallEnvelope; sessionId: string }, BotView[]];
  'bot-resume': [ApprovalDecision & { runId: string }, BotView];
  'bot-cancel': [WorkflowRun, BotView];
  workflow: [
    { envelope: CallEnvelope; mode: 'preview' | 'run'; approvalId: string | null },
    WorkerReply,
  ];
  'workflow-definitions': [{ envelope: CallEnvelope }, WorkflowDefinition[]];
  'workflow-publish': [
    { envelope: CallEnvelope; definition: WorkflowDefinition },
    WorkflowDefinition,
  ];
  'workflow-preview': [
    WorkflowTarget,
    { nodeId: string; kind: string; tool?: string; input?: unknown }[],
  ];
  'workflow-start': [WorkflowTarget & { now: number }, WorkflowView];
  'workflow-runs': [{ envelope: CallEnvelope; deadOnly: boolean }, WorkflowView[]];
  'workflow-history': [WorkflowRun, WorkflowView];
  'workflow-tick': [WorkflowRun & { now: number }, WorkflowView];
  'workflow-approve': [WorkflowRun & ApprovalDecision & { now: number }, WorkflowView];
  'workflow-replay': [WorkflowRun & { now: number }, WorkflowView];
};

export class WorkerRejection extends Error {
  readonly code: 'not_found' | 'quota_exceeded' | 'invalid_input' | 'conflict';

  constructor(code: WorkerRejection['code']) {
    super(code);
    this.code = code;
  }
}

type WorkerMessage =
  | { reply: unknown }
  | { event: BotEvent }
  | { toolCall: ToolCall; timeoutMs?: number }
  | { rejected: WorkerRejection['code'] }
  | { error: string };

type Controls = { onEvent?: (event: BotEvent) => void; cancelled?: () => boolean };
const repo = new URL('../../../../', import.meta.url);

export function createWorker(
  gateway: ToolGateway,
  python?: string,
  authorize?: (request: ToolCall) => boolean | Promise<boolean>,
  module = 'workers.bs_worker.chat.stdio',
) {
  const interpreter = fileURLToPath(
    new URL(process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python', repo),
  );
  let session: ReturnType<typeof start> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;

  function start() {
    const child = spawn(
      python ?? process.env.BS_WORKER_PYTHON ?? (existsSync(interpreter) ? interpreter : 'python'),
      ['-m', module],
      { cwd: repo, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
    );
    const lines = createInterface({ input: child.stdout });
    const stop = () => {
      lines.close();
      child.kill();
    };
    child.on('error', stop);
    child.stdin.on('error', stop);
    return { child, reader: lines[Symbol.asyncIterator](), stop };
  }

  async function dispatch(toolCall: ToolCall, controls: Controls, timeoutMs = 10_000) {
    const uncertain: ToolResult = {
      state: 'unknown',
      actionId: toolCall.envelope.idempotencyKey,
      message: 'Reconcile the action outcome.',
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    try {
      return await Promise.race([
        new Promise<ToolResult>((resolve) => {
          timer = setTimeout(() => {
            expired = true;
            resolve(uncertain);
          }, timeoutMs);
        }),
        (async () => {
          if (controls.cancelled?.()) return { control: 'cancel' };
          if (authorize && !(await authorize(toolCall))) {
            return { state: 'denied', code: 'forbidden', message: 'Execution permission revoked.' };
          }
          if (controls.cancelled?.()) return { control: 'cancel' };
          return expired ? uncertain : await gateway.call(toolCall);
        })(),
      ]);
    } catch {
      return uncertain;
    } finally {
      clearTimeout(timer);
    }
  }

  async function execute(command: object, controls: Controls): Promise<unknown> {
    if (closed) throw new Error('Fixture worker closed.');
    const { child, reader, stop } = (session ??= start());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      child.stdin.write(JSON.stringify(command) + '\n');
      for (;;) {
        timer = setTimeout(stop, 20_000);
        const line = await reader.next();
        clearTimeout(timer);
        if (line.done) throw new Error('Fixture worker disconnected.');
        const message = JSON.parse(line.value) as WorkerMessage;
        if ('rejected' in message) throw new WorkerRejection(message.rejected);
        if ('error' in message) throw new Error(message.error);
        if ('reply' in message) return message.reply;
        if ('event' in message) controls.onEvent?.(message.event);
        if ('toolCall' in message) {
          const result = await dispatch(message.toolCall, controls, message.timeoutMs);
          child.stdin.write(JSON.stringify(result) + '\n');
        }
      }
    } catch (error) {
      if (!(error instanceof WorkerRejection)) {
        stop();
        session = undefined;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    invoke<K extends keyof Commands>(
      command: Commands[K][0] & { kind: K },
      controls: Controls = {},
    ) {
      const task = queue.then(() => execute(command, controls)) as Promise<Commands[K][1]>;
      queue = task.catch(() => undefined);
      return task;
    },
    close() {
      closed = true;
      session?.stop();
    },
  };
}

export type Worker = ReturnType<typeof createWorker>;
