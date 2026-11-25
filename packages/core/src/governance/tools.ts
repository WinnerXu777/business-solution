import type { ProviderAdapters } from '@bs/adapters';
import type { RecordRepository } from '@bs/business';
import type {
  ApprovalAction,
  CallEnvelope,
  DemoFixtures,
  MessageChannel,
  MessagePreview,
  ToolCall,
  ToolInputMap,
  ToolResult,
} from '@bs/contracts';
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
import type { Effect, TenantState } from './store.ts';

export interface Execution {
  envelope: CallEnvelope;
  actionId: string;
  policyVersion: string;
  now: string;
  approverId: string | undefined;
  stage: (target: string, approvalId: string, effect: Effect) => void;
}

const channels = {
  'collections.email.send': 'email',
  'collections.voice.send': 'voice',
  'collections.sms.send': 'sms',
} as const;

export function createToolHandlers(
  records: RecordRepository,
  fixtures: DemoFixtures,
  providers?: Partial<ProviderAdapters>,
) {
  async function purchase(tenantId: string, requestId: string) {
    const request = await records.get('purchaseRequests', tenantId, requestId);
    if (!request) return;
    const { id, version, ...fields } = request;
    const draft = {
      ...fields,
      id: 'draft-' + digest(request),
      requestId: id,
      sourceVersion: version,
    };
    const vendor = await records.get('vendors', tenantId, draft.vendorId);
    const skus = await Promise.all(
      draft.lines.map((line) => records.get('skus', tenantId, line.skuId)),
    );
    if (!vendor || skus.some((sku) => !sku)) return;
    const intent: ApprovalIntent = {
      tool: 'purchase.order.approve',
      subjectId: draft.id,
      target: requestId,
      sourceVersion: draft.sourceVersion,
      material: { draft, vendor, skus },
    };
    return { draft, intent };
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

  function messageIntent(preview: MessagePreview): ApprovalIntent {
    return {
      tool: `collections.${preview.channel}.send`,
      subjectId: preview.id,
      target: preview.sourceId,
      sourceVersion: preview.sourceVersion,
      material: preview,
    };
  }

  async function workflowPreviews(tenantId: string): Promise<MessagePreview[]> {
    return (await records.listCustomers(tenantId))
      .filter((customer) => customer.lastOrderOn < '2026-06-01' && customer.outreachAllowed)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((customer) => ({
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
      }));
  }

  function workflowIntent(templateId: string, previews: MessagePreview[]): ApprovalIntent {
    return {
      tool: 'workflow.template.run',
      subjectId: templateId,
      target: templateId,
      material: previews,
      sourceVersion: 1,
    };
  }

  async function currentIntent(tenantId: string, tool: ApprovalAction, target: string) {
    if (tool === 'purchase.order.approve') return (await purchase(tenantId, target))?.intent;
    if (tool === 'workflow.template.run')
      return workflowIntent(target, await workflowPreviews(tenantId));
    const current = await invoicePreview(tenantId, target, channels[tool]);
    if (current.state === 'ok') return messageIntent(current.output);
  }

  function acceptsRoute(route: DemoFixtures['llmRoutes'][number]) {
    return (
      route.fixtureMode &&
      fixtures.llmRoutes.some(
        (allowed) => allowed.kind === route.kind && allowed.providerId === route.providerId,
      )
    );
  }

  async function dispatch(
    request: ToolCall,
    context: Execution,
    state: TenantState,
  ): Promise<ToolResult> {
    const { tenantId } = request.envelope;
    const { tool, input } = request;
    const { envelope, actionId, policyVersion, now, approverId } = context;
    const approvals = new ApprovalLedger(state.rows.approval);

    function prepare(intent: ApprovalIntent) {
      return approverId
        ? approvals.prepare(envelope, intent, approverId, policyVersion, now)
        : denied('forbidden');
    }

    function approvedEffect(
      intent: ApprovalIntent,
      approvalId: string | null,
      effect: Effect,
    ): ToolResult {
      const held = [...state.rows.outbox.values()].find((job) => {
        const staged = state.rows.intent.get(job.id);
        return (
          staged?.request.tool === intent.tool &&
          staged.target === intent.target &&
          (['queued', 'running', 'retryable', 'unknown'].includes(job.status) || job.unresolved)
        );
      });
      if (held) return unknownOutcome(held.id);
      if (approvalId === null) {
        const approval = prepare(intent);
        return 'code' in approval ? approval : { state: 'pending_approval', approval };
      }
      if (!approvals.consume(envelope, intent, approvalId, policyVersion, now))
        return denied('invalid_approval');
      context.stage(intent.target, approvalId, effect);
      return unknownOutcome(actionId);
    }

    async function preview(invoiceId: string, channel: MessageChannel) {
      const result = await invoicePreview(tenantId, invoiceId, channel);
      if (result.state === 'ok') state.rows.artifact.set(result.output.id, result.output);
      return result;
    }

    async function send(
      channel: MessageChannel,
      input: ToolInputMap[`collections.${MessageChannel}.send`],
    ) {
      const prior = state.rows.artifact.get(input.previewId);
      if (!prior || !('channel' in prior) || prior.channel !== channel) return denied('not_found');
      const current = await invoicePreview(tenantId, prior.sourceId, channel);
      if (current.state !== 'ok') return current;
      if (current.output.id !== prior.id) return denied('invalid_approval');
      if (input.approvalId !== null && !providers?.messages?.[channel]) return unavailable();
      return approvedEffect(messageIntent(current.output), input.approvalId, {
        kind: 'message',
        preview: current.output,
      });
    }

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
        const current = await purchase(tenantId, input.requestId);
        if (!current) return denied('not_found');
        const { draft, intent } = current;
        const approval = prepare(intent);
        if ('code' in approval) return approval;
        state.rows.artifact.set(draft.id, draft);
        return ok({ draft, approval });
      }
      case 'purchase.order.approve': {
        const stored = state.rows.artifact.get(input.draftId);
        if (!stored || !('requestId' in stored)) return denied('not_found');
        const current = await purchase(tenantId, stored.requestId);
        if (current?.draft.id !== stored.id) return denied('invalid_approval');
        const { draft, intent } = current;
        return approvedEffect(intent, input.approvalId, {
          kind: 'purchase',
          order: {
            id: 'po-' + digest([tenantId, draft.requestId]),
            draft,
            approvalId: input.approvalId,
            status: 'approved',
          },
        });
      }
      case 'collections.email.draft':
        return preview(input.invoiceId, 'email');
      case 'message.preview':
        return preview(input.invoiceId, input.channel);
      case 'collections.email.send':
      case 'collections.voice.send':
      case 'collections.sms.send':
        return send(channels[tool], input);
      case 'workflow.template.run': {
        const { templateId, mode, approvalId } = input;
        const previews = await workflowPreviews(tenantId);
        if (mode === 'preview') {
          return ok({
            runId: 'run-' + actionId,
            templateId,
            status: 'previewed' as const,
            previews,
            receipts: [],
          });
        }
        if (approvalId !== null && !providers?.messages?.email) return unavailable();
        return approvedEffect(workflowIntent(templateId, previews), approvalId, {
          kind: 'workflow',
          templateId,
          previews,
        });
      }
      case 'fraud.score': {
        const order = await records.get('orders', tenantId, input.orderId);
        if (!order) return denied('not_found');
        return providers?.scoring ? ok(await providers.scoring.fraud(order)) : unavailable();
      }
      case 'forecast.run':
        if (input.series === 'sku_demand' && input.skuId === null) {
          return invalidInput('SKU is required for SKU demand.');
        }
        if (input.skuId !== null && !(await records.get('skus', tenantId, input.skuId)))
          return denied('not_found');
        return providers?.scoring
          ? ok(await providers.scoring.forecast(input, tenantId))
          : unavailable();
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
  }

  return { dispatch, currentIntent };
}
