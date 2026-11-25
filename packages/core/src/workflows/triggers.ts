import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const minute = 60_000;
const maxLookback = 7 * 24 * 60;

type CronField = { values: Set<number>; unrestricted: boolean };

function cronField(text: string, min: number, max: number, sunday = false): CronField {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const match = /^(\*|\d{1,2})(?:-(\d{1,2}))?(?:\/(\d{1,2}))?$/.exec(part);
    if (!match || (match[1] === '*' && match[2]) || (match[3] && match[1] !== '*' && !match[2]))
      throw new Error('Invalid cron field');
    const start = match[1] === '*' ? min : Number(match[1]);
    const end = match[2] ? Number(match[2]) : match[1] === '*' ? max : start;
    const step = Number(match[3] ?? 1);
    if (start < min || end > max || start > end || step < 1 || step > max - min + 1)
      throw new Error('Cron field outside its range');
    for (let value = start; value <= end; value += step)
      values.add(sunday && value === 7 ? 0 : value);
  }
  return { values, unrestricted: values.size === (sunday ? 7 : max - min + 1) };
}

export function cron(expression: string, timeZone: string) {
  const fields = expression.trim().split(/\s+/);
  if (
    fields.length !== 5 ||
    expression.length > 256 ||
    !/^[A-Za-z][A-Za-z0-9_./+-]{0,127}$/.test(timeZone)
  )
    throw new Error('Expected five cron fields and a named time zone');
  const minutes = cronField(fields[0], 0, 59);
  const hours = cronField(fields[1], 0, 23);
  const days = cronField(fields[2], 1, 31);
  const months = cronField(fields[3], 1, 12);
  const weekdays = cronField(fields[4], 0, 7, true);
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    weekday: 'short',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return (instant: number) => {
    const parts = Object.fromEntries(
      format.formatToParts(instant).map(({ type, value }) => [type, value]),
    );
    const day = days.values.has(Number(parts.day));
    const weekday = weekdays.values.has(
      ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
    );
    return (
      minutes.values.has(Number(parts.minute)) &&
      hours.values.has(Number(parts.hour)) &&
      months.values.has(Number(parts.month)) &&
      (days.unrestricted || weekdays.unrestricted ? day && weekday : day || weekday)
    );
  };
}

export type CatchUp = 'skip' | 'run-once' | 'run-all';

export function scheduleDue(
  matches: (time: number) => boolean,
  cursor: number,
  now: number,
  policy: CatchUp,
  maxRuns = 10,
) {
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(cursor) ||
    now < 0 ||
    cursor < 0 ||
    now > 8.64e15 ||
    cursor > 8.64e15 ||
    !['skip', 'run-once', 'run-all'].includes(policy) ||
    !Number.isInteger(maxRuns) ||
    maxRuns < 1 ||
    maxRuns > 100
  )
    throw new Error('Invalid schedule bounds');
  const current = Math.floor(now / minute) * minute;
  if (current <= cursor) return { cursor, slots: [] };
  const slots: number[] = [];
  const floor = Math.max(
    Math.floor(cursor / minute) * minute + minute,
    current - maxLookback * minute,
  );
  if (policy !== 'skip') {
    const limit = policy === 'run-once' ? 1 : maxRuns;
    for (let slot = current - minute; slot >= floor && slots.length < limit; slot -= minute)
      if (matches(slot)) slots.push(slot);
    slots.reverse();
  }
  if (matches(current)) slots.push(current);
  return { cursor: current, slots };
}

export const recordEvents = [
  'order.created',
  'invoice.overdue',
  'customer.inactive',
  'stock.below_reorder',
  'approval.decided',
  'customer.created',
  'quote.follow_up_due',
  'stock.restocked',
  'order.large',
  'vendor.delivery_late',
  'payment.retry_scheduled',
] as const;
export type RecordEventName = (typeof recordEvents)[number];
export type RecordEvent = {
  id: string;
  name: RecordEventName;
  recordId: string;
  beforeDays?: number;
  days?: number;
  beforeQuantity?: number;
  quantity?: number;
  reorderPoint?: number;
};

export function eventMatches(name: RecordEventName, event: RecordEvent, days?: number) {
  if (event.name !== name) return false;
  if (name === 'invoice.overdue' || name === 'customer.inactive') {
    if (days === undefined || event.days === undefined || !Number.isSafeInteger(event.days))
      return false;
    const before = event.beforeDays ?? -1;
    return Number.isSafeInteger(before) && before < days && event.days >= days;
  }
  if (name === 'stock.below_reorder') {
    const { beforeQuantity, quantity, reorderPoint } = event;
    if (
      quantity === undefined ||
      reorderPoint === undefined ||
      !Number.isSafeInteger(quantity) ||
      !Number.isSafeInteger(reorderPoint) ||
      (beforeQuantity !== undefined && !Number.isSafeInteger(beforeQuantity))
    )
      return false;
    return (beforeQuantity ?? reorderPoint) >= reorderPoint && quantity < reorderPoint;
  }
  return true;
}

export function receiptKey(triggerId: string, sourceId: string | number) {
  return createHash('sha256')
    .update(JSON.stringify([triggerId, sourceId]))
    .digest('hex');
}

export function verifyWebhook(
  secret: string,
  tenantId: string,
  triggerId: string,
  timestamp: unknown,
  signature: unknown,
  raw: Buffer,
  now: number,
) {
  if (
    typeof timestamp !== 'string' ||
    !/^[0-9]{1,12}$/.test(timestamp) ||
    typeof signature !== 'string' ||
    !/^sha256=[a-fA-F0-9]{64}$/.test(signature) ||
    Math.abs(now - Number(timestamp) * 1000) > 5 * minute
  )
    return false;
  const expected = createHmac('sha256', secret)
    .update(JSON.stringify([tenantId, triggerId, timestamp]) + '.')
    .update(raw)
    .digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}
