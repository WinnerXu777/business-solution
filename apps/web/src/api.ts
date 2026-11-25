import { createContext, useContext } from 'react';
import type { BotRun } from '@bs/ui';
import type {
  Approval,
  LlmRoute,
  MessageChannel,
  MessagePreview,
  PurchaseOrderDraft,
  ReadOrderResult,
  RunChatResult,
  RunWorkflowTemplateOutput,
  ToolResult,
} from '@bs/contracts';

export type RouteKind = LlmRoute['kind'];
export type ApprovalItem = {
  approval: Approval;
  draft?: PurchaseOrderDraft;
  previews?: MessagePreview[];
  result?: ToolResult;
};
export type WorkflowRun = Pick<RunWorkflowTemplateOutput, 'previews' | 'receipts'> & {
  id: string;
  mode: 'preview' | 'run';
  status:
    | RunWorkflowTemplateOutput['status']
    | 'pending_approval'
    | 'denied'
    | 'failed'
    | 'unknown';
};

export function createAutomationClient(baseUrl: string, token: string) {
  async function request<Result>(path: string, body?: object): Promise<Result> {
    const response = await fetch(baseUrl.replace(/\/+$/, '') + '/automation' + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
        ...(body
          ? { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }
          : {}),
      },
      body: body && JSON.stringify(body),
    });
    if (!response.ok) throw new Error('The automation service could not complete the request.');
    return response.json();
  }

  return {
    botRuns: () => request<BotRun[]>('/bots/runs'),
    botApprovals: () =>
      request<{ runId: string; pending: NonNullable<BotRun['pending']> }[]>('/bots/approvals'),
    order: (orderId: string) => request<ReadOrderResult>('/orders/' + encodeURIComponent(orderId)),
    chat: (sessionId: string, prompt: string, route: RouteKind) =>
      request<RunChatResult>('/chat', { sessionId, prompt, route }),
    voice: (sessionId: string, route: RouteKind) =>
      request<{ transcript: string | null; result: RunChatResult }>('/voice', {
        sessionId,
        route,
        fixtureId: 'audio-order-001',
      }),
    draftPo: (requestId: string) => request<ToolResult>('/purchase-orders/draft', { requestId }),
    preview: (invoiceId: string, channel: MessageChannel) =>
      request<ToolResult>('/collections/preview', { invoiceId, channel }),
    requestMessage: (invoiceId: string, channel: MessageChannel) =>
      request<ToolResult>('/collections/request', { invoiceId, channel }),
    approvals: () => request<ApprovalItem[]>('/approvals'),
    approve: (approvalId: string) => request<ToolResult>('/approvals/approve', { approvalId }),
    workflow: (mode: WorkflowRun['mode']) =>
      request<ToolResult>('/workflows/win-back-v1', { mode }),
    history: () => request<WorkflowRun[]>('/workflows/history'),
  };
}

export const AutomationContext = createContext<ReturnType<typeof createAutomationClient> | null>(
  null,
);

export function useAutomation() {
  const client = useContext(AutomationContext);
  if (!client) throw new Error('Automation session required.');
  return client;
}
