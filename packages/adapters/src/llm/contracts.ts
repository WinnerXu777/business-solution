export type JsonObject = Record<string, unknown>;
export type Usage = { inputTokens: number; outputTokens: number };
export type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};
export type Tool = {
  type: 'function';
  function: { name: string; description?: string; parameters?: JsonObject; strict?: boolean };
};
export type ToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };
export type ChatMessage =
  | { role: 'system' | 'developer' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };
export type ChatInput = {
  model: string;
  messages: ChatMessage[];
  max_completion_tokens: number;
  temperature?: number;
  tools?: Tool[];
  tool_choice?: ToolChoice;
  response_format?:
    | { type: 'text' }
    | { type: 'json_schema'; json_schema: { name: string; schema: JsonObject; strict?: boolean } };
};
export type EmbeddingInput = { model: string; input: string | string[]; dimensions?: number };
export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';
export type Completion = {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: Usage;
};
export type ToolDelta = {
  index: number;
  id?: string;
  type?: 'function';
  function?: Partial<ToolCall['function']>;
};
export type ChatEvent =
  | { type: 'delta'; content?: string; toolCalls?: ToolDelta[] }
  | { type: 'done'; finishReason: FinishReason; usage: Usage };
export type Embeddings = { vectors: number[][]; usage: Usage };
export interface ModelAdapter {
  readonly provider: string;
  complete(input: ChatInput, signal?: AbortSignal): Promise<Completion>;
  stream(input: ChatInput, signal?: AbortSignal): AsyncIterable<ChatEvent>;
  embed?(input: EmbeddingInput, signal?: AbortSignal): Promise<Embeddings>;
}

export class ProviderError extends Error {
  readonly code: 'unavailable' | 'rejected' | 'invalid_response' | 'unsupported';

  constructor(code: ProviderError['code']) {
    super(code);
    this.code = code;
  }
}

export function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderError('invalid_response');
  }
  return value as JsonObject;
}

export function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new ProviderError('invalid_response');
  return value;
}

export function string(value: unknown): string {
  if (typeof value !== 'string') throw new ProviderError('invalid_response');
  return value;
}

export function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ProviderError('invalid_response');
  }
  return value;
}

export function usage(input: unknown, output: unknown): Usage {
  const inputTokens = count(input);
  const outputTokens = count(output);
  count(inputTokens + outputTokens);
  return { inputTokens, outputTokens };
}
