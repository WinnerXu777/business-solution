import {
  ProviderError,
  count,
  list,
  object,
  string,
  usage,
  type FinishReason,
  type JsonObject,
  type ModelAdapter,
  type ToolCall,
  type ToolDelta,
} from './contracts.ts';
import { json, parseJson, request, sse, type HttpClient } from './http.ts';

function finish(reason: unknown): FinishReason {
  if (
    reason === 'stop' ||
    reason === 'length' ||
    reason === 'tool_calls' ||
    reason === 'content_filter'
  ) {
    return reason;
  }
  throw new ProviderError('invalid_response');
}

function tokenUsage(raw: unknown) {
  const value = object(raw);
  return usage(value.prompt_tokens, value.completion_tokens);
}

function tools(raw: unknown): ToolCall[] {
  return raw == null
    ? []
    : list(raw).map((entry) => {
        const call = object(entry);
        const fn = object(call.function);
        if (call.type !== 'function') throw new ProviderError('invalid_response');
        return {
          id: string(call.id),
          type: 'function',
          function: { name: string(fn.name), arguments: string(fn.arguments) },
        };
      });
}

function toolDeltas(raw: unknown): ToolDelta[] {
  return list(raw).map((entry) => {
    const call = object(entry);
    const fn = call.function === undefined ? {} : object(call.function);
    if (call.type !== undefined && call.type !== 'function') {
      throw new ProviderError('invalid_response');
    }
    return {
      index: count(call.index),
      ...(call.id === undefined ? {} : { id: string(call.id) }),
      ...(call.type === 'function' ? { type: call.type } : {}),
      function: {
        ...(fn.name === undefined ? {} : { name: string(fn.name) }),
        ...(fn.arguments === undefined ? {} : { arguments: string(fn.arguments) }),
      },
    };
  });
}

function compatible(provider: string, client: HttpClient, apiKey?: string): ModelAdapter {
  const post = (path: string, body: JsonObject, signal?: AbortSignal) =>
    request(client, {
      method: 'POST',
      path: '/v1' + path,
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}),
      },
      body,
      signal,
    });

  return {
    provider,
    async complete(input, signal) {
      const result = object(
        await json(await post('/chat/completions', { ...input, stream: false }, signal)),
      );
      const choice = object(list(result.choices)[0]);
      const message = object(choice.message);
      return {
        content: message.content == null ? null : string(message.content),
        toolCalls: tools(message.tool_calls),
        finishReason: finish(choice.finish_reason),
        usage: tokenUsage(result.usage),
      };
    },
    async *stream(input, signal) {
      const result = await post(
        '/chat/completions',
        { ...input, stream: true, stream_options: { include_usage: true } },
        signal,
      );
      let finalReason: FinishReason | undefined;
      let finalUsage: ReturnType<typeof tokenUsage> | undefined;
      for await (const data of sse(result.stream)) {
        if (data === '[DONE]') {
          if (!finalReason || !finalUsage) throw new ProviderError('invalid_response');
          yield { type: 'done', finishReason: finalReason, usage: finalUsage };
          return;
        }
        const chunk = object(parseJson(data));
        if (chunk.error) throw new ProviderError('unavailable');
        if (chunk.usage != null) finalUsage = tokenUsage(chunk.usage);
        for (const value of list(chunk.choices)) {
          const choice = object(value);
          const delta = object(choice.delta);
          if (choice.finish_reason != null) finalReason = finish(choice.finish_reason);
          if (delta.content != null || delta.tool_calls != null) {
            yield {
              type: 'delta',
              ...(delta.content == null ? {} : { content: string(delta.content) }),
              ...(delta.tool_calls == null ? {} : { toolCalls: toolDeltas(delta.tool_calls) }),
            };
          }
        }
      }
      throw new ProviderError('unavailable');
    },
    async embed(input, signal) {
      const result = object(
        await json(await post('/embeddings', { ...input, encoding_format: 'float' }, signal)),
      );
      const rows = list(result.data)
        .map(object)
        .sort((a, b) => count(a.index) - count(b.index));
      if (rows.length !== (Array.isArray(input.input) ? input.input.length : 1)) {
        throw new ProviderError('invalid_response');
      }
      const vectors = rows.map((row, index) => {
        const vector = list(row.embedding);
        if (
          row.index !== index ||
          !vector.length ||
          !vector.every((value) => typeof value === 'number' && Number.isFinite(value))
        ) {
          throw new ProviderError('invalid_response');
        }
        return vector as number[];
      });
      const tokens = object(result.usage);
      return { vectors, usage: usage(tokens.prompt_tokens, 0) };
    },
  };
}

export function createOpenAIAdapter(client: HttpClient, apiKey: string): ModelAdapter {
  return compatible('openai', client, apiKey);
}

export function createNativeModelAdapter(client: HttpClient, apiKey?: string): ModelAdapter {
  return compatible('native-vllm', client, apiKey);
}
