import { createHash } from 'node:crypto';
import type { ChatInput, Completion, ModelAdapter, Usage } from './contracts.ts';

const tokenCount = (text: string) => text.match(/\S+/g)?.length ?? 0;

function complete(input: ChatInput, structuredText: string): Completion {
  const choice = input.tool_choice;
  const fn =
    typeof choice === 'object'
      ? input.tools?.find(({ function: fn }) => fn.name === choice.function.name)
      : choice === 'required'
        ? input.tools?.[0]
        : undefined;
  const structured = input.response_format?.type === 'json_schema';
  const text = structured ? structuredText : 'Synthetic completion.';
  const words = text.match(/\S+/g) ?? [];
  const truncated = words.length > input.max_completion_tokens;
  const usage: Usage = {
    inputTokens: input.messages.reduce(
      (sum, message) => sum + tokenCount(message.content ?? ''),
      0,
    ),
    outputTokens: fn ? 1 : Math.min(words.length, input.max_completion_tokens),
  };
  return {
    content: fn ? null : truncated ? words.slice(0, input.max_completion_tokens).join(' ') : text,
    toolCalls: fn
      ? [
          {
            id: 'call_fixture',
            type: 'function',
            function: { name: fn.function.name, arguments: '{}' },
          },
        ]
      : [],
    finishReason: fn ? 'tool_calls' : truncated ? 'length' : 'stop',
    usage,
  };
}

export function createFixtureModelAdapter({ structuredText = '{}' } = {}): ModelAdapter {
  return {
    provider: 'fixture',
    async complete(input, signal) {
      signal?.throwIfAborted();
      return complete(input, structuredText);
    },
    async *stream(input, signal) {
      signal?.throwIfAborted();
      const result = complete(input, structuredText);
      yield {
        type: 'delta',
        ...(result.content === null ? {} : { content: result.content }),
        ...(result.toolCalls.length
          ? { toolCalls: result.toolCalls.map((call, index) => ({ index, ...call })) }
          : {}),
      };
      signal?.throwIfAborted();
      yield { type: 'done', finishReason: result.finishReason, usage: result.usage };
    },
    async embed(input, signal) {
      signal?.throwIfAborted();
      const items = typeof input.input === 'string' ? [input.input] : input.input;
      return {
        vectors: items.map((text) => {
          const hash = createHash('sha256').update(text).digest();
          return Array.from(
            { length: input.dimensions ?? 3 },
            (_, index) => hash[index % hash.length] / 255,
          );
        }),
        usage: {
          inputTokens: items.reduce((sum, text) => sum + tokenCount(text), 0),
          outputTokens: 0,
        },
      };
    },
  };
}
