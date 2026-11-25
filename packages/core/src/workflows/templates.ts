import { randomUUID } from 'node:crypto';
import type { TriggerKind, Values, WorkflowDefinition, WorkflowNode } from './definition.ts';
import type { RecordEventName } from './triggers.ts';

type Parameter = { type: 'text'; default: string } | { type: 'days'; default: number };
type Template = {
  id: string;
  title: string;
  description: string;
  trigger:
    | { kind: 'event'; name: RecordEventName; threshold?: number }
    | { kind: 'schedule'; expression: string; timeZone: string };
  parameters: Record<string, Parameter>;
  fixture: Values;
  nodes: (parameters: Record<string, string | number>) => WorkflowNode[];
};

const recordId = { ref: 'recordId' };
const recipientId = { ref: 'recipientId' };
const text = (value: string): Parameter => ({ type: 'text', default: value });
const days = (value: number): Parameter => ({ type: 'days', default: value });

function customerMessage(
  id: string,
  title: string,
  description: string,
  name: RecordEventName,
  record: string,
  recipient: string,
  copy: string,
  purpose: 'marketing' | 'transactional' = 'transactional',
  threshold?: number,
): Template {
  return {
    id,
    title,
    description,
    trigger: { kind: 'event', name, ...(threshold === undefined ? {} : { threshold }) },
    parameters: {
      message: text(copy),
      ...(threshold === undefined ? {} : { days: days(threshold) }),
    },
    fixture: { recordId: record, recipientId: recipient },
    nodes: (parameters) => [
      {
        id: 'notify',
        kind: 'message',
        channel: 'email',
        purpose,
        recipientId,
        sourceId: recordId,
        body: parameters.message,
        next: null,
      },
    ],
  };
}

function roleTask(
  id: string,
  title: string,
  description: string,
  name: RecordEventName,
  record: string,
  role: string,
  copy: string,
  hold = false,
): Template {
  return {
    id,
    title,
    description,
    trigger: { kind: 'event', name },
    parameters: { title: text(copy), dueDays: days(1) },
    fixture: { recordId: record },
    nodes: (parameters) => [
      ...(hold
        ? [
            {
              id: 'hold',
              kind: 'create-record',
              recordType: 'order-hold',
              subjectId: recordId,
              summary: parameters.title,
              output: 'holdId',
              next: 'review',
            } as const,
          ]
        : []),
      {
        id: 'review',
        kind: 'human-task',
        role,
        title: parameters.title,
        dueMs: Number(parameters.dueDays) * 86_400_000,
        next: null,
        onTimeout: null,
      },
    ],
  };
}

