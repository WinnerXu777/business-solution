import {
  ProviderError,
  count,
  list,
  object,
  string,
  usage,
  type ChatInput,
  type FinishReason,
  type JsonObject,
  type ModelAdapter,
  type ToolCall,
} from './contracts.ts';
import { json, parseJson, request, sse, type HttpClient } from './http.ts';

function payload(input: ChatInput, stream: boolean) {
  const system: JsonObject[] = [];
  const messages: { role: 'assistant' | 'user'; content: JsonObject[] }[] = [];
  for (const message of input.messages) {
    if (message.role === 'system' || message.role === 'developer') {
      system.push({ type: 'text', text: message.content });
    } else if (message.role === 'assistant') {
      const content: JsonObject[] = message.content
        ? [{ type: 'text', text: message.content }]
        : [];
      for (const call of message.tool_calls ?? []) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: object(parseJson(call.function.arguments)),
        });
      }
      messages.push({ role: 'assistant', content });
    } else {
      const block =
        message.role === 'tool'
          ? { type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }
          : { type: 'text', text: message.content };
      const previous = messages.at(-1);
      if (previous?.role === 'user') previous.content.push(block);
      else messages.push({ role: 'user', content: [block] });
    }
  }
  const choice = input.tool_choice;
  const toolChoice =
    typeof choice === 'object'
      ? { type: 'tool', name: choice.function.name }
      : { type: choice === 'required' ? 'any' : (choice ?? 'auto') };
  return {
    model: input.model,
    max_tokens: input.max_completion_tokens,
    messages,
    stream,
    ...(system.length ? { system } : {}),
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.tools?.length && choice !== 'none'
      ? {
          tools: input.tools.map(({ function: fn }) => ({
            name: fn.name,
            description: fn.description,
            input_schema: fn.parameters ?? { type: 'object' },
            ...(fn.strict === undefined ? {} : { strict: fn.strict }),
          })),
          tool_choice: toolChoice,
        }
      : {}),
    ...(input.response_format?.type === 'json_schema'
      ? {
          output_config: {
            format: { type: 'json_schema', schema: input.response_format.json_schema.schema },
          },
        }
      : {}),
  };
}

function finish(reason: unknown): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      throw new ProviderError('invalid_response');
  }
}

function inputTokens(raw: JsonObject) {
  return count(
    count(raw.input_tokens) +
      count(raw.cache_creation_input_tokens ?? 0) +
      count(raw.cache_read_input_tokens ?? 0),
  );
}

export function createAnthropicAdapter(client: HttpClient, apiKey: string): ModelAdapter {
  const send = (input: ChatInput, stream: boolean, signal?: AbortSignal) =>
    request(client, {
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
      },
      body: payload(input, stream),
      signal,
    });
  return {
    provider: 'anthropic',
    async complete(input, signal) {
      const result = object(await json(await send(input, false, signal)));
      const text: string[] = [];
      const toolCalls: ToolCall[] = [];
      for (const raw of list(result.content)) {
        const block = object(raw);
        if (block.type === 'text') text.push(string(block.text));
        if (block.type === 'tool_use') {
          toolCalls.push({
            id: string(block.id),
            type: 'function',
            function: { name: string(block.name), arguments: JSON.stringify(object(block.input)) },
          });
        }
      }
      const tokens = object(result.usage);
      return {
        content: text.length ? text.join('') : null,
        toolCalls,
        finishReason: finish(result.stop_reason),
        usage: usage(inputTokens(tokens), tokens.output_tokens),
      };
    },
    async *stream(input, signal) {
      const result = await send(input, true, signal);
      const toolIndices = new Map<number, number>();
      const emptyArguments = new Set<number>();
      let prompt: number | undefined;
      let output: number | undefined;
      let reason: FinishReason | undefined;
      for await (const data of sse(result.stream)) {
        const event = object(parseJson(data));
        switch (event.type) {
          case 'error':
            throw new ProviderError('unavailable');
          case 'message_start': {
            const tokens = object(object(event.message).usage);
            prompt = inputTokens(tokens);
            break;
          }
          case 'content_block_start': {
            const block = object(event.content_block);
            if (block.type === 'text' && block.text) {
              yield { type: 'delta', content: string(block.text) };
            }
            if (block.type === 'tool_use') {
              const index = toolIndices.size;
              const blockIndex = count(event.index);
              if (toolIndices.has(blockIndex)) throw new ProviderError('invalid_response');
              toolIndices.set(blockIndex, index);
              const args = object(block.input);
              const initialArguments = Object.keys(args).length ? JSON.stringify(args) : '';
              if (!initialArguments) emptyArguments.add(blockIndex);
              yield {
                type: 'delta',
                toolCalls: [
                  {
                    index,
                    id: string(block.id),
                    type: 'function',
                    function: {
                      name: string(block.name),
                      arguments: initialArguments,
                    },
                  },
                ],
              };
            }
            break;
          }
          case 'content_block_delta': {
            const delta = object(event.delta);
            if (delta.type === 'text_delta') {
              yield { type: 'delta', content: string(delta.text) };
            } else if (delta.type === 'input_json_delta') {
              const blockIndex = count(event.index);
              const index = toolIndices.get(blockIndex);
              if (index === undefined) throw new ProviderError('invalid_response');
              const argumentsPart = string(delta.partial_json);
              if (argumentsPart) emptyArguments.delete(blockIndex);
              yield {
                type: 'delta',
                toolCalls: [{ index, function: { arguments: argumentsPart } }],
              };
            }
            break;
          }
          case 'content_block_stop': {
            const blockIndex = count(event.index);
            if (emptyArguments.delete(blockIndex)) {
              yield {
                type: 'delta',
                toolCalls: [{ index: toolIndices.get(blockIndex)!, function: { arguments: '{}' } }],
              };
            }
            break;
          }
          case 'message_delta': {
            const delta = object(event.delta);
            if (delta.stop_reason != null) reason = finish(delta.stop_reason);
            if (event.usage != null) output = count(object(event.usage).output_tokens);
            break;
          }
          case 'message_stop':
            if (!reason || prompt === undefined || output === undefined) {
              throw new ProviderError('invalid_response');
            }
            yield { type: 'done', finishReason: reason, usage: usage(prompt, output) };
            return;
        }
      }
      throw new ProviderError('unavailable');
    },
  };
}
