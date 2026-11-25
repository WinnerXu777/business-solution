import type { ProviderAdapters } from '@bs/adapters';
import {
  type CallEnvelope,
  type DemoFixtures,
  type Denied,
  type MessageChannel,
  type MessagePreview,
  type PurchaseOrder,
  type PurchaseOrderDraft,
  type ToolCall,
  type ToolInputMap,
  type ToolResult,
} from '@bs/contracts';
import type { RecordRepository } from '../../../business/src/persistence/index.ts';
import { ApprovalLedger, type ApprovalIntent } from './approvals.ts';
import {
  denied,
  digest,
  invalidInput,
  lookup,
  ok,
  unavailable,
  unknownOutcome,
} from './results.ts';

export interface Execution {
  envelope: CallEnvelope;
  actionId: string;
  policyVersion: string;
  now: () => string;
  authorizeEffect: () => Denied | undefined;
  approverId: string | undefined;
}

function pendingOrDenied(approval: ReturnType<ApprovalLedger['prepare']>): ToolResult {
  return 'code' in approval ? approval : { state: 'pending_approval', approval };
}

export function createToolHandlers(
  records: RecordRepository,
  approvals: ApprovalLedger,
  fixtures: DemoFixtures,
  providers?: Partial<ProviderAdapters>,
) {
  const drafts = new Map<string, PurchaseOrderDraft>();
  const previews = new Map<string, MessagePreview>();

  function prepare(context: Execution, intent: ApprovalIntent) {
    const { envelope, approverId, policyVersion, now } = context;
    return approverId
      ? approvals.prepare(envelope, intent, approverId, policyVersion, now())
      : denied('forbidden');
  }

  async function approvedEffect(
    context: Execution,
    intent: ApprovalIntent,
    target: string,
    approvalId: string | null,
    effect: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    const { envelope, actionId, policyVersion, now } = context;
    const blocked = context.authorizeEffect();
    if (blocked) return blocked;
    const held = approvals.getHold(envelope.tenantId, intent.tool, target);
    if (held) return held;
    if (approvalId === null) return pendingOrDenied(prepare(context, intent));
    if (!approvals.consume(envelope, intent, approvalId, policyVersion, now())) {
      return denied('invalid_approval');
    }
    let result;
    try {
      result = await effect();
    } catch {
      result = unknownOutcome(actionId);
    }
    if (result.state === 'unknown') {
      result = unknownOutcome(actionId);
      approvals.hold(envelope.tenantId, intent.tool, target, result);
    }
    return result;
  }

  async function buildDraft(tenantId: string, requestId: string) {
    const request = await records.get('purchaseRequests', tenantId, requestId);
    if (!request) return;
    const { id, version, ...fields } = request;
    return {
      ...fields,
      id: 'draft-' + digest(request),
      requestId: id,
      sourceVersion: version,
    };
  }

  function poIntent(draft: PurchaseOrderDraft): ApprovalIntent {
    return {
      tool: 'purchase.order.approve',
      subjectId: draft.id,
      sourceVersion: draft.sourceVersion,
      material: draft,
    };
  }

  async function invoicePreview(tenantId: string, invoiceId: string, channel: MessageChannel) {
    const invoice = await records.get('invoices', tenantId, invoiceId);
    if (!invoice) return denied('not_found');
    const customer = await records.get('customers', tenantId, invoice.customerId);
    if (!customer) return denied('not_found');
    if (!customer.outreachAllowed || invoice.balanceCents <= 0 || invoice.status !== 'overdue') {
      return denied('suppressed');
    }
    const material = {
      tenantId,
      channel,
      customerId: customer.id,
      customerVersion: customer.version,
      recipient: channel === 'email' ? customer.email : customer.phone,
      sourceId: invoice.id,
      sourceVersion: invoice.version,
      subject: channel === 'email' ? 'Fixture invoice reminder' : null,
      body:
        channel === 'email'
          ? 'Test reminder for invoice ' + invoice.id + '. Check the fictional account portal.'
          : 'This is a simulation. Check the fictional account portal for a message.',
    };
    return ok({ id: 'preview-' + digest([material, invoice.balanceCents]), ...material });
  }

  async function preview(tenantId: string, invoiceId: string, channel: MessageChannel) {
    const result = await invoicePreview(tenantId, invoiceId, channel);
    if (result.state === 'ok') previews.set(result.output.id, result.output);
    return result;
  }

  async function send(
    context: Execution,
    tool: `collections.${MessageChannel}.send`,
    channel: MessageChannel,
    input: ToolInputMap[typeof tool],
  ): Promise<ToolResult> {
    const { tenantId } = context.envelope;
    const prior = previews.get(input.previewId);
    if (!prior || prior.tenantId !== tenantId || prior.channel !== channel)
      return denied('not_found');
    const current = await invoicePreview(tenantId, prior.sourceId, channel);
    if (current.state !== 'ok') return current;
    if (current.output.id !== prior.id) return denied('invalid_approval');
    const adapter = providers?.messages?.[channel];
    if (input.approvalId !== null && !adapter) return unavailable();
    return approvedEffect(
      context,
      {
        tool,
        subjectId: prior.id,
        material: current.output,
        sourceVersion: current.output.sourceVersion,
      },
      prior.sourceId,
      input.approvalId,
      async () => {
        if (!adapter) return unavailable();
        const receipt = await adapter.send(structuredClone(current.output), context.actionId);
        return 'state' in receipt ? receipt : ok(receipt);
      },
    );
  }

  async function workflow(context: Execution, input: ToolInputMap['workflow.template.run']) {
    const { tenantId } = context.envelope;
    const { templateId } = input;
    const runId = 'run-' + context.actionId;
    const messages = (await records.listCustomers(tenantId))
      .filter((customer) => customer.lastOrderOn < '2026-06-01' && customer.outreachAllowed)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(
        (customer): MessagePreview => ({
          id: 'win-back-' + digest([tenantId, customer.id, customer.version]),
          tenantId,
          channel: 'email',
          customerId: customer.id,
          customerVersion: customer.version,
          recipient: customer.email,
          sourceId: customer.id,
          sourceVersion: customer.version,
          subject: 'Fixture win-back',
          body: 'Test message from Rivetquay.',
        }),
      );
    if (input.mode === 'preview') {
      return ok({
        runId,
        templateId,
        status: 'previewed' as const,
        previews: messages,
        receipts: [],
      });
    }
    const adapter = providers?.messages?.email;
    if (input.approvalId !== null && !adapter) return unavailable();
    return approvedEffect(
      context,
      {
        tool: 'workflow.template.run',
        subjectId: templateId,
        material: messages,
        sourceVersion: 1,
      },
      templateId,
      input.approvalId,
      async () => {
        if (!adapter) return unavailable();
        const receipts = [];
        for (const [index, message] of messages.entries()) {
          const result = await adapter.send(
            structuredClone(message),
            context.actionId + '-' + index,
          );
          if ('state' in result) {
            return index === 0 ? result : unknownOutcome(context.actionId);
          }
          receipts.push(result);
        }
        return ok({
          runId,
          templateId,
          status: 'simulated' as const,
          previews: messages,
          receipts,
        });
      },
    );
  }

  function acceptsRoute(route: DemoFixtures['llmRoutes'][number]) {
    return (
      route.fixtureMode &&
      fixtures.llmRoutes.some(
        (allowed) => allowed.kind === route.kind && allowed.providerId === route.providerId,
      )
    );
  }

  return async function dispatch(request: ToolCall, context: Execution): Promise<ToolResult> {
    const { tenantId } = request.envelope;
    const { input, tool } = request;
    switch (tool) {
      case 'order.read':
        return lookup(await records.get('orders', tenantId, input.orderId));
      case 'customer.read':
        return lookup(await records.get('customers', tenantId, input.customerId));
      case 'invoice.read':
        return lookup(await records.get('invoices', tenantId, input.invoiceId));
      case 'purchase.request.read':
        return lookup(await records.get('purchaseRequests', tenantId, input.requestId));
      case 'purchase.order.draft': {
        const draft = await buildDraft(tenantId, input.requestId);
        if (!draft) return denied('not_found');
        const vendor = await records.get('vendors', tenantId, draft.vendorId);
        const skus = await Promise.all(
          draft.lines.map((line) => records.get('skus', tenantId, line.skuId)),
        );
        if (!vendor || skus.some((sku) => !sku)) return denied('not_found');
        const approval = prepare(context, poIntent(draft));
        if ('code' in approval) return approval;
        drafts.set(draft.id, draft);
        return ok({ draft, approval });
      }
      case 'purchase.order.approve': {
        const stored = drafts.get(input.draftId);
        if (stored?.tenantId !== tenantId) return denied('not_found');
        const current = await buildDraft(tenantId, stored.requestId);
        if (current?.id !== stored.id) return denied('invalid_approval');

        return approvedEffect(
          context,
          poIntent(current),
          current.requestId,
          input.approvalId,
          async () => {
            const po: PurchaseOrder = {
              id: 'po-' + digest([tenantId, current.requestId]),
              draft: current,
              approvalId: input.approvalId,
              status: 'approved',
            };
            return (await records.createPurchaseOrder(structuredClone(po)))
              ? ok(po)
              : denied('invalid_approval');
          },
        );
      }
      case 'collections.email.draft':
        return preview(tenantId, input.invoiceId, 'email');
      case 'message.preview':
        return preview(tenantId, input.invoiceId, input.channel);
      case 'collections.email.send':
        return send(context, tool, 'email', input);
      case 'collections.voice.send':
        return send(context, tool, 'voice', input);
      case 'collections.sms.send':
        return send(context, tool, 'sms', input);
      case 'workflow.template.run':
        return workflow(context, input);
      case 'fraud.score': {
        const order = await records.get('orders', tenantId, input.orderId);
        if (!order) return denied('not_found');
        return providers?.scoring ? ok(await providers.scoring.fraud(order)) : unavailable();
      }
      case 'forecast.run':
        if ((input.series === 'sku_demand') !== (input.skuId !== null)) {
          return invalidInput('SKU is required only for SKU demand.');
        }
        if (input.skuId && !(await records.get('skus', tenantId, input.skuId)))
          return denied('not_found');
        return providers?.scoring ? ok(await providers.scoring.forecast(input)) : unavailable();
      case 'profile.run': {
        const customer = await records.get('customers', tenantId, input.customerId);
        if (!customer) return denied('not_found');
        return providers?.scoring ? ok(await providers.scoring.profile(customer)) : unavailable();
      }
      case 'chat.run': {
        if (!acceptsRoute(input.route)) return denied('forbidden');
        const audio = fixtures.audio.find((fixture) => fixture.id === input.audioFixtureId);
        if (input.audioFixtureId && !audio) return denied('not_found');
        if (input.orderId && audio && input.orderId !== audio.orderId) {
          return invalidInput('Fixture order mismatch.');
        }
        const orderId = input.orderId ?? audio?.orderId;
        const order = orderId ? await records.get('orders', tenantId, orderId) : null;
        if (order === undefined) return denied('not_found');
        if (!providers?.llm) return unavailable();
        const completion = await providers.llm.complete({
          model: 'fixture-chat',
          turns: input.turns,
          maxOutputTokens: 24,
          route: input.route,
        });
        return ok({
          sessionId: input.sessionId,
          reply: completion.text,
          order,
          handoff: order === null,
        });
      }
      case 'llm.complete':
        if (!acceptsRoute(input.route)) return denied('forbidden');
        return providers?.llm ? ok(await providers.llm.complete(input)) : unavailable();
    }
  };
}