const library: Template[] = [
  customerMessage(
    'win-back',
    'Win back inactive customers',
    'Review a marketing message when an account crosses the inactivity threshold.',
    'customer.inactive',
    'cust-008',
    'cust-008',
    'Can Rivetquay help with your next replenishment?',
    'marketing',
    90,
  ),
  {
    id: 'overdue-invoice',
    title: 'Overdue invoice reminder',
    description: 'Use the governed collections preview and current invoice balance.',
    trigger: { kind: 'event', name: 'invoice.overdue', threshold: 7 },
    parameters: { days: days(7) },
    fixture: { recordId: 'inv-001', recipientId: 'cust-002' },
    nodes: () => [
      {
        id: 'notify',
        kind: 'message',
        channel: 'email',
        purpose: 'collections',
        recipientId,
        sourceId: recordId,
        next: null,
      },
    ],
  },
  roleTask(
    'reorder-alert',
    'Reorder alert to purchasing',
    'Assign a purchasing review when stock crosses its reorder point.',
    'stock.below_reorder',
    'sku-001',
    'purchasing',
    'Review replenishment quantities and supplier lead times',
  ),
  customerMessage(
    'customer-onboarding',
    'New customer onboarding',
    'Review a welcome message for a new account.',
    'customer.created',
    'cust-009',
    'cust-009',
    'Welcome to Rivetquay. Your account team can help with your first order.',
  ),
  customerMessage(
    'quote-follow-up',
    'Quote follow-up',
    'Review a follow-up when a quote reaches its follow-up date.',
    'quote.follow_up_due',
    'quote-fixture-001',
    'cust-008',
    'Would you like us to review your outstanding quote with you?',
  ),
  customerMessage(
    'back-in-stock',
    'Back-in-stock notice',
    'Review a stock notice for a subscribed customer.',
    'stock.restocked',
    'sku-001',
    'cust-008',
    'The Rivetquay item you asked about is back in stock.',
    'marketing',
  ),
  roleTask(
    'large-order-hold',
    'Large-order fraud review hold',
    'Request approval to place a hold and assign the review to risk staff.',
    'order.large',
    'ord-004',
    'risk',
    'Review large order before release',
    true,
  ),
  {
    id: 'monthly-account-summary',
    title: 'Monthly account summary',
    description: 'Draft a summary of supplied account facts for review on the first of the month.',
    trigger: { kind: 'schedule', expression: '0 9 1 * *', timeZone: 'America/Toronto' },
    parameters: { model: text('fixture-chat') },
    fixture: {
      recordId: 'cust-008',
      recipientId: 'cust-008',
      facts: 'Fictional North Pier account placed two orders in November. One invoice is open.',
    },
    nodes: (parameters) => [
      {
        id: 'draft',
        kind: 'llm-draft',
        model: String(parameters.model),
        prompt: { ref: 'facts' },
        output: 'draftBody',
        next: 'notify',
      },
      {
        id: 'notify',
        kind: 'message',
        channel: 'email',
        purpose: 'transactional',
        recipientId,
        sourceId: recordId,
        body: { ref: 'draftBody' },
        next: null,
      },
    ],
  },
  roleTask(
    'vendor-late-delivery',
    'Vendor late-delivery escalation',
    'Assign an overdue supplier shipment for purchasing follow-up.',
    'vendor.delivery_late',
    'po-fixture-002',
    'purchasing',
    'Confirm revised vendor delivery date',
  ),
  customerMessage(
    'failed-payment-retry',
    'Failed-payment retry notice',
    'Review a notice for an already scheduled payment retry.',
    'payment.retry_scheduled',
    'inv-001',
    'cust-002',
    'A payment retry has been scheduled. Contact your Rivetquay account team with questions.',
  ),
];

export function listTemplates() {
  return library.map(({ nodes: _nodes, ...template }) => structuredClone(template));
}

export function instantiateTemplate(
  id: string,
  supplied: unknown,
  definitionId = 'draft-' + randomUUID(),
) {
  const template = library.find((candidate) => candidate.id === id);
  if (!template) return undefined;
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied))
    throw new Error('Expected a parameters object');
  const parameters: Record<string, string | number> = {};
  for (const key of Object.keys(supplied))
    if (!Object.hasOwn(template.parameters, key))
      throw new Error('Unknown template parameter ' + key);
  for (const [key, param] of Object.entries(template.parameters)) {
    const value = Object.hasOwn(supplied, key)
      ? (supplied as Record<string, unknown>)[key]
      : param.default;
    const max = key === 'dueDays' ? 7 : 365;
    if (
      param.type === 'text'
        ? typeof value !== 'string' || !value.trim() || value.length > 4000
        : typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max
    )
      throw new Error('Invalid template parameter ' + key);
    parameters[key] = value as string | number;
  }
  const nodes = template.nodes(parameters);
  const trigger = structuredClone(template.trigger);
  if (trigger.kind === 'event' && trigger.threshold !== undefined)
    trigger.threshold = Number(parameters.days);
  const definition: WorkflowDefinition = {
    id: definitionId,
    version: 1,
    inputs: Object.fromEntries(Object.keys(template.fixture).map((name) => [name, 'string'])),
    nodes: [
      { id: 'trigger', kind: 'trigger', trigger: trigger.kind as TriggerKind, next: nodes[0].id },
      ...nodes,
    ],
  };
  return { definition, trigger, fixture: structuredClone(template.fixture), parameters };
}
