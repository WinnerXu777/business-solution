import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  Approval,
  AuditEntry,
  MessagePreview,
  PurchaseOrder,
  PurchaseOrderDraft,
  RunWorkflowTemplateInput,
  ToolCall,
  ToolResult,
  UsageCounterEvent,
} from '@bs/contracts';
import type { PostgresExecutor } from '../../../business/src/persistence/index.ts';

import type { BillingEntry, Reservation } from './billing.ts';
import type { StoredReview } from './records.ts';

export interface StoredApproval {
  grant: Approval;
  target: string;
  rejectionReason?: string;
}

export type Effect =
  | { kind: 'purchase'; order: PurchaseOrder }
  | { kind: 'message'; preview: MessagePreview }
  | {
      kind: 'workflow';
      templateId: RunWorkflowTemplateInput['templateId'];
      previews: MessagePreview[];
    };

export interface StoredIntent {
  id: string;
  request: ToolCall;
  approvalId: string;
  target: string;
  effect: Effect;
  acceptedAt: string;
}

export interface OutboxJob {
  id: string;
  status: 'queued' | 'running' | 'retryable' | 'unknown' | 'completed' | 'dead_letter';
  attempts: number;
  checks: number;
  nextAttemptAt: number;
  claim?: string;
  reviewReason?: 'attempts_exhausted' | 'reconciliation_required' | 'dispatch_failed';
  unresolved?: boolean;
  billingReservation?: Reservation;
}

export type AuditLink = AuditEntry & {
  previousHash: string | null;
  hash: string;
  providerId?: string;
  bindingVersion?: number;
};

interface Tables {
  approval: StoredApproval;
  artifact: PurchaseOrderDraft | MessagePreview;
  outcome: { fingerprint: string; result: ToolResult };
  intent: StoredIntent;
  outbox: OutboxJob;
  usage: UsageCounterEvent;
  billing_event: BillingEntry;
  record_review: StoredReview;
}

const tables = [
  'approval',
  'artifact',
  'outcome',
  'intent',
  'outbox',
  'usage',
  'billing_event',
  'record_review',
] as const;

export interface TenantState {
  rows: { [Name in keyof Tables]: Map<string, Tables[Name]> };
  audit: AuditLink[];
}

function emptyState(): TenantState {
  return {
    rows: {
      approval: new Map(),
      artifact: new Map(),
      outcome: new Map(),
      intent: new Map(),
      outbox: new Map(),
      usage: new Map(),
      billing_event: new Map(),
      record_review: new Map(),
    },
    audit: [],
  };
}

export interface GovernanceStore {
  transact<T>(tenantId: string, operation: (state: TenantState) => T | Promise<T>): Promise<T>;
}

export class MemoryGovernanceStore implements GovernanceStore {
  private readonly tenants = new Map<string, TenantState>();
  private queue: Promise<unknown> = Promise.resolve();

  snapshot() {
    return structuredClone([...this.tenants.values()]);
  }

  transact<T>(tenantId: string, operation: (state: TenantState) => T | Promise<T>) {
    const result = this.queue.then(async () => {
      const draft = structuredClone(this.tenants.get(tenantId) ?? emptyState());
      const value = await operation(draft);
      this.tenants.set(tenantId, draft);
      return structuredClone(value);
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
}

interface TransactionClient extends PostgresExecutor {
  release(destroy?: boolean): void;
}

export class PostgresGovernanceStore implements GovernanceStore {
  private readonly pool: { connect(): Promise<TransactionClient> };
  private readonly activeClient = new AsyncLocalStorage<TransactionClient>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(pool: { connect(): Promise<TransactionClient> }) {
    this.pool = pool;
  }

  query<Row extends Record<string, unknown>>(sql: string, values?: unknown[]) {
    const client = this.activeClient.getStore();
    if (!client) throw new Error('Record access requires a governance transaction.');
    return client.query<Row>(sql, values);
  }

  transact<T>(tenantId: string, operation: (state: TenantState) => T | Promise<T>) {
    // Keep advisory-lock waiters from occupying the connections used by the platform checks.
    const result = this.queue.then(() => this.transaction(tenantId, operation));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async transaction<T>(
    tenantId: string,
    operation: (state: TenantState) => T | Promise<T>,
  ) {
    const client = await this.pool.connect();
    let destroy = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        'rivetquay-governance:' + tenantId,
      ]);
      const state = emptyState();
      const originals = new Map<string, Map<string, string>>();
      for (const table of tables) {
        const { rows } = await client.query<{ id: string; payload: Tables[typeof table] }>(
          'SELECT id, payload FROM governance.' + table + ' WHERE tenant_id = $1',
          [tenantId],
        );
        const entries = state.rows[table] as Map<string, Tables[typeof table]>;
        for (const { id, payload } of rows) entries.set(id, payload);
        originals.set(table, new Map(rows.map(({ id, payload }) => [id, JSON.stringify(payload)])));
      }
      const audit = await client.query<{ payload: AuditLink }>(
        'SELECT payload FROM governance.audit WHERE tenant_id = $1 ORDER BY sequence',
        [tenantId],
      );
      state.audit = audit.rows.map(({ payload }) => payload);
      const value = await this.activeClient.run(client, () => operation(state));

      for (const table of tables) {
        for (const [id, payload] of state.rows[table]) {
          const serialized = JSON.stringify(payload);
          if (originals.get(table)?.get(id) === serialized) continue;
          await client.query(
            'INSERT INTO governance.' +
              table +
              ' (tenant_id, id, payload) VALUES ($1, $2, $3::jsonb) ' +
              'ON CONFLICT (tenant_id, id) DO UPDATE SET payload = EXCLUDED.payload',
            [tenantId, id, serialized],
          );
        }
      }
      for (const [offset, entry] of state.audit.slice(audit.rows.length).entries()) {
        await client.query(
          'INSERT INTO governance.audit (tenant_id, sequence, payload) VALUES ($1, $2, $3::jsonb)',
          [tenantId, audit.rows.length + offset + 1, JSON.stringify(entry)],
        );
      }
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        destroy = true;
      }
      throw error;
    } finally {
      client.release(destroy);
    }
  }
}
