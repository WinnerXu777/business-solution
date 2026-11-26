import { canOperate, canReview, PlatformError } from '../platform-client.ts';
import type { PlatformIdentity } from '../platform-client.ts';
import type {
  AccountEvent,
  BotPoliciesClient,
  BotPolicyMap,
  CommitmentInput,
  PaymentPlan,
  ProcurementException,
  PromiseToPay,
} from './bot-policies.ts';
import type { OpsClient } from './ops.ts';
import type {
  InstalledWorkflow,
  TemplateValues,
  WorkflowManagementClient,
  WorkflowTemplate,
  WorkflowTrigger,
} from './workflow-management.ts';
import {
  validId,
  validateWorkflow,
  winBackWorkflow,
  workflowEdges,
} from './workflow-definition.ts';
import type { WorkflowDefinition } from './workflow-definition.ts';
import { findEntry, requireAccess } from './mock-compliance.ts';

export class MockOperationsState {
  readonly tenants = new Map<string, ReturnType<typeof seedOperations>>();
}

function seedOperations(demo: boolean) {
  const policy: BotPolicyMap = {
    procurement: {
      authorityLimitCents: 2500000,
      approvalThresholdCents: 500000,
      preferredVendorIds: demo ? ['vendor-002'] : [],
    },
    collections: {
      cadenceDays: { '1-30': 14, '31-60': 10, '61-90': 7, '91+': 7 },
      channels: ['email'],
      contactWindow: { start: '09:00', end: '17:00', timeZone: 'America/Toronto' },
    },
  };
  const exceptions: ProcurementException[] = demo
    ? [{ id: 'exception-001', poId: 'po-001', reason: 'quantity_mismatch', status: 'open' }]
    : [];
  const promises: PromiseToPay[] = [];
  const plans: PaymentPlan[] = [];
  const templates: WorkflowTemplate[] = demo
    ? [
        {
          id: 'order-lookup-v1',
          name: 'Order lookup',
          description: 'Look up a seeded order without dispatching a message.',
          parameters: [
            {
              key: 'workflowId',
              label: 'Workflow ID',
              defaultValue: 'order-lookup',
              required: true,
            },
            { key: 'orderId', label: 'Order ID', defaultValue: 'ord-001', required: true },
          ],
        },
      ]
    : [];
  const drafts = new Map<string, InstalledWorkflow>();
  const triggers: WorkflowTrigger[] = demo
    ? [
        {
          id: 'trigger-001',
          workflowId: 'win-back-v1',
          kind: 'cron',
          cron: '0 10 * * 1',
          timeZone: 'America/Toronto',
          paused: true,
        },
        {
          id: 'trigger-002',
          workflowId: 'order-follow-up',
          kind: 'event',
          event: 'record.changed',
          paused: false,
        },
        {
          id: 'trigger-003',
          workflowId: 'order-follow-up',
          kind: 'webhook',
          webhookId: 'hook-001',
          paused: true,
        },
      ]
    : [];
  return { policy, exceptions, promises, plans, templates, drafts, triggers, sequence: 0 };
}

