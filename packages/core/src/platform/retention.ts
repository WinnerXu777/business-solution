import { classifiedFields, fieldClass, type DataClass } from './classification.ts';
import { dayMs, instant, iso } from './compliance-time.ts';

export type RecordValue =
  | string
  | number
  | boolean
  | null
  | RecordValue[]
  | { [field: string]: RecordValue };

export interface GovernedRecord {
  id: string;
  version: string;
  tenantId: string;
  subjectId: string;
  recordType: string;
  dataClass: DataClass;
  retainedFrom: string;
  retainUntil?: string;
  fields: Record<string, RecordValue>;
}

export interface RecordRef {
  id: string;
  recordType: string;
  version: string;
}

export interface PrivacyRecordSource {
  list(tenantId: string, subjectId?: string): Promise<GovernedRecord[]>;
  /**
   * Atomically delete matching refs for this subject. Reject stale versions. A committed operation
   * ID returns its original deletion count without new effects, even if the retry finds no records.
   */
  delete(
    tenantId: string,
    subjectId: string,
    operationId: string,
    records: readonly RecordRef[],
  ): Promise<number>;
}

export interface RetentionHoldInput {
  subjectId?: string;
  dataClass: DataClass;
  reasonRef: string;
  until?: string;
}

export type RetentionHold = RetentionHoldInput & {
  id: string;
  createdAt: string;
  releasedAt?: string;
};

export interface RetentionPolicy {
  dataClass: DataClass;
  purgeAfterDays: number;
  minimumRetentionDays: number;
}

export const retentionPolicies: readonly RetentionPolicy[] = [
  { dataClass: 'public', purgeAfterDays: 365, minimumRetentionDays: 0 },
  { dataClass: 'internal', purgeAfterDays: 365, minimumRetentionDays: 0 },
  { dataClass: 'personal', purgeAfterDays: 180, minimumRetentionDays: 0 },
  { dataClass: 'sensitive', purgeAfterDays: 30, minimumRetentionDays: 0 },
  { dataClass: 'financial', purgeAfterDays: 2192, minimumRetentionDays: 2192 },
];

export function recordRef({ id, recordType, version }: GovernedRecord): RecordRef {
  return { id, recordType, version };
}

export function retentionFor(
  record: GovernedRecord,
  holds: readonly RetentionHold[],
  time: number,
  policies: readonly RetentionPolicy[] = retentionPolicies,
) {
  const classes = new Set([record.dataClass]);
  let unclassified = false;
  function classify(value: Record<string, RecordValue>, prefix = '') {
    for (const [key, item] of Object.entries(value)) {
      const path = prefix + key;
      const classification = key.includes('.') ? undefined : fieldClass(record.recordType, path);
      if (classification && (item === null || typeof item !== 'object'))
        classes.add(classification);
      else if (
        !key.includes('.') &&
        item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        Object.hasOwn(classifiedFields, record.recordType) &&
        Object.keys(classifiedFields[record.recordType]).some((field) =>
          field.startsWith(path + '.'),
        )
      ) {
        classify(item, path + '.');
      } else unclassified = true;
    }
  }
  classify(record.fields);
  const matched = policies.filter(({ dataClass }) => classes.has(dataClass));
  unclassified ||=
    matched.length !== classes.size || !Object.hasOwn(classifiedFields, record.recordType);
  const holdIds = holds
    .filter(
      (hold) =>
        classes.has(hold.dataClass) &&
        (hold.subjectId === undefined || hold.subjectId === record.subjectId) &&
        instant(hold.createdAt) <= time &&
        (hold.releasedAt === undefined || instant(hold.releasedAt) > time) &&
        (hold.until === undefined || instant(hold.until) > time),
    )
    .map(({ id }) => id);
  const from = instant(record.retainedFrom);
  const minimumDays = Math.max(
    0,
    ...matched.map(({ minimumRetentionDays }) => minimumRetentionDays),
  );
  const minimumTime = Math.max(
    from + minimumDays * dayMs,
    record.retainUntil === undefined ? from : instant(record.retainUntil),
  );
  const purgeAt = Math.max(
    minimumTime,
    from + Math.max(0, ...matched.map(({ purgeAfterDays }) => purgeAfterDays)) * dayMs,
  );
  return { holdIds, unclassified, minimumTime, purgeAt: iso(purgeAt) };
}

export async function buildExportBundle(
  source: PrivacyRecordSource,
  tenantId: string,
  subjectId: string,
  generatedAt: string,
) {
  const records = (await source.list(tenantId, subjectId))
    .filter((record) => record.tenantId === tenantId && record.subjectId === subjectId)
    .map((record) => ({
      ...recordRef(record),
      dataClass: record.dataClass,
      fields: structuredClone(record.fields),
    }));
  return { version: 'v1' as const, subjectId, generatedAt, records };
}
