import { ConnectorLifecycle } from './lifecycle.ts';
import {
  ConnectorError,
  SerialQueue,
  canonical,
  compareText,
  keyOf,
  stableId,
  type BindingRef,
  type Clock,
  type ConnectorContext,
  type ConnectorManifest,
  type Json,
  type ProviderRecord,
  type RecordKey,
} from './sdk.ts';

export interface CachedRecord extends ProviderRecord {
  id: string;
  source: BindingRef & {
    connectorId: string;
    connectorVersion: string;
    accountId: string;
    externalId: string;
    version: string;
    updatedAt: string;
    observedAt: string;
  };
}

export interface ReconciliationReport {
  checkedAt: string;
  checkpoint: string | null;
  missing: RecordKey[];
  added: RecordKey[];
  changed: RecordKey[];
  conflicting: RecordKey[];
}

export interface ShadowMapping {
  primary: RecordKey;
  candidate: RecordKey;
}

interface Dataset {
  records: Map<string, CachedRecord>;
  absent: Set<string>;
  conflicts: Map<string, { key: RecordKey; updatedAt: number }>;
  checkpoint: string | null;
  report: ReconciliationReport | null;
  syncedAt: string | null;
}

function identity(key: RecordKey) {
  return keyOf(key.recordClass, key.externalId);
}

function recordKey({ recordClass, externalId }: RecordKey): RecordKey {
  return { recordClass, externalId };
}

function content(record: ProviderRecord): Json {
  return {
    fields: record.fields,
    deleted: record.deleted ?? false,
    currency: record.currency ?? null,
  };
}

function revision(record: ProviderRecord): string {
  return canonical({
    content: content(record),
    updatedAt: Date.parse(record.updatedAt),
    occurredAt: record.occurredAt === undefined ? null : Date.parse(record.occurredAt),
    sourceTimezone: record.sourceTimezone ?? null,
  });
}

export function isInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,3}))?Z$/.exec(value);
  const instant = Date.parse(value);
  return Boolean(
    parts &&
      Number.isFinite(instant) &&
      new Date(instant).toISOString() === `${parts[1]}.${(parts[2] ?? '').padEnd(3, '0')}Z`,
  );
}

function isJson(value: unknown): value is Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return Boolean(
    value &&
      typeof value === 'object' &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Object.values(value).every(isJson),
  );
}

function validateRecord(record: ProviderRecord, manifest: ConnectorManifest) {
  if (
    !record ||
    !manifest.recordClasses.includes(record.recordClass) ||
    typeof record.externalId !== 'string' ||
    !record.externalId ||
    typeof record.version !== 'string' ||
    !record.version ||
    !isInstant(record.updatedAt) ||
    (record.occurredAt !== undefined && !isInstant(record.occurredAt)) ||
    (record.currency !== undefined &&
      (typeof record.currency !== 'string' || !/^[A-Z]{3}$/.test(record.currency))) ||
    (record.sourceTimezone !== undefined && typeof record.sourceTimezone !== 'string') ||
    (record.deleted !== undefined && record.deleted !== true) ||
    !record.fields ||
    typeof record.fields !== 'object' ||
    Array.isArray(record.fields) ||
    !isJson(record.fields)
  ) {
    throw new ConnectorError('validation_failed');
  }
}

function sortKeys(keys: RecordKey[]) {
  const unique = new Map(keys.map((key) => [identity(key), recordKey(key)]));
  return [...unique.values()].sort((a, b) => compareText(identity(a), identity(b)));
}

export class ConnectorSync {
  private readonly datasets = new Map<string, Dataset>();
  private readonly triggers = new SerialQueue();
  private readonly lifecycle: ConnectorLifecycle;
  private readonly clock: Clock;

  constructor(lifecycle: ConnectorLifecycle, clock: Clock = Date.now) {
    this.lifecycle = lifecycle;
    this.clock = clock;
  }

  status(ref: BindingRef) {
    this.lifecycle.get(ref);
    const { checkpoint, syncedAt } = this.dataset(ref);
    return { checkpoint, syncedAt };
  }

  records(ref: BindingRef): (CachedRecord & { presence: 'present' | 'missing' | 'deleted' })[] {
    this.lifecycle.get(ref);
    const { records, absent } = this.dataset(ref);
    return [...records.values()]
      .sort((a, b) => compareText(identity(a), identity(b)))
      .map((record) => ({
        ...structuredClone(record),
        presence: record.deleted ? 'deleted' : absent.has(identity(record)) ? 'missing' : 'present',
      }));
  }

  report(ref: BindingRef): ReconciliationReport | null {
    this.lifecycle.get(ref);
    return structuredClone(this.dataset(ref).report);
  }

