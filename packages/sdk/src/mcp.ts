import { ApiError, isObject, unwrapTool, type ToolSuccess } from './errors.ts';
import type { ToolInput, ToolName, ToolResults } from './generated/tools.ts';
import type { CallOptions, HttpClient } from './http.ts';
import { eventJson, responseEvents } from './sse.ts';

const versions = ['2025-06-18', '2025-03-26'];
export type McpInitialization = {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  capabilities: Record<string, unknown>;
};
export type McpToolList = {
  tools: {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  }[];
  nextCursor?: string;
};
export type McpToolResult<Name extends ToolName> = {
  content: { type: string; [key: string]: unknown }[];
  structuredContent: ToolResults[Name];
  isError?: boolean;
};

export class McpError extends Error {
  readonly code: number;
  readonly status: number;
  constructor(code: number, status: number) {
    super(`MCP JSON-RPC error ${code}`);
    this.name = 'McpError';
    this.code = code;
    this.status = status;
  }
}

export function createMcpClient(http: HttpClient) {
  let sequence = 0;
  let version: string | undefined;
  let sessionId: string | undefined;
  let initialization: Promise<McpInitialization> | undefined;

  async function send(
    method: string,
    params?: unknown,
    options?: CallOptions,
    notification = false,
  ) {
    const id = notification ? undefined : ++sequence;
    const headers = new Headers({ accept: 'application/json, text/event-stream' });
    if (version) headers.set('mcp-protocol-version', version);
    if (sessionId) headers.set('mcp-session-id', sessionId);
    const response = await http.send('/mcp', {
      ...options,
      method: 'POST',
      body: { jsonrpc: '2.0', id, method, params },
      headers,
      retry: method === 'tools/call' ? 'keyed' : method === 'tools/list' ? 'safe' : 'never',
    });
    if (notification) {
      await http.requireOk(response);
      await response.body?.cancel();
      return;
    }

    function rpcResult(payload: unknown) {
      if (!isObject(payload) || payload.jsonrpc !== '2.0' || payload.id !== id) {
        throw new ApiError('invalid_mcp_response', response.status);
      }
      if (isObject(payload.error) && typeof payload.error.code === 'number') {
        throw new McpError(payload.error.code, response.status);
      }
      if (!Object.hasOwn(payload, 'result') || !response.ok) {
        throw new ApiError('invalid_mcp_response', response.status);
      }
      return payload.result;
    }
    if (method === 'initialize' && response.ok) {
      sessionId = response.headers.get('mcp-session-id') ?? undefined;
    }
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (contentType === 'text/event-stream' && response.ok) {
      for await (const frame of responseEvents(response)) {
        const payload = eventJson(frame.data);
        if (isObject(payload) && payload.id === id && !('method' in payload))
          return rpcResult(payload);
      }
      throw new ApiError('incomplete_mcp_response', response.status);
    }
    if (!response.ok) {
      const payload: unknown = await response
        .clone()
        .json()
        .catch(() => undefined);
      if (isObject(payload) && payload.jsonrpc === '2.0' && payload.id === id) {
        await response.body?.cancel();
        return rpcResult(payload);
      }
      await http.requireOk(response);
    }
    const payload: unknown = await response.json().catch(() => undefined);
    return rpcResult(payload);
  }

  function initialize(options?: Pick<CallOptions, 'signal'>): Promise<McpInitialization> {
    initialization ??= (async () => {
      const result = await send(
        'initialize',
        {
          protocolVersion: versions[0],
          capabilities: {},
          clientInfo: { name: '@bs/sdk', version: '0.0.0' },
        },
        options,
      );
      if (
        !isObject(result) ||
        typeof result.protocolVersion !== 'string' ||
        !versions.includes(result.protocolVersion) ||
        !isObject(result.capabilities) ||
        !isObject(result.serverInfo)
      ) {
        throw new ApiError('unsupported_mcp_initialization');
      }
      version = result.protocolVersion;
      await send('notifications/initialized', undefined, options, true);
      return result as McpInitialization;
    })().catch((error: unknown) => {
      initialization = undefined;
      version = undefined;
      sessionId = undefined;
      throw error;
    });
    return initialization;
  }

  async function callRaw<Name extends ToolName>(
    name: Name,
    input: NoInfer<ToolInput<Name>>,
    options?: CallOptions,
  ) {
    await initialize({ signal: options?.signal });
    const result = await send('tools/call', { name, arguments: input }, options);
    if (
      !isObject(result) ||
      !Array.isArray(result.content) ||
      !isObject(result.structuredContent)
    ) {
      throw new ApiError('invalid_mcp_tool_result');
    }
    return result as McpToolResult<Name>;
  }

  return {
    initialize,
    async listTools(cursor?: string, options?: CallOptions): Promise<McpToolList> {
      await initialize({ signal: options?.signal });
      const result = await send('tools/list', cursor === undefined ? {} : { cursor }, options);
      if (!isObject(result) || !Array.isArray(result.tools))
        throw new ApiError('invalid_mcp_tool_list');
      return result as McpToolList;
    },
    callRaw,
    async call<Name extends ToolName>(
      name: Name,
      input: NoInfer<ToolInput<Name>>,
      options?: CallOptions,
    ): Promise<ToolSuccess<ToolResults[Name]>> {
      return unwrapTool((await callRaw(name, input, options)).structuredContent);
    },
  };
}
