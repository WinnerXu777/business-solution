import { ApiError, isObject, unwrapTool } from './errors.ts';
import type { Approval, MessagePreview, PurchaseOrderDraft } from './generated/contracts.ts';
import type { ToolResults } from './generated/tools.ts';
import { pathSegment, type CallOptions, type HttpClient } from './http.ts';
import { eventJson, responseEvents } from './sse.ts';

type ToolResult = ToolResults[keyof ToolResults];
export type BotStart = {
  botId: string;
  version: number;
  sessionId: string;
  prompt: string;
  route: 'native' | 'byo';
};
export type BotRun = Pick<BotStart, 'botId' | 'version'> & {
  id: string;
  status:
    | 'queued'
    | 'running'
    | 'pending_approval'
    | 'completed'
    | 'denied'
    | 'failed'
    | 'unknown'
    | 'cancelled';
  result: ToolResult | null;
  pending: { approval: Approval; draft?: PurchaseOrderDraft; previews?: MessagePreview[] } | null;
};
export type BotEvent = {
  id: number;
  kind: string;
  runId: string;
  stepId?: string;
  tool?: string;
  state?: string;
  status?: string;
};
type Scalar = string | number | boolean | null;
type NamedTrigger = { kind: 'schedule' | 'event'; name: string; key: string };
export type WorkflowTarget = {
  definitionId: string;
  version: number;
  input: { trigger: { kind: 'manual' } | NamedTrigger; values?: Record<string, Scalar> };
};
export type WorkflowDefinition = {
  id: string;
  version: number;
  nodes: { id: string; kind: string; [key: string]: unknown }[];
};
export type WorkflowPreview = {
  nodeId: string;
  kind: string;
  tool?: string;
  input?: unknown;
  milliseconds?: number;
}[];
export type WorkflowRun = {
  id: string;
  definitionId: string;
  version: number;
  status:
    | 'running'
    | 'delayed'
    | 'retrying'
    | 'pending_approval'
    | 'completed'
    | 'denied'
    | 'failed'
    | 'unknown';
  nodeId: string | null;
  dueAt: number | null;
  approval: Approval | null;
  result: ToolResult | null;
  replayable: boolean;
};

export function createAutomationClient(http: HttpClient) {
  const botRuns = '/automation/bots/runs';
  const workflows = '/automation/workflows';
  return {
    startBot: (input: BotStart, options?: CallOptions) =>
      http.json<BotRun>(botRuns, { ...options, method: 'POST', body: input, retry: 'keyed' }),
    getBot: (id: string, options?: CallOptions) =>
      http.json<BotRun>(`${botRuns}/${pathSegment(id)}`, options),
    async *streamBot(id: string, options: CallOptions & { after?: string | number } = {}) {
      const headers = new Headers({ accept: 'text/event-stream' });
      if (options.after !== undefined) headers.set('last-event-id', String(options.after));
      const response = await http.requireOk(
        await http.send(`${botRuns}/${pathSegment(id)}/events`, {
          ...options,
          headers,
        }),
      );
      for await (const frame of responseEvents(response)) {
        const data = eventJson(frame.data);
        if (
          !isObject(data) ||
          data.runId !== id ||
          typeof data.kind !== 'string' ||
          !Number.isSafeInteger(data.id) ||
          String(data.id) !== frame.id
        ) {
          throw new ApiError('invalid_bot_event');
        }
        yield data as BotEvent;
      }
    },
    listWorkflows: (options?: CallOptions) =>
      http.json<WorkflowDefinition[]>(workflows + '/definitions', options),
    previewWorkflow: (input: WorkflowTarget, options?: CallOptions) =>
      http.json<WorkflowPreview>(workflows + '/preview', {
        ...options,
        method: 'POST',
        body: input,
      }),
    runWorkflow: (input: WorkflowTarget, options?: CallOptions) =>
      http.json<WorkflowRun>(workflows + '/runs', {
        ...options,
        method: 'POST',
        body: input,
        retry: 'keyed',
      }),
    approveWorkflow: async (approvalId: string, options?: CallOptions) =>
      unwrapTool(
        await http.json<ToolResult>('/automation/approvals/approve', {
          ...options,
          method: 'POST',
          body: { approvalId },
        }),
      ),
  };
}
