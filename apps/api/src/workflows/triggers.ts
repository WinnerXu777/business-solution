import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CallEnvelope } from '@bs/contracts';
import { identifier, type Values } from '../../../../packages/core/src/workflows/definition.ts';
import {
  cron,
  eventMatches,
  minute,
  receiptKey,
  scheduleDue,
  verifyWebhook,
  type CatchUp,
  type RecordEvent,
  type RecordEventName,
} from '../../../../packages/core/src/workflows/triggers.ts';
import { WorkflowError, type BuilderWorker, type Run } from './worker.ts';

type Config =
  | { kind: 'schedule'; expression: string; timeZone: string; catchUp: CatchUp; maxRuns: number }
  | { kind: 'event'; name: RecordEventName; threshold?: number }
  | { kind: 'webhook'; secretRef: string };

export type TriggerConfig = Config & { id: string; definitionId: string; values: Values };
export type Trigger = {
  scope: CallEnvelope;
  config: TriggerConfig;
  paused: boolean;
  generation: number;
  cursor: number;
  pending: number[];
};
export type TriggerStore = {
  list(tenantId?: string): Trigger[];
  get(tenantId: string, id: string): Trigger | undefined;
  put(trigger: Trigger): void;
};

export function memoryTriggerStore(): TriggerStore {
  return triggerStore();
}

