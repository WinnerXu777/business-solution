import { collect } from './collect.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAnthropicAdapter,
  createFixtureModelAdapter,
  createNativeModelAdapter,
  createOpenAIAdapter,
  type ChatInput,
  type HttpClient,
  type ModelAdapter,
} from '../../src/llm/index.ts';

const base: ChatInput = {
  model: 'fictional-checkpoint',
  max_completion_tokens: 40,
  messages: [
    { role: 'system', content: 'Fictional directions' },
    { role: 'user', content: 'Synthetic question' },
  ],
};
const named: ChatInput = {
  ...base,
  tools: [{ type: 'function', function: { name: 'inventory', parameters: { type: 'object' } } }],
  tool_choice: { type: 'function', function: { name: 'inventory' } },
};
const structured: ChatInput = {
  ...base,
  response_format: {
    type: 'json_schema',
    json_schema: { name: 'empty', schema: { type: 'object' }, strict: true },
  },
};

function sse(values: unknown[]) {
  const bytes = Buffer.from(
    values
      .map((value) => 'data: ' + (value === '[DONE]' ? value : JSON.stringify(value)) + '\r\n\r\n')
      .join(''),
  );
  return (async function* () {
    for (let i = 0; i < bytes.length; i += 7) yield bytes.subarray(i, i + 7);
  })();
}

const text = 'Synthetic completion.';
const tokens = { prompt_tokens: 4, completion_tokens: 2 };
const call = {
  id: 'call_fixture',
  type: 'function',
  function: { name: 'inventory', arguments: '{}' },
};

function compatibleFake(secret?: string): HttpClient {
  return async ({ method, path, headers, body, signal }) => {
    assert.equal(method, 'POST');
    assert.equal(headers.authorization, secret ? 'Bearer ' + secret : undefined);
    assert.equal(headers['content-type'], 'application/json');
    if (path === '/v1/embeddings') {
      assert.deepEqual(body, {
        model: base.model,
        input: ['alpha', 'beta'],
        encoding_format: 'float',
      });
      return {
        status: 200,
        async json() {
          return {
            data: [
              { index: 1, embedding: [3, 4] },
              { index: 0, embedding: [1, 2] },
            ],
            usage: tokens,
          };
        },
      };
    }
    assert.equal(path, '/v1/chat/completions');
    assert(signal instanceof AbortSignal);
    const input = body as ChatInput & { stream: boolean; stream_options?: unknown };
    assert.equal(input.model, base.model);
    assert.equal(input.max_completion_tokens, 40);
    if (input.tools) assert.deepEqual(input.tool_choice, named.tool_choice);
    if (input.response_format) assert.deepEqual(input.response_format, structured.response_format);
    const content = input.tools ? null : input.response_format ? '{}' : text;
    const reason = input.tools ? 'tool_calls' : 'stop';
    const tool_calls = input.tools ? [call] : undefined;
    const resultUsage = { ...tokens, completion_tokens: content === text ? 2 : 1 };
    if (!input.stream)
      return {
        status: 200,
        async json() {
          return {
            choices: [{ message: { content, tool_calls }, finish_reason: reason }],
            usage: resultUsage,
          };
        },
      };
    assert.deepEqual(input.stream_options, { include_usage: true });
    const deltas = tool_calls
      ? [
          { tool_calls: [{ index: 0, ...call, function: { ...call.function, arguments: '{' } }] },
          { tool_calls: [{ index: 0, function: { arguments: '}' } }] },
        ]
      : [{ content }];
    return {
      status: 200,
      async json() {
        assert.fail('unexpected JSON read');
      },
      stream: sse([
        ...deltas.map((delta) => ({ choices: [{ delta, finish_reason: null }], usage: null })),
        { choices: [{ delta: {}, finish_reason: reason }] },
        { choices: [], usage: resultUsage },
        '[DONE]',
      ]),
    };
  };
}

