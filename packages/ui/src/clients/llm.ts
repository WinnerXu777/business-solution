import { PlatformError } from '../platform-client.ts';
import type { RequestJson } from '../platform-client.ts';
import { sseData } from './sse.ts';
import type { OpenStream } from './sse.ts';

const platform = '/platform/v1/llm/keys';
const root = '/llm/v1';

export interface LlmModel {
  id: string;
  owned_by: string;
}
export interface LlmKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
}
export interface ChatRequest {
  model: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  tools?: { type: 'function'; function: { name: string; parameters: object } }[];
  response_format?: {
    type: 'json_schema';
    json_schema: { name: string; schema: object; strict: boolean };
  };
}
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}
export interface ToolDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}
export interface ChatChunk {
  choices: {
    index: number;
    delta: { content?: string; tool_calls?: ToolDelta[] };
    finish_reason?: string | null;
  }[];
  usage?: TokenUsage | null;
  provider_route?: string;
  binding_version?: number;
}

export interface LlmClient {
  models(): Promise<LlmModel[]>;
  chat(input: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk>;
  embeddings(
    model: string,
    input: string | string[],
  ): Promise<{ data: { index: number; embedding: number[] }[] }>;
  listKeys(): Promise<LlmKey[]>;
  createKey(name: string): Promise<{ secret: string }>;
  revokeKey(id: string): Promise<void>;
}

export class HttpLlmClient implements LlmClient {
  private readonly request: RequestJson;
  private readonly open: OpenStream;

  constructor(request: RequestJson, open: OpenStream) {
    this.request = request;
    this.open = open;
  }

  async models() {
    return (await this.request<{ data: LlmModel[] }>(root + '/models')).data;
  }

  async *chat(input: ChatRequest, signal: AbortSignal) {
    const response = await this.open(root + '/chat/completions', {
      method: 'POST',
      headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, stream: true, stream_options: { include_usage: true } }),
      signal,
    });
    const route = response.headers.get('X-Provider-Route');
    const binding = response.headers.get('X-Binding-Version');
    if (route || binding)
      yield {
        choices: [],
        provider_route: route ?? undefined,
        binding_version: binding && /^\d+$/.test(binding) ? Number(binding) : undefined,
      };
    let finished = false;
    for await (const data of sseData(response, signal)) {
      if (data === '[DONE]') return;
      const chunk = JSON.parse(data) as ChatChunk & { error?: unknown };
      if (chunk.error || !Array.isArray(chunk.choices)) throw new PlatformError('provider_error');
      finished ||= chunk.choices.some((choice) => Boolean(choice.finish_reason));
      yield chunk;
    }
    if (!signal.aborted && !finished) throw new PlatformError('provider_error');
  }

  embeddings(model: string, input: string | string[]) {
    return this.request<{ data: { index: number; embedding: number[] }[] }>(
      root + '/embeddings',
      'POST',
      { model, input },
    );
  }
  listKeys() {
    return this.request<LlmKey[]>(platform);
  }
  createKey(name: string) {
    return this.request<{ secret: string }>(platform, 'POST', { name });
  }
  revokeKey(id: string) {
    return this.request<void>(
      platform + '/' + encodeURIComponent(id),
      'DELETE',
      undefined,
      undefined,
      false,
    );
  }
}
