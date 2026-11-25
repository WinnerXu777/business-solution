import { randomUUID } from 'node:crypto';
import { createAutomationClient } from './automation.ts';
import { createConnectorsClient } from './connectors.ts';
import { createPlatformClient, type ListPlatformAuditRequest } from './generated/platform.ts';
import { createToolsClient } from './generated/tools.ts';
import { HttpClient, type Auth, type CallOptions, type ClientOptions } from './http.ts';
import { createLlmClient } from './llm.ts';
import { createMcpClient } from './mcp.ts';
import { paginate, paginatePages } from './pagination.ts';

export type * as Contracts from './generated/contracts.ts';
export type * as Platform from './generated/platform.ts';
export type { ToolInput, ToolName, ToolRequests, ToolResults } from './generated/tools.ts';
export { isToolName, toolNames } from './generated/tools.ts';
export { ApiError, DenialError, ToolFailure, UnknownOutcome } from './errors.ts';
export type { ToolSuccess } from './errors.ts';
export type { Auth, CallOptions, ClientOptions, Fetch } from './http.ts';
export type {
  BotEvent,
  BotRun,
  BotStart,
  WorkflowDefinition,
  WorkflowPreview,
  WorkflowRun,
  WorkflowTarget,
} from './automation.ts';
export type { ConnectorManifest, ConnectorReport, PollResult, SyncRequest } from './connectors.ts';
export type {
  ChatChunk,
  ChatCompletion,
  ChatMessage,
  ChatRequest,
  ChatStreamRequest,
  EmbeddingRequest,
  EmbeddingResponse,
  LlmToolCall,
  ModelCatalog,
} from './llm.ts';
export type { McpInitialization, McpToolList, McpToolResult } from './mcp.ts';
export { McpError } from './mcp.ts';
export { paginate, paginatePages, type CursorPage } from './pagination.ts';
export { parseSse, type SseEvent } from './sse.ts';
export { verifyWebhookSignature } from './webhooks.ts';

export type BsClientOptions = ClientOptions & {
  llm?: { baseUrl?: string; auth?: Auth };
  connectors?: { baseUrl?: string; auth?: Auth };
};

type AuditArgs = NonNullable<ListPlatformAuditRequest['query']>;

export function createClient(options: BsClientOptions) {
  const http = new HttpClient(options);
  const llmHttp = new HttpClient({ ...options, ...options.llm });
  const connectorHttp = new HttpClient({ ...options, ...options.connectors });
  const platform = createPlatformClient(http);
  const tools = createToolsClient(http, async (callOptions) => {
    const { tenant, actor } = await platform.getPlatformIdentity({
      options: { signal: callOptions?.signal },
    });
    const traceId = randomUUID();
    return {
      version: 'v1',
      tenantId: tenant.id,
      actor: { id: actor.id, kind: actor.kind },
      source: 'rest',
      traceId,
      correlationId: traceId,
      idempotencyKey: callOptions?.idempotencyKey ?? randomUUID(),
    };
  });

  const recordReads = {
    order: (id: string, opts?: CallOptions) => tools.readOrder({ orderId: id }, opts),
    customer: (id: string, opts?: CallOptions) => tools.readCustomer({ customerId: id }, opts),
    invoice: (id: string, opts?: CallOptions) => tools.readInvoice({ invoiceId: id }, opts),
    'purchase-request': (id: string, opts?: CallOptions) =>
      tools.readPurchaseRequest({ requestId: id }, opts),
  };
  type Reads = typeof recordReads;
  type RecordResult<Kind extends RecordKind> = Awaited<ReturnType<Reads[Kind]>>;
  function getRecord<Kind extends RecordKind>(kind: Kind, id: string, opts?: CallOptions) {
    return recordReads[kind](id, opts) as Promise<RecordResult<Kind>>;
  }
  const loadAuditPage = (query: AuditArgs, options?: CallOptions) => (cursor?: string) =>
    platform.listPlatformAudit({ query: { ...query, cursor }, options });

  return {
    platform: {
      ...platform,
      auditPages: (query: AuditArgs = {}, options?: CallOptions) =>
        paginatePages(loadAuditPage(query, options), query.cursor),
      auditEntries: (query: AuditArgs = {}, options?: CallOptions) =>
        paginate(loadAuditPage(query, options), query.cursor),
    },
    records: {
      get: getRecord,
      async *list<Kind extends RecordKind>(
        kind: Kind,
        ids: Iterable<string>,
        opts?: Pick<CallOptions, 'signal'>,
      ) {
        for (const id of ids) yield await getRecord(kind, id, opts);
      },
    },
    tools,
    mcp: createMcpClient(http),
    automation: createAutomationClient(http),
    llm: createLlmClient(llmHttp),
    connectors: createConnectorsClient(connectorHttp),
  };
}

export type RecordKind = 'order' | 'customer' | 'invoice' | 'purchase-request';
export type BsClient = ReturnType<typeof createClient>;
