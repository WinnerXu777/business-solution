import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { CallEnvelope } from '@bs/contracts';
import type {
  TriggerKind,
  Values,
  WorkflowDefinition,
} from '../../../../packages/core/src/workflows/definition.ts';

export class WorkflowError extends Error {
  readonly code:
    | 'not_found'
    | 'quota_exceeded'
    | 'invalid_input'
    | 'conflict'
    | 'unavailable'
    | 'forbidden'
    | 'unauthorized';
  readonly detail?: string;

  constructor(code: WorkflowError['code'], detail?: string) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

export type Run = {
  id: string;
  definitionId: string;
  version: number;
  nodeId: string | null;
  status: string;
  dueAt: number | null;
  pending: Record<string, unknown> | null;
  error: string | null;
  history: unknown[];
};

type Scoped = { scope: CallEnvelope };
type Ref = Scoped & { definitionId: string; version: number };
type Timed = Scoped & { now: number };
type RunRef = Scoped & { runId: string };
type Commands = {
  preview: [
    Scoped & { definition: WorkflowDefinition; values: Values },
    { plan: unknown[]; receipts: [] },
  ];
  definition: [Ref, WorkflowDefinition];
  publish: [Scoped & { definition: WorkflowDefinition }, WorkflowDefinition];
  release: [Ref, { definitionId: string; version: number }];
  start: [
    Timed & {
      definitionId: string;
      version?: number;
      trigger: TriggerKind;
      values: Values;
      key: string;
    },
    Run,
  ];
  read: [RunRef, Run];
  inbox: [Timed & { roles: string[] }, { runId: string; kind: string; pending: unknown }[]];
  recover: [object, { scope: CallEnvelope; run: Run }[]];
  tick: [RunRef & Timed, Run];
  event: [RunRef & Timed & { event: string; key: string }, Run];
  task: [RunRef & Timed & { taskId: string; roles: string[] }, Run];
  approve: [RunRef & Timed & { approvalId: string }, Run];
  migrate: [RunRef & Timed & { fromVersion: number; toVersion: number }, Run];
};

export type Effect = {
  scope: CallEnvelope;
  kind: 'message' | 'create-record' | 'update-record' | 'http' | 'llm-draft';
  phase: 'read' | 'prepare' | 'sign' | 'execute';
  input: Record<string, unknown>;
  decision?: CallEnvelope;
  approvalId?: string;
  binding?: unknown;
};
export type EffectResult =
  | { state: 'ok'; id?: string; text?: string }
  | {
      state: 'pending_approval';
      approval: { id: string; approverId: string; expiresAt: number };
      review?: unknown;
      binding?: unknown;
    }
  | { state: 'denied' | 'failed' | 'unknown' };
export type Relay = (effect: Effect, signal: AbortSignal) => EffectResult | Promise<EffectResult>;

type Options = {
  relay: Relay;
  connectors?: readonly (readonly [string, string])[];
  python?: string;
  activeLimit?: number;
  runLimit?: number;
  stateDirectory?: string;
};

const repo = new URL('../../../../', import.meta.url);

export function createBuilderWorker({
  relay,
  connectors = [],
  python,
  activeLimit = 16,
  runLimit = 100,
  stateDirectory,
}: Options) {
  const bundled = fileURLToPath(
    new URL(process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python', repo),
  );
  const bounds = [activeLimit, runLimit];
  if (bounds.some((limit) => !Number.isSafeInteger(limit) || limit < 1))
    throw new Error('Invalid workflow limit');
  let processSession: ReturnType<typeof start> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;

  function start() {
    const child = spawn(
      python ??
        process.env.BS_WORKFLOW_BUILDER_PYTHON ??
        (existsSync(bundled) ? bundled : 'python'),
      [
        '-m',
        'workers.bs_worker.workflows.builder_stdio',
        JSON.stringify({
          connectors,
          active_limit: activeLimit,
          run_limit: runLimit,
          state_directory: stateDirectory === undefined ? undefined : resolve(stateDirectory),
        }),
      ],
      { cwd: repo, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    const lines = createInterface({ input: child.stdout });
    function stop() {
      lines.close();
      child.kill();
    }
    child.on('error', stop);
    child.stdin.on('error', stop);
    return { child, lines: lines[Symbol.asyncIterator](), stop };
  }

  async function dispatch(effect: Effect): Promise<EffectResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<EffectResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ state: 'unknown' });
        }, 10_000);
      });
      return await Promise.race([timeout, relay(effect, controller.signal)]);
    } catch {
      return { state: 'unknown' };
    } finally {
      clearTimeout(timer);
    }
  }

  async function execute(command: object) {
    if (closed) throw new WorkflowError('unavailable');
    const session = (processSession ??= start());
    try {
      session.child.stdin.write(JSON.stringify(command) + '\n');
      for (;;) {
        const timer = setTimeout(session.stop, 20_000);
        const line = await session.lines.next().finally(() => clearTimeout(timer));
        if (line.done) break;
        const message = JSON.parse(line.value) as
          | { code: WorkflowError['code'] }
          | { effect: Effect }
          | { reply: unknown };
        if ('code' in message) throw new WorkflowError(message.code);
        if ('reply' in message) return message.reply;
        const result = await dispatch(message.effect);
        session.child.stdin.write(JSON.stringify(result) + '\n');
      }
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
    }
    // Ambiguous relay outcomes must never restart a worker against empty state.
    closed = true;
    session.stop();
    throw new WorkflowError('unavailable');
  }

  return {
    invoke<K extends keyof Commands>(command: Commands[K][0] & { kind: K }) {
      const result = queue.then(() => execute(command)) as Promise<Commands[K][1]>;
      queue = result.catch(() => undefined);
      return result;
    },
    async close() {
      closed = true;
      if (!processSession) return;
      const { child, stop } = processSession;
      if (child.exitCode !== null || child.signalCode !== null) return;
      const finished = once(child, 'close').catch(() => undefined);
      stop();
      await finished;
    },
  };
}

export type BuilderWorker = ReturnType<typeof createBuilderWorker>;