export function directoryTriggerStore(directory: string): TriggerStore {
  const file = join(directory, 'workflow-triggers.json');
  const saved = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf-8')) as Trigger[]) : [];
  return triggerStore(saved, (records) => {
    const temporary = join(directory, 'workflow-triggers-' + randomUUID() + '.tmp');
    try {
      writeFileSync(temporary, JSON.stringify(records), { flag: 'wx', mode: 0o600, flush: true });
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
  });
}

function triggerStore(initial: Trigger[] = [], save?: (triggers: Trigger[]) => void): TriggerStore {
  const key = (tenant: string, id: string) => JSON.stringify([tenant, id]);
  const records = new Map(
    initial.map((trigger) => [key(trigger.scope.tenantId, trigger.config.id), trigger]),
  );
  return {
    list: (tenantId) =>
      structuredClone(
        [...records.values()].filter(({ scope }) => !tenantId || scope.tenantId === tenantId),
      ),
    get: (tenant, id) => structuredClone(records.get(key(tenant, id))),
    put: (trigger) => {
      const id = key(trigger.scope.tenantId, trigger.config.id);
      const next = structuredClone(trigger);
      if (save) save([...new Map([...records, [id, next]]).values()]);
      records.set(id, next);
    },
  };
}

function view(trigger: Trigger) {
  const config = { ...trigger.config };
  if (config.kind === 'webhook') {
    const { secretRef: _secretRef, ...visible } = config;
    return { ...visible, paused: trigger.paused };
  }
  return { ...config, paused: trigger.paused };
}

type RecordInput = RecordEvent & { recipientId?: string };

export function createTriggers(options: {
  worker: BuilderWorker;
  now: () => number;
  authorize: (scope: CallEnvelope) => boolean | Promise<boolean>;
  secret: (tenant: string, ref: string) => string | undefined | Promise<string | undefined>;
  follow: (scope: CallEnvelope, run: Run) => void;
  store?: TriggerStore;
}) {
  const store = options.store ?? memoryTriggerStore();
  let scheduleQueue: Promise<unknown> = Promise.resolve();

  async function start(trigger: Trigger, sourceId: string | number, values: Values) {
    const { config, scope } = trigger;
    if (trigger.paused || !(await options.authorize(scope))) throw new WorkflowError('forbidden');
    const active = store.get(scope.tenantId, config.id);
    if (!active || active.paused || active.generation !== trigger.generation)
      throw new WorkflowError('forbidden');
    const run = await options.worker.invoke({
      kind: 'start',
      scope,
      definitionId: config.definitionId,
      trigger: config.kind,
      values,
      key: receiptKey(config.id, sourceId),
      now: options.now(),
    });
    options.follow(scope, run);
    return run;
  }

  async function scan() {
    const now = options.now();
    const results = [];
    for (const snapshot of store.list()) {
      const trigger = store.get(snapshot.scope.tenantId, snapshot.config.id);
      if (!trigger) continue;
      const { config, scope } = trigger;
      if (config.kind !== 'schedule' || trigger.paused) continue;
      const plan = trigger.pending.length
        ? { slots: trigger.pending, cursor: trigger.cursor }
        : scheduleDue(
            cron(config.expression, config.timeZone),
            trigger.cursor,
            now,
            config.catchUp,
            config.maxRuns,
          );
      if (!plan.slots.length && plan.cursor === trigger.cursor) continue;
      trigger.pending = [...plan.slots];
      trigger.cursor = plan.cursor;
      store.put(trigger);
      for (const slot of plan.slots) {
        try {
          const run = await start(trigger, slot, config.values);
          results.push({ tenantId: scope.tenantId, triggerId: config.id, slot, runId: run.id });
          const current = store.get(scope.tenantId, config.id);
          if (!current || current.paused || current.generation !== trigger.generation) break;
          current.pending = current.pending.filter((candidate) => candidate !== slot);
          store.put(current);
        } catch (error) {
          results.push({
            tenantId: scope.tenantId,
            triggerId: config.id,
            slot,
            code: error instanceof WorkflowError ? error.code : 'unavailable',
          });
          break;
        }
      }
    }
    return results;
  }

  return {
    list: (tenantId: string) => store.list(tenantId).map(view),
    create(scope: CallEnvelope, config: TriggerConfig) {
      if (store.get(scope.tenantId, config.id)) throw new WorkflowError('conflict');
      if (config.kind === 'schedule') {
        try {
          cron(config.expression, config.timeZone);
        } catch {
          throw new WorkflowError('invalid_input', 'Invalid cron expression or time zone');
        }
      }
      const trigger = {
        scope,
        config,
        paused: false,
        generation: 0,
        cursor: Math.floor(options.now() / minute) * minute,
        pending: [],
      };
      store.put(trigger);
      return view(trigger);
    },
    pause(tenantId: string, id: string, paused: boolean) {
      const trigger = store.get(tenantId, id);
      if (!trigger) throw new WorkflowError('not_found');
      if (trigger.paused !== paused) {
        trigger.paused = paused;
        trigger.generation += 1;
        trigger.cursor = Math.floor(options.now() / minute) * minute;
        trigger.pending = [];
        store.put(trigger);
      }
      return view(trigger);
    },
    scan() {
      const next = scheduleQueue.then(scan);
      scheduleQueue = next.catch(() => undefined);
      return next;
    },
    async event(tenantId: string, event: RecordInput) {
      const results = [];
      for (const trigger of store.list(tenantId)) {
        const { config } = trigger;
        if (
          trigger.paused ||
          config.kind !== 'event' ||
          !eventMatches(config.name, event, config.threshold)
        )
          continue;
        const values = { ...config.values, recordId: event.recordId };
        if (event.recipientId) Object.assign(values, { recipientId: event.recipientId });
        try {
          results.push({ triggerId: config.id, run: await start(trigger, event.id, values) });
        } catch (error) {
          results.push({
            triggerId: config.id,
            code: error instanceof WorkflowError ? error.code : 'unavailable',
          });
        }
      }
      return results;
    },
    async webhook(
      tenantId: string,
      id: string,
      timestamp: unknown,
      signature: unknown,
      raw: Buffer,
      parse: (raw: Buffer) => { id: string; values: Values },
    ) {
      const trigger = store.get(tenantId, id);
      if (!trigger || trigger.config.kind !== 'webhook' || trigger.paused)
        throw new WorkflowError('not_found');
      const secret = await options.secret(tenantId, trigger.config.secretRef);
      if (!secret || !verifyWebhook(secret, tenantId, id, timestamp, signature, raw, options.now()))
        throw new WorkflowError('unauthorized');
      const body = parse(raw);
      if (!identifier.test(body.id)) throw new WorkflowError('invalid_input');
      return start(trigger, body.id, { ...trigger.config.values, ...body.values });
    },
  };
}