  importSnapshot(ref: BindingRef) {
    return this.triggers.run(this.datasetKey(ref), () =>
      this.lifecycle.withActive(ref, 'snapshot', async ({ connector, context }) => {
        const snapshot = await connector.snapshot(context);
        this.validateCheckpoint(snapshot.checkpoint);
        const previous = this.dataset(ref);
        const next = this.merge(
          previous,
          connector.manifest,
          context,
          snapshot.records,
          snapshot.checkpoint,
          true,
        );
        this.datasets.set(this.datasetKey(ref), next);
        return structuredClone(next.report!);
      }),
    );
  }

  async poll(ref: BindingRef, maxPages = 10) {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) {
      throw new ConnectorError('validation_failed');
    }
    return this.triggers.run(this.datasetKey(ref), async () => {
      const cursors = new Set<string | null>();
      const added: RecordKey[] = [];
      const changed: RecordKey[] = [];
      let hasMore = true;
      let pages = 0;
      while (hasMore && pages < maxPages) {
        hasMore = await this.lifecycle.withActive(
          ref,
          'listChangedSince',
          async ({ connector, context }) => {
            const previous = this.dataset(ref);
            cursors.add(previous.checkpoint);
            const page = await connector.listChangedSince(context, previous.checkpoint);
            this.validateCheckpoint(page.checkpoint);
            if (
              typeof page.hasMore !== 'boolean' ||
              (cursors.has(page.checkpoint) &&
                (page.hasMore || page.checkpoint !== previous.checkpoint))
            ) {
              throw new ConnectorError('validation_failed');
            }
            const next = this.merge(
              previous,
              connector.manifest,
              context,
              page.records,
              page.checkpoint,
              false,
            );
            const report = next.report!;
            added.push(...report.added);
            changed.push(...report.changed);
            next.report = this.sortedReport({ ...report, added, changed });
            this.datasets.set(this.datasetKey(ref), next);
            return page.hasMore;
          },
        );
        pages += 1;
      }
      return { ...this.status(ref), pages, hasMore };
    });
  }

  /** Event payloads specify which record to hydrate. A null read leaves the prior record intact. */
  hydrate(ref: BindingRef, key: RecordKey): Promise<void> {
    return this.lifecycle.withActive(ref, 'read', async ({ connector, context }) => {
      const supported = connector.manifest.webhook;
      if (!supported || !supported.recordClasses.includes(key.recordClass)) {
        throw new ConnectorError('unsupported');
      }
      const record = await connector.read(context, key);
      if (!record) return;
      if (identity(record) !== identity(key)) throw new ConnectorError('validation_failed');
      const previous = this.dataset(ref);
      const next = this.merge(
        previous,
        connector.manifest,
        context,
        [record],
        previous.checkpoint,
        false,
      );
      this.datasets.set(this.datasetKey(ref), {
        ...next,
        report: previous.report,
        syncedAt: previous.syncedAt,
      });
      if (next.conflicts.has(identity(key))) throw new ConnectorError('conflict');
    });
  }

  compareShadow(primary: BindingRef, candidate: BindingRef, mappings: readonly ShadowMapping[]) {
    if (primary.tenantId !== candidate.tenantId) throw new ConnectorError('not_found');
    const liveBinding = this.lifecycle.get(primary);
    const shadowBinding = this.lifecycle.get(candidate);
    if (
      liveBinding.mode !== 'primary' ||
      shadowBinding.mode !== 'shadow' ||
      this.lifecycle.manifest(primary).capability !== this.lifecycle.manifest(candidate).capability
    )
      throw new ConnectorError('conflict');

    const live = this.dataset(primary);
    const shadow = this.dataset(candidate);
    if (live.syncedAt === null || shadow.syncedAt === null) throw new ConnectorError('conflict');
    const report = this.newReport(shadow.checkpoint);
    const left = new Set<string>();
    const right = new Set<string>();
    const conflicts = new Set<string>();
    const reverse = new Map<string, string>();
    const forward = new Map<string, string>();
    for (const mapping of mappings) {
      const a = identity(mapping.primary);
      const b = identity(mapping.candidate);
      if (
        (forward.has(a) && forward.get(a) !== b) ||
        (reverse.has(b) && reverse.get(b) !== a) ||
        mapping.primary.recordClass !== mapping.candidate.recordClass
      ) {
        conflicts.add(a);
        const duplicate = reverse.get(b);
        if (duplicate) conflicts.add(duplicate);
      }
      forward.set(a, b);
      reverse.set(b, a);
    }
    for (const mapping of mappings) {
      const a = identity(mapping.primary);
      const b = identity(mapping.candidate);
      left.add(a);
      right.add(b);
      if (conflicts.has(a) || live.conflicts.has(a) || shadow.conflicts.has(b)) {
        report.conflicting.push(mapping.primary);
        continue;
      }
      const before = live.absent.has(a) ? undefined : live.records.get(a);
      const after = shadow.absent.has(b) ? undefined : shadow.records.get(b);
      if (before && !before.deleted && (!after || after.deleted)) report.missing.push(before);
      else if (after && !after.deleted && (!before || before.deleted)) report.added.push(after);
      else if (before && after && canonical(content(before)) !== canonical(content(after))) {
        report.changed.push(before);
      }
    }
    for (const record of live.records.values()) {
      const key = identity(record);
      if (!record.deleted && !live.absent.has(key) && !left.has(key)) report.missing.push(record);
    }
    for (const record of shadow.records.values()) {
      const key = identity(record);
      if (!record.deleted && !shadow.absent.has(key) && !right.has(key)) report.added.push(record);
    }
    for (const [key, conflict] of live.conflicts)
      if (!left.has(key)) report.conflicting.push(conflict.key);
    for (const [key, conflict] of shadow.conflicts)
      if (!right.has(key)) report.conflicting.push(conflict.key);
    return this.sortedReport(report);
  }

  private merge(
    previous: Dataset,
    manifest: ConnectorManifest,
    context: ConnectorContext,
    incoming: readonly ProviderRecord[],
    checkpoint: string | null,
    full: boolean,
  ): Dataset {
    if (!Array.isArray(incoming)) throw new ConnectorError('validation_failed');
    const report = this.newReport(checkpoint);
    const records = new Map(previous.records);
    const absent = new Set(previous.absent);
    const conflicts = new Map(previous.conflicts);
    const groups = Map.groupBy(incoming, (record) => {
      validateRecord(record, manifest);
      return identity(record);
    });
    for (const [key, versions] of groups) {
      const baseline = records.get(key);
      const ordered = [...versions].sort(
        (a, b) =>
          Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || compareText(a.version, b.version),
      );
      const latest = ordered.at(-1)!;
      const seen = new Map<string, string>();
      if (baseline) seen.set(baseline.version, revision(baseline));
      const ambiguous = ordered.some((item) => {
        const current = revision(item);
        const earlier = seen.get(item.version);
        seen.set(item.version, current);
        return earlier !== undefined && earlier !== current;
      });
      const ties = ordered.filter(
        (item) => Date.parse(item.updatedAt) === Date.parse(latest.updatedAt),
      );
      const priorTime = baseline ? Date.parse(baseline.updatedAt) : -Infinity;
      const nextTime = Date.parse(latest.updatedAt);
      if (priorTime > nextTime || (conflicts.get(key)?.updatedAt ?? -Infinity) >= nextTime)
        continue;
      if (
        ambiguous ||
        ties.some((item) => item.version !== latest.version) ||
        (baseline && priorTime === nextTime && baseline.version !== latest.version)
      ) {
        conflicts.set(key, { key: recordKey(latest), updatedAt: nextTime });
        continue;
      }
      absent.delete(key);
      conflicts.delete(key);
      if (!baseline && !latest.deleted) report.added.push(latest);
      if (baseline && baseline.version !== latest.version) report.changed.push(latest);
      const { tenantId, connectionId, accountId } = context;
      const { externalId, recordClass, version, updatedAt } = latest;
      const sanitized: ProviderRecord = {
        externalId,
        recordClass,
        version,
        updatedAt,
        currency: latest.currency,
        sourceTimezone: latest.sourceTimezone,
        occurredAt: latest.occurredAt,
        deleted: latest.deleted,
        fields: latest.fields,
      };
      records.set(key, {
        ...structuredClone(sanitized),
        id: stableId(tenantId, connectionId, accountId, recordClass, externalId),
        source: {
          tenantId,
          connectionId,
          accountId,
          externalId,
          version,
          updatedAt,
          connectorId: manifest.id,
          connectorVersion: manifest.version,
          observedAt: report.checkedAt,
        },
      });
    }
    for (const [key, record] of records) {
      if (full && !record.deleted && !groups.has(key)) absent.add(key);
      if (absent.has(key)) report.missing.push(record);
    }
    report.conflicting = [...conflicts.values()].map(({ key }) => key);
    return {
      records,
      absent,
      conflicts,
      checkpoint,
      report: this.sortedReport(report),
      syncedAt: report.checkedAt,
    };
  }

  private newReport(checkpoint: string | null): ReconciliationReport {
    return {
      checkedAt: new Date(this.clock()).toISOString(),
      checkpoint,
      missing: [],
      added: [],
      changed: [],
      conflicting: [],
    };
  }

  private sortedReport(report: ReconciliationReport): ReconciliationReport {
    return {
      ...report,
      missing: sortKeys(report.missing),
      added: sortKeys(report.added),
      changed: sortKeys(report.changed),
      conflicting: sortKeys(report.conflicting),
    };
  }

  private validateCheckpoint(checkpoint: string) {
    if (typeof checkpoint !== 'string' || !checkpoint)
      throw new ConnectorError('validation_failed');
  }

  private datasetKey(ref: BindingRef) {
    return keyOf(ref.tenantId, ref.connectionId);
  }

  private dataset(ref: BindingRef): Dataset {
    return (
      this.datasets.get(this.datasetKey(ref)) ?? {
        records: new Map(),
        absent: new Set(),
        conflicts: new Map(),
        checkpoint: null,
        report: null,
        syncedAt: null,
      }
    );
  }
}
