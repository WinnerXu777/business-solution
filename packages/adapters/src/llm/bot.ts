import { list, object, ProviderError, string, type ChatMessage } from './contracts.ts';
import { json, request, type HttpClient } from './http.ts';

export const nativeChatPath = '/llm/v1/chat/completions';
export type BotBinding = { serviceKey: string; modelAlias: string };
export type BotModel = (
  tenantId: string,
  messages: ChatMessage[],
  signal: AbortSignal,
) => Promise<string>;

export function createNativeBotModel(
  client: HttpClient,
  resolve: (tenantId: string) => BotBinding | undefined | Promise<BotBinding | undefined>,
): BotModel {
  return async (tenantId, messages, signal) => {
    const binding = await resolve(tenantId);
    if (!binding?.serviceKey || !binding.modelAlias) throw new ProviderError('rejected');
    const response = await request(client, {
      method: 'POST',
      path: nativeChatPath,
      headers: {
        authorization: 'Bearer ' + binding.serviceKey,
        'content-type': 'application/json',
      },
      body: {
        model: binding.modelAlias,
        messages,
        max_completion_tokens: 256,
        stream: false,
        tool_choice: 'none',
      },
      signal,
    });
    const { choices } = object(await json(response));
    signal.throwIfAborted();
    const choice = object(list(choices)[0]);
    const message = object(choice.message);
    const text = string(message.content).trim();
    if (
      message.role !== 'assistant' ||
      message.tool_calls ||
      !text ||
      text.length > 4096 ||
      (choice.finish_reason !== 'stop' && choice.finish_reason !== 'length')
    ) {
      throw new ProviderError('invalid_response');
    }
    return text;
  };
}