export function createMockOperations(
  me: PlatformIdentity,
  now: string,
  state: MockOperationsState,
): {
  botPolicies: BotPoliciesClient;
  workflowManagement: WorkflowManagementClient;
  ops: OpsClient;
} {
  const demo = me.tenant.id === 'tenant-rivetquay';
  let tenant = state.tenants.get(me.tenant.id);
  if (!tenant) {
    tenant = seedOperations(demo);
    state.tenants.set(me.tenant.id, tenant);
  }
  const rows = tenant;
  const operate = () => requireAccess(canOperate(me.role));
  function knownAccount(customerId: string) {
    if (!demo || !['cust-001', 'cust-002'].includes(customerId))
      throw new PlatformError('not_found');
  }
  function checkCommitment(input: CommitmentInput) {
    knownAccount(input.customerId);
    if (
      !Number.isSafeInteger(input.amountCents) ||
      input.amountCents <= 0 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.dueOn)
    )
      throw new PlatformError('invalid_input');
  }
  function preview(id: string, parameters: TemplateValues) {
    findEntry(rows.templates, id);
    if (!validId(parameters.workflowId) || !validId(parameters.orderId))
      throw new PlatformError('invalid_input');
    const definition: WorkflowDefinition = {
      id: parameters.workflowId,
      version: 1,
      nodes: [
        { id: 'start', kind: 'trigger', trigger: 'manual', next: 'lookup' },
        {
          id: 'lookup',
          kind: 'action',
          action: { tool: 'order.read', orderId: parameters.orderId },
        },
      ],
    };
    return { definition };
  }
  const operator = () => requireAccess(me.platformOperator);
  const checks = [
    { service: 'platform-api', status: 'ok' as const },
    { service: 'postgres', status: 'ok' as const },
    { service: 'outbox', status: 'degraded' as const, detail: 'Fixture queue delay' },
  ];
  return {
    botPolicies: {
      async getPolicy(botId) {
        return structuredClone(rows.policy[botId]);
      },
      async savePolicy(botId, input) {
        requireAccess(me.role === 'admin');
        rows.policy[botId] = structuredClone(input);
        return structuredClone(input);
      },
      async listExceptions() {
        return structuredClone(rows.exceptions);
      },
      async getMatch(poId) {
        if (!demo || poId !== 'po-001') throw new PlatformError('not_found');
        return {
          poId,
          receiptId: 'receipt-001',
          invoiceId: 'vendor-invoice-001',
          lines: [
            {
              skuId: 'sku-001',
              ordered: 24,
              received: 20,
              invoiced: 24,
              unitPriceCents: 1299,
              invoiceUnitPriceCents: 1299,
            },
          ],
        };
      },
      async accountTimeline(customerId) {
        knownAccount(customerId);
        const opening: AccountEvent[] =
          customerId === 'cust-001'
            ? [
                {
                  id: 'timeline-001',
                  kind: 'invoice',
                  at: now,
                  referenceId: 'inv-001',
                  amountCents: 125000,
                },
              ]
            : [];
        return [
          ...opening,
          ...rows.promises
            .filter((row) => row.customerId === customerId)
            .map((row) => ({
              id: row.id,
              kind: 'promise' as const,
              at: now,
              referenceId: row.id,
              amountCents: row.amountCents,
            })),
          ...rows.plans
            .filter((row) => row.customerId === customerId)
            .map((row) => ({
              id: row.id,
              kind: 'plan' as const,
              at: now,
              referenceId: row.id,
              amountCents: row.amountCents,
            })),
        ];
      },
      async listPromises() {
        return structuredClone(rows.promises);
      },
      async createPromise(input) {
        operate();
        checkCommitment(input);
        const row: PromiseToPay = { ...input, id: 'promise-' + ++rows.sequence, status: 'open' };
        rows.promises.push(row);
        return structuredClone(row);
      },
      async listPaymentPlans() {
        return structuredClone(rows.plans);
      },
      async createPaymentPlan(input) {
        operate();
        checkCommitment(input);
        if (!Number.isInteger(input.installments) || input.installments < 2)
          throw new PlatformError('invalid_input');
        const row: PaymentPlan = {
          ...input,
          id: 'plan-' + ++rows.sequence,
          status: 'pending_approval',
          requestedBy: me.actor.id,
        };
        rows.plans.push(row);
        return structuredClone(row);
      },
      async approvePaymentPlan(id) {
        requireAccess(canReview(me.role));
        const row = findEntry(rows.plans, id);
        requireAccess(row.requestedBy !== me.actor.id);
        row.status = 'approved';
        return structuredClone(row);
      },
    },
    workflowManagement: {
      async listTemplates() {
        return structuredClone(rows.templates);
      },
      async previewTemplate(id, parameters) {
        return preview(id, parameters);
      },
      async installTemplate(id, parameters) {
        operate();
        const row: InstalledWorkflow = { ...preview(id, parameters), status: 'draft' };
        if (rows.drafts.has(row.definition.id) || row.definition.id === winBackWorkflow.id)
          throw new PlatformError('idempotency_conflict');
        rows.drafts.set(row.definition.id, row);
        return structuredClone(row);
      },
      async getDraft(id) {
        const row = rows.drafts.get(id);
        if (!row) throw new PlatformError('not_found');
        return structuredClone(row);
      },
      async listTriggers() {
        return structuredClone(rows.triggers);
      },
      async setTriggerPaused(id, paused) {
        operate();
        const row = findEntry(rows.triggers, id);
        row.paused = paused;
        return structuredClone(row);
      },
      async validate(definition) {
        const message = validateWorkflow(definition);
        const ids = new Set(definition.nodes.map(({ id }) => id));
        const issues = definition.nodes.flatMap((node) =>
          (node.kind !== 'action' && !node.next) ||
          workflowEdges(node).some(({ target }) => !ids.has(target))
            ? [{ nodeId: node.id, message: 'Connect to an existing node.' }]
            : [],
        );
        return { issues: issues.length ? issues : message ? [{ message }] : [] };
      },
      async diff(id, fromVersion, toVersion) {
        if (
          !demo ||
          id !== winBackWorkflow.id ||
          ![1, 2].includes(fromVersion) ||
          ![1, 2].includes(toVersion)
        )
          throw new PlatformError('not_found');
        const node = winBackWorkflow.nodes.at(-1)!;
        const versions = { 1: node, 2: { ...node, maxAttempts: 2 } };
        return {
          workflowId: id,
          fromVersion,
          toVersion,
          changes:
            fromVersion === toVersion
              ? []
              : [
                  {
                    nodeId: node.id,
                    before: versions[fromVersion as 1 | 2],
                    after: versions[toVersion as 1 | 2],
                  },
                ],
        };
      },
    },
    ops: {
      async health() {
        operator();
        return { status: 'degraded', checks: structuredClone(checks) };
      },
      async readiness() {
        operator();
        return { ready: true, checks: structuredClone(checks.slice(0, 2)) };
      },
      async metrics() {
        operator();
        return {
          slos: [
            { name: 'Platform availability', window: '1h', burnRate: 1.4, target: 0.999 },
            { name: 'Outbox latency', window: '6h', burnRate: 3.5, target: 0.99 },
          ],
        };
      },
      async alerts() {
        operator();
        return [
          {
            id: 'alert-001',
            service: 'outbox',
            severity: 'warning',
            summary: 'Fixture queue delay',
            startedAt: now,
          },
        ];
      },
    },
  };
}