const anthropicFake: HttpClient = async ({ method, path, headers, body, signal }) => {
  assert.equal(method, 'POST');
  assert.equal(path, '/v1/messages');
  assert.equal(headers['x-api-key'], 'fictional-claude-key');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert(signal instanceof AbortSignal);
  const input = body as Record<string, unknown>;
  assert.equal(input.model, base.model);
  assert.equal(input.max_tokens, 40);
  assert.deepEqual(input.system, [{ type: 'text', text: 'Fictional directions' }]);
  if (input.tools) {
    assert.deepEqual(input.tools, [
      { name: 'inventory', description: undefined, input_schema: { type: 'object' } },
    ]);
    assert.deepEqual(input.tool_choice, { type: 'tool', name: 'inventory' });
  }
  if (input.output_config) {
    assert.deepEqual(input.output_config, {
      format: { type: 'json_schema', schema: { type: 'object' } },
    });
  }
  const messages = input.messages as unknown[];
  assert.deepEqual(messages[0], {
    role: 'user',
    content: [{ type: 'text', text: 'Synthetic question' }],
  });
  if (messages.length > 1) {
    assert.deepEqual(messages.slice(1), [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_fixture', name: 'inventory', input: {} }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_fixture', content: 'Synthetic stock result' },
        ],
      },
    ]);
  }
  const resultText = input.output_config ? '{}' : text;
  const reason = input.tools ? 'tool_use' : 'end_turn';
  const resultUsage = {
    input_tokens: 3,
    cache_read_input_tokens: 1,
    output_tokens: input.tools || input.output_config ? 1 : 2,
  };
  const tool = { type: 'tool_use', id: 'call_fixture', name: 'inventory', input: {} };
  if (!input.stream)
    return {
      status: 200,
      async json() {
        return {
          content: input.tools ? [tool] : [{ type: 'text', text: resultText }],
          stop_reason: reason,
          usage: resultUsage,
        };
      },
    };
  return {
    status: 200,
    async json() {
      assert.fail('unexpected JSON read');
    },
    stream: sse([
      { type: 'message_start', message: { usage: { ...resultUsage, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      ...(input.tools
        ? [
            { type: 'content_block_stop', index: 0 },
            { type: 'content_block_start', index: 1, content_block: tool },
            {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'input_json_delta', partial_json: '{' },
            },
            {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'input_json_delta', partial_json: '}' },
            },
          ]
        : [
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: resultText },
            },
          ]),
      {
        type: 'message_delta',
        delta: { stop_reason: reason },
        usage: { output_tokens: resultUsage.output_tokens },
      },
      { type: 'message_stop' },
    ]),
  };
};

function modelContract(adapter: ModelAdapter, embeddings: boolean) {
  test(adapter.provider + ' model contract', async () => {
    const signal = new AbortController().signal;
    for (const input of [base, named, structured]) {
      const result = await adapter.complete(input, signal);
      assert.equal(result.content, input === named ? null : input === structured ? '{}' : text);
      assert.deepEqual(result.toolCalls, input === named ? [call] : []);
      assert.equal(result.finishReason, input === named ? 'tool_calls' : 'stop');
      assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: input === base ? 2 : 1 });

      const events = await collect(adapter.stream(input, signal));
      const last = events.pop();
      assert.deepEqual(last, {
        type: 'done',
        finishReason: result.finishReason,
        usage: result.usage,
      });
      const deltas = events.flatMap((event) => (event.type === 'delta' ? [event] : []));
      assert.equal(deltas.length, events.length);
      assert.equal(deltas.map((event) => event.content ?? '').join(''), result.content ?? '');
      const toolDeltas = deltas.flatMap((event) => event.toolCalls ?? []);
      if (input === named) {
        assert.equal(toolDeltas[0]?.id, call.id);
        assert(toolDeltas.every((delta) => delta.index === 0));
        assert.equal(toolDeltas.map((delta) => delta.function?.name ?? '').join(''), 'inventory');
        assert.equal(toolDeltas.map((delta) => delta.function?.arguments ?? '').join(''), '{}');
      } else assert.deepEqual(toolDeltas, []);
    }
    assert.equal(typeof adapter.embed === 'function', embeddings);
    if (adapter.embed) {
      const input = { model: base.model, input: ['alpha', 'beta'] };
      const first = await adapter.embed(input, signal);
      assert.equal(first.vectors.length, 2);
      assert(first.vectors.every((vector) => vector.length && vector.every(Number.isFinite)));
      assert.notDeepEqual(first.vectors[0], first.vectors[1]);
      assert.equal(first.usage.outputTokens, 0);
      assert.deepEqual(await adapter.embed(input, signal), first);
    }
    await assert.rejects(adapter.complete(base, AbortSignal.abort()));
    await assert.rejects(collect(adapter.stream(base, AbortSignal.abort())));
  });
}

modelContract(createFixtureModelAdapter(), true);
modelContract(createNativeModelAdapter(compatibleFake()), true);
modelContract(
  createOpenAIAdapter(compatibleFake('fictional-openai-key'), 'fictional-openai-key'),
  true,
);
const anthropic = createAnthropicAdapter(anthropicFake, 'fictional-claude-key');
modelContract(anthropic, false);

test('Anthropic maps assistant tool use and returned tool results in chat history', async () => {
  const result = await anthropic.complete(
    {
      ...base,
      messages: [
        ...base.messages,
        { role: 'assistant', content: null, tool_calls: [{ ...call, type: 'function' }] },
        { role: 'tool', content: 'Synthetic stock result', tool_call_id: call.id },
      ],
    },
    new AbortController().signal,
  );
  assert.equal(result.content, text);
});

test('OpenAI-compatible SSE rejects a truncated upstream stream', async () => {
  const adapter = createNativeModelAdapter(async () => ({
    status: 200,
    async json() {
      return {};
    },
    stream: sse([{ choices: [{ delta: { content: 'partial' } }] }]),
  }));
  await assert.rejects(collect(adapter.stream(base)), { code: 'unavailable' });
});
