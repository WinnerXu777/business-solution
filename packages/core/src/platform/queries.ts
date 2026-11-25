import { createHash } from 'node:crypto';
import type { AuditEntry, ModuleId, UsageCounterEvent } from '@bs/contracts';
import { PlatformError } from './audit.ts';
import { actionUsage, type EntitlementStore } from './entitlements.ts';
import type { TenantRepository } from './repository.ts';

export interface TimeFilters {
  from?: string;
  to?: string;
}
interface PageFilters {
  cursor?: string;
  limit?: number;
}
export interface AuditFilters extends TimeFilters, PageFilters {
  tool?: string;
  actorId?: string;
  state?: AuditEntry['state'];
}
export interface UsageFilters extends TimeFilters {
  module?: ModuleId;
}

function timestamp(input: string) {
  const result = Date.parse(input);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(input) ||
    !Number.isFinite(result) ||
    new Date(result).toISOString().slice(0, 19) !== input.slice(0, 19)
  ) {
    throw new PlatformError('forbidden', 'Expected an ISO 8601 UTC timestamp.');
  }
  return result;
}

function inRange({ from, to }: TimeFilters) {
  const start = from === undefined ? -Infinity : timestamp(from);
  const end = to === undefined ? Infinity : timestamp(to);
  if (start > end) throw new PlatformError('forbidden', 'The start must precede the end.');
  return (row: { occurredAt: string }) => {
    const instant = Date.parse(row.occurredAt);
    return start <= instant && instant < end;
  };
}

interface Position {
  occurredAt: string;
  id: string;
}

function compare(a: Position, b: Position) {
  return (
    Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || (a.id > b.id ? -1 : a.id < b.id ? 1 : 0)
  );
}

function page<Thing extends Position>(items: Thing[], filterKey: unknown[], options: PageFilters) {
  const { cursor, limit = 50 } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new PlatformError('forbidden');
  const fingerprint = createHash('sha256').update(JSON.stringify(filterKey)).digest('base64url');
  const sorted = items.toSorted(compare);
  let after = sorted;
  if (cursor !== undefined) {
    try {
      if (!/^[a-zA-Z0-9_-]{1,512}$/.test(cursor)) throw new Error();
      const [key, occurredAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [
        string,
        string,
        string,
      ];
      if (key !== fingerprint || typeof id !== 'string' || !id) throw new Error();
      timestamp(occurredAt);
      after = sorted.filter((row) => compare(row, { occurredAt, id }) > 0);
    } catch {
      throw new PlatformError('forbidden', 'Invalid cursor for this query.');
    }
  }
  const chunk = after.slice(0, limit);
  const last = chunk.at(-1);
  return {
    items: chunk,
    nextCursor:
      last && after.length > limit
        ? Buffer.from(JSON.stringify([fingerprint, last.occurredAt, last.id])).toString('base64url')
        : null,
  };
}

export class PlatformQueries {
  private readonly gateway: { audit(): AuditEntry[]; usage(): UsageCounterEvent[] };
  private readonly auditEntries: TenantRepository<AuditEntry>;
  private readonly entitlements: EntitlementStore;

  constructor(
    gateway: PlatformQueries['gateway'],
    auditEntries: TenantRepository<AuditEntry>,
    entitlements: EntitlementStore,
  ) {
    this.gateway = gateway;
    this.auditEntries = auditEntries;
    this.entitlements = entitlements;
  }

  async audit(tenantId: string, filters: AuditFilters = {}) {
    const { tool, actorId, state, from, to } = filters;
    const range = inRange(filters);
    const entries = [...this.gateway.audit(), ...(await this.auditEntries.list(tenantId))].filter(
      (row) =>
        row.tenantId === tenantId &&
        range(row) &&
        (tool === undefined || row.tool === tool) &&
        (actorId === undefined || row.actor.id === actorId) &&
        (state === undefined || row.state === state),
    );
    return page(entries, ['audit', tenantId, tool, actorId, state, from, to], filters);
  }

  private usageItems(tenantId: string, filters: UsageFilters) {
    const range = inRange(filters);
    return this.gateway
      .usage()
      .filter(
        (row) =>
          row.tenantId === tenantId &&
          range(row) &&
          (filters.module === undefined || row.module === filters.module),
      );
  }

  async usage(tenantId: string, filters: UsageFilters = {}) {
    const items = this.usageItems(tenantId, filters);
    const totals = (await this.entitlements.listing(tenantId, []))
      .filter(({ moduleId }) => filters.module === undefined || moduleId === filters.module)
      .map(({ moduleId: module, allowance }) => ({
        module,
        used: actionUsage(items, module),
        allowance,
      }));
    return { items: items.toSorted(compare), totals };
  }

  usagePage(tenantId: string, filters: UsageFilters & PageFilters = {}) {
    const { module, from, to } = filters;
    return page(this.usageItems(tenantId, filters), ['usage', tenantId, module, from, to], filters);
  }
}
