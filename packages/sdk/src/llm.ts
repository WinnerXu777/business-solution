import { ApiError, errorCode, isObject } from './errors.ts';
import type { CallOptions, HttpClient } from './http.ts';
import { eventJson, responseEvents } from './sse.ts';

export type LlmToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};
export type ChatMessage =
  | { role: 'system' | 'developer' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: LlmToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };
export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  max_completion_tokens?: number;
  max_tokens?: number;
  temperature?: number;
  tools?: {
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
      strict?: boolean;
    };
  }[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  response_format?:
    | { type: 'text' }
    | {
        type: 'json_schema';
        json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean };
      };
};
export type ChatStreamRequest = ChatRequest & { stream_options?: { include_usage?: boolean } };
type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };
type CompletionBase = { id: string; created: number; model: string };
type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';
export type ChatCompletion = CompletionBase & {
  object: 'chat.completion';
  choices: {
    index: number;
    message: Extract<ChatMessage, { role: 'assistant' }>;
    finish_reason: FinishReason;
  }[];
  usage: Usage;
};
export type ChatChunk = CompletionBase & {
  object: 'chat.completion.chunk';
  choices: {
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
      tool_calls?: (Partial<Omit<LlmToolCall, 'function'>> & {
        index: number;
        function?: Partial<LlmToolCall['function']>;
      })[];
    };
    finish_reason: FinishReason | null;
  }[];
  usage?: Usage | null;
};
export type EmbeddingRequest<Encoding extends 'float' | 'base64' = 'float' | 'base64'> = {
  model: string;
  input: string | string[];
  dimensions?: number;
  encoding_format?: Encoding;
} & (Encoding extends 'base64' ? { encoding_format: 'base64' } : unknown);
export type EmbeddingResponse<Encoding extends 'float' | 'base64'> = {
  object: 'list';
  model: string;
  data: {
    object: 'embedding';
    index: number;
    embedding: Encoding extends 'base64' ? string : number[];
  }[];
  usage: Pick<Usage, 'prompt_tokens' | 'total_tokens'>;
};
export type ModelCatalog = {
  object: 'list';
  data: { id: string; object: 'model'; created: number; owned_by: string }[];
};

export function createLlmClient(http: HttpClient) {
  const completions = '/llm/v1/chat/completions';
  return {
    models: (options?: CallOptions) => http.json<ModelCatalog>('/llm/v1/models', options),
    embeddings<Encoding extends 'float' | 'base64' = 'float'>(
      input: EmbeddingRequest<Encoding>,
      options?: CallOptions,
    ) {
      return http.json<EmbeddingResponse<Encoding>>('/llm/v1/embeddings', {
        ...options,
        method: 'POST',
        body: input,
      });
    },
    chat: (input: ChatRequest, options?: CallOptions) =>
      http.json<ChatCompletion>(completions, {
        ...options,
        method: 'POST',
        body: { ...input, stream: false },
      }),
    async *streamChat(input: ChatStreamRequest, options?: CallOptions): AsyncGenerator<ChatChunk> {
      const response = await http.requireOk(
        await http.send(completions, {
          ...options,
          method: 'POST',
          body: { ...input, stream: true },
          headers: { accept: 'text/event-stream' },
        }),
      );
      const requestId = response.headers.get('x-request-id') ?? undefined;
      for await (const frame of responseEvents(response)) {
        if (frame.data === '[DONE]') return;
        const data = eventJson(frame.data);
        if (isObject(data) && 'error' in data)
          throw new ApiError(errorCode(data, 'stream_error'), undefined, requestId);
        if (
          !isObject(data) ||
          data.object !== 'chat.completion.chunk' ||
          !Array.isArray(data.choices)
        ) {
          throw new ApiError('invalid_chat_chunk', undefined, requestId);
        }
        yield data as ChatChunk;
      }
      throw new ApiError('incomplete_stream', undefined, requestId);
    },
  };
}
