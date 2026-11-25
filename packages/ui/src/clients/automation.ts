import type {
  Approval,
  MessagePreview,
  PurchaseOrderDraft,
  RunWorkflowTemplateResult,
  ToolResult,
} from '@bs/contracts';
import { PlatformError, unwrapTool } from '../platform-client.ts';
import type { RequestJson } from '../platform-client.ts';
import { sseData } from './sse.ts';
import type { WorkflowDefinition, WorkflowTarget, WorkflowStep } from './workflow-definition.ts';

export interface BotDefinition {
  id: string;
  version: number;
  allowedTools: string[];
  maxActions: number;
  maxSeconds: number;
}

export interface BotStart {
  botId: string;
  version: number;
  sessionId: string;
  prompt: string;
  route: 'native' | 'byo';
}

export interface BotRun {
  id: string;
  botId: string;
  version: number;
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
  pending: {
    approval: Approval;
    draft?: PurchaseOrderDraft;
    previews?: MessagePreview[];
    materialPreview?: unknown;
  } | null;
}

export interface BotEvent {
  id: number;
  kind: string;
  runId: string;
  stepId?: string;
  tool?: string;
  state?: string;
  status?: string;
  delta?: string;
}

export interface WorkflowRun {
  id: string;
  definitionId: string;
  version: number;
  status: string;
  nodeId: string | null;
  dueAt: number | null;
  approval: Approval | null;
  result: ToolResult | null;
  replayable: boolean;
}

export interface WorkflowHistory extends WorkflowRun {
  history: {
    id: number;
    at: number;
    kind: string;
    nodeId: string | null;
    state?: string;
    status?: string;
  }[];
}

export interface WorkflowApproval {
  approval: Approval;
  previews?: MessagePreview[];
  result?: ToolResult;
}

export interface WorkflowPreview {
  steps: WorkflowStep[];
  messages: MessagePreview[];
}

export interface AutomationClient {
  listBots(): Promise<BotDefinition[]>;
  startBot(input: BotStart, key: string): Promise<BotRun>;
  getBotRun(id: string): Promise<BotRun>;
  streamBot(id: string, after: number, signal: AbortSignal): AsyncIterable<BotEvent>;
  resumeBot(id: string, approvalId: string): Promise<BotRun>;
  cancelBot(id: string): Promise<BotRun>;
  listDefinitions(): Promise<WorkflowDefinition[]>;
  publish(definition: WorkflowDefinition): Promise<WorkflowDefinition>;
  preview(target: WorkflowTarget): Promise<WorkflowPreview>;
  previewMessages(): Promise<MessagePreview[]>;
  startWorkflow(target: WorkflowTarget, key: string): Promise<WorkflowRun>;
  listWorkflowRuns(): Promise<WorkflowRun[]>;
  getWorkflowHistory(id: string): Promise<WorkflowHistory>;
  listDeadLetters(): Promise<WorkflowRun[]>;
  replayWorkflow(id: string): Promise<WorkflowRun>;
  listWorkflowApprovals(): Promise<WorkflowApproval[]>;
  approveWorkflow(id: string): Promise<void>;
}

export class HttpAutomationClient implements AutomationClient {
  private readonly request: RequestJson;
  private readonly openStream: (path: string, init: RequestInit) => Promise<Response>;

  constructor(request: RequestJson, openStream: HttpAutomationClient['openStream']) {
    this.request = request;
    this.openStream = openStream;
  }

  listBots() {
    return this.request<BotDefinition[]>('/automation/bots');
  }
  startBot(input: BotStart, key: string) {
    return this.request<BotRun>('/automation/bots/runs', 'POST', input, { 'Idempotency-Key': key });
  }
  getBotRun(id: string) {
    return this.request<BotRun>(botPath(id));
  }

  async *streamBot(id: string, after: number, signal: AbortSignal) {
    const response = await this.openStream(botPath(id) + '/events', {
      signal,
      headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(after) },
    });
    for await (const data of sseData(response, signal)) {
      const event = JSON.parse(data) as BotEvent;
      if (event.runId === id && Number.isSafeInteger(event.id) && event.id > after) {
        after = event.id;
        yield event;
      }
    }
  }

  resumeBot(id: string, approvalId: string) {
    return this.request<BotRun>(botPath(id) + '/resume', 'POST', { approvalId });
  }
  cancelBot(id: string) {
    return this.request<BotRun>(botPath(id) + '/cancel', 'POST');
  }
  listDefinitions() {
    return this.request<WorkflowDefinition[]>('/automation/workflows/definitions');
  }
  publish(definition: WorkflowDefinition) {
    return this.request<WorkflowDefinition>(
      '/automation/workflows/definitions',
      'POST',
      definition,
    );
  }
  async preview(target: WorkflowTarget) {
    const steps = await this.request<WorkflowStep[]>(
      '/automation/workflows/preview',
      'POST',
      target,
    );
    const messages = steps.some(({ tool }) => tool === 'workflow.template.run')
      ? await this.previewMessages()
      : [];
    return { steps, messages };
  }
  async previewMessages() {
    const result = await this.request<RunWorkflowTemplateResult>(
      '/automation/workflows/win-back-v1',
      'POST',
      {
        mode: 'preview',
      },
    );
    if (result.state !== 'ok') return unwrapTool(result) as never;
    if (result.output.status !== 'previewed' || result.output.receipts.length) {
      throw new PlatformError('unavailable');
    }
    return result.output.previews;
  }
  startWorkflow(target: WorkflowTarget, key: string) {
    return this.request<WorkflowRun>('/automation/workflows/runs', 'POST', target, {
      'Idempotency-Key': key,
    });
  }
  listWorkflowRuns() {
    return this.request<WorkflowRun[]>('/automation/workflows/runs');
  }
  getWorkflowHistory(id: string) {
    return this.request<WorkflowHistory>(workflowPath(id) + '/history');
  }
  listDeadLetters() {
    return this.request<WorkflowRun[]>('/automation/workflows/dead-letters');
  }
  replayWorkflow(id: string) {
    return this.request<WorkflowRun>(workflowPath(id) + '/replay', 'POST');
  }
  async listWorkflowApprovals() {
    const items = await this.request<WorkflowApproval[]>('/automation/approvals');
    return items.filter(({ approval }) => approval.tool === 'workflow.template.run');
  }
  async approveWorkflow(id: string) {
    const result = await this.request<ToolResult>('/automation/approvals/approve', 'POST', {
      approvalId: id,
    });
    if (result.state !== 'pending_approval') unwrapTool(result);
  }
}

function botPath(id: string) {
  return '/automation/bots/runs/' + encodeURIComponent(id);
}

function workflowPath(id: string) {
  return '/automation/workflows/runs/' + encodeURIComponent(id);
}
