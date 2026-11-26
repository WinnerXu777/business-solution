import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  ProviderError,
  usage,
  type ChatEvent,
  type ChatInput,
  type EmbeddingInput,
  type Usage,
} from '../../../../packages/adapters/src/llm/index.ts';
import {
  createLimits,
  MemoryLimitRepository,
  type Binding,
  type Capability,
  type Limits,
  type LimitRepository,
  type Route,
  type UsageRecord,
} from './metering.ts';
import { ApiError, readChat, readEmbeddings, structuredOutput } from './validation.ts';

export type { Binding, Capability, Limits, Route, UsageRecord } from './metering.ts';
export { PostgresLimitRepository } from './postgres.ts';

type Endpoint = 'chat.completions' | 'embeddings' | 'models';
type Identity = { tenantId: string };
type RequestAudit = {
  requestId: string;
  endpoint: Endpoint;
  tenantId?: string;
  status: number;
  bindingVersion?: string;
  bindingVersions?: Partial<Record<Capability, string>>;
  route?: string;
  error?: string;
};

export type LlmPluginOptions = {
  verifyApiKey: (key: string, endpoint: Endpoint) => Identity | null | Promise<Identity | null>;
  resolveBinding: (
    tenantId: string,
    capability: Capability,
  ) => Binding | null | Promise<Binding | null>;
  emitUsage: (record: UsageRecord) => void | Promise<void>;
  logRequest?: (record: RequestAudit) => void;
  limits?: Limits;
  limitRepository?: LimitRepository;
  now?: () => number;
  timeoutMs?: number;
};

type Context = Omit<RequestAudit, 'status'> & { signal: AbortSignal };
type CallInput = ChatInput | EmbeddingInput;

function errorShape(error: ApiError) {
  return {
    error: {
      message: error.code.replaceAll('_', ' '),
      type: error.status < 500 ? 'invalid_request_error' : 'server_error',
      param: null,
      code: error.code,
    },
  };
}

function apiError(error: unknown) {
  if (error instanceof ApiError) return error;
  if (error instanceof ProviderError) return new ApiError(502, 'provider_' + error.code);
  if (error instanceof Error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 400 || status === 413 || status === 415) {
      return new ApiError(status, 'invalid_request');
    }
  }
  return new ApiError(503, 'service_unavailable');
}

function modelFor(route: Route, alias: string) {
  return Object.hasOwn(route.models, alias) ? route.models[alias] : undefined;
}

function wireUsage(tokens: Usage) {
  return {
    prompt_tokens: tokens.inputTokens,
    completion_tokens: tokens.outputTokens,
    total_tokens: tokens.inputTokens + tokens.outputTokens,
  };
}

function frame(data: unknown) {
  return 'data: ' + (data === '[DONE]' ? data : JSON.stringify(data)) + '\n\n';
}

function floatBase64(vector: number[]) {
  const bytes = Buffer.alloc(vector.length * 4);
  vector.forEach((coordinate, i) => bytes.writeFloatLE(coordinate, i * 4));
  return bytes.toString('base64');
}

export const llmPlugin: FastifyPluginAsync<LlmPluginOptions> = async (app, options) => {
  const now = options.now ?? Date.now;
  const limits = options.limits ?? { windowMs: 60_000, requests: 60, tokens: 100_000 };
  if (
    ![limits.windowMs, limits.requests, limits.tokens].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  ) {
    throw new Error('Invalid LLM limits');
  }
  const meter = createLimits(
    { ...limits },
    now,
    options.limitRepository ?? new MemoryLimitRepository(),
    (options.timeoutMs ?? 30_000) + 60_000,
  );
  const contexts = new WeakMap<FastifyRequest, Context>();

  function authenticate(endpoint: Endpoint) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000).unref();
      reply.raw.once('close', () => {
        clearTimeout(timer);
        if (!reply.raw.writableFinished) controller.abort();
      });
      const context = { requestId: randomUUID(), endpoint, signal: controller.signal } as Context;
      contexts.set(request, context);
      reply.header('x-request-id', context.requestId).header('cache-control', 'no-store');
      const key = /^Bearer ([^\s,]{1,4096})$/i.exec(request.headers.authorization ?? '')?.[1];
      const identity = key ? await options.verifyApiKey(key, endpoint) : null;
      if (!identity?.tenantId) {
        reply.header('www-authenticate', 'Bearer');
        throw new ApiError(401, 'invalid_api_key');
      }
      context.tenantId = identity.tenantId;
      await meter.request(identity.tenantId);
    };
  }

  app.addHook('onResponse', async (request, reply) => {
    const context = contexts.get(request);
    if (!context) return;
    const { signal: _signal, ...metadata } = context;
    const record = { ...metadata, status: reply.statusCode };
    try {
      if (options.logRequest) options.logRequest(record);
      else request.log.info(record, 'LLM request');
    } catch {
      request.log.warn('LLM request log unavailable');
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const normalized = apiError(error);
    const context = contexts.get(request);
    if (context) context.error = normalized.code;
    return reply.code(normalized.status).send(errorShape(normalized));
  });

  async function route(request: FastifyRequest, reply: FastifyReply, capability: Capability) {
    const context = contexts.get(request)!;
    const binding = await options.resolveBinding(context.tenantId!, capability);
    if (!binding) throw new ApiError(503, 'binding_unavailable');
    context.bindingVersion = binding.version;
    reply.header('x-llm-binding-version', binding.version);
    return { context, binding };
  }

  async function startAttempt<T extends CallInput>(
    context: Context,
    capability: Capability,
    binding: Binding,
    route: Route,
    input: T,
    attempt: number,
  ) {
    const model = modelFor(route, input.model);
    if (!model) throw new ApiError(404, 'model_not_found');
    if (capability === 'embeddings' && !route.adapter.embed) {
      throw new ApiError(422, 'embeddings_unsupported');
    }
    context.signal.throwIfAborted();
    const providerInput = { ...input, model };
    const inputBound = route.estimateInputTokens(providerInput);
    if (!Number.isSafeInteger(inputBound) || inputBound < 0)
      throw new ApiError(503, 'meter_unavailable');
    const outputBound =
      'max_completion_tokens' in providerInput ? providerInput.max_completion_tokens : 0;
    const settle = await meter.reserve(context.tenantId!, inputBound + outputBound);
    context.route = route.routeId;
    let actual: Usage | undefined;
    let finalized = false;
    return {
      input: providerInput,
      capture(tokens: Usage) {
        actual = usage(tokens.inputTokens, tokens.outputTokens);
        if (actual.inputTokens > inputBound || actual.outputTokens > outputBound) {
          throw new ApiError(502, 'token_reservation_exceeded');
        }
      },
      async finish(outcome: UsageRecord['outcome']) {
        if (finalized) return;
        finalized = true;
        try {
          const budgetTokens = await settle(actual);
          await options.emitUsage({
            eventId: context.requestId + '-' + attempt,
            requestId: context.requestId,
            attempt,
            tenantId: context.tenantId!,
            capability,
            bindingVersion: binding.version,
            model,
            provider: route.adapter.provider,
            route: route.routeId,
            priceVersion: route.priceVersion,
            chargeMode: route.chargeMode,
            inputTokens: actual?.inputTokens ?? null,
            outputTokens: actual?.outputTokens ?? null,
            budgetTokens,
            outcome,
          });
        } catch {
          await meter.failMeter(context.tenantId!);
          throw new ApiError(503, 'meter_unavailable');
        }
      },
    };
  }

  function mayFallback(context: Context, binding: Binding, model: string, error: unknown) {
    const fallback = binding.inferenceFallback;
    return fallback &&
      modelFor(fallback, model) &&
      !context.signal.aborted &&
      error instanceof ProviderError &&
      error.code === 'unavailable'
      ? fallback
      : undefined;
  }

  app.get('/llm/v1/models', { onRequest: authenticate('models') }, async (request, reply) => {
    const context = contexts.get(request)!;
    const capabilities = ['llm', 'embeddings'] as const;
    const bindings = await Promise.all(
      capabilities.map((capability) => options.resolveBinding(context.tenantId!, capability)),
    );
    const models = new Map<
      string,
      { id: string; object: 'model'; created: number; owned_by: string }
    >();
    context.bindingVersions = {};
    for (const [index, capability] of capabilities.entries()) {
      const binding = bindings[index];
      if (!binding || (capability === 'embeddings' && !binding.primary.adapter.embed)) continue;
      context.bindingVersions[capability] = binding.version;
      reply.header('x-llm-binding-version-' + capability, binding.version);
      for (const id of Object.keys(binding.primary.models)) {
        if (!models.has(id))
          models.set(id, { id, object: 'model', created: 0, owned_by: 'platform' });
      }
    }
    return { object: 'list', data: [...models.values()] };
  });

  app.post(
    '/llm/v1/embeddings',
    { onRequest: authenticate('embeddings') },
    async (request, reply) => {
      const { input, encoding } = readEmbeddings(request.body);
      const { binding, context } = await route(request, reply, 'embeddings');
      const call = await startAttempt(context, 'embeddings', binding, binding.primary, input, 1);
      let outcome: UsageRecord['outcome'] = 'failed';
      try {
        const result = await binding.primary.adapter.embed!(call.input, context.signal);
        call.capture(result.usage);
        context.signal.throwIfAborted();
        const expected = typeof input.input === 'string' ? 1 : input.input.length;
        const dimension = input.dimensions ?? result.vectors[0]?.length;
        if (
          !dimension ||
          result.vectors.length !== expected ||
          result.vectors.some(
            (vector) =>
              vector.length !== dimension ||
              vector.some((value) => !Number.isFinite(Math.fround(value))),
          )
        ) {
          throw new ProviderError('invalid_response');
        }
        outcome = 'succeeded';
        return {
          object: 'list',
          model: call.input.model,
          data: result.vectors.map((vector, index) => ({
            object: 'embedding',
            index,
            embedding: encoding === 'base64' ? floatBase64(vector) : vector,
          })),
          usage: {
            prompt_tokens: result.usage.inputTokens,
            total_tokens: result.usage.inputTokens,
          },
        };
      } finally {
        await call.finish(context.signal.aborted ? 'cancelled' : outcome);
      }
    },
  );

  app.post(
    '/llm/v1/chat/completions',
    { onRequest: authenticate('chat.completions') },
    async (request, reply) => {
      const { input, stream, includeUsage } = readChat(request.body);
      const check = structuredOutput(input);
      const { binding, context } = await route(request, reply, 'llm');
      const base = { id: 'chatcmpl-' + context.requestId, created: Math.floor(now() / 1000) };

      async function complete(selected: Route, attempt: number) {
        const call = await startAttempt(context, 'llm', binding, selected, input, attempt);
        let outcome: UsageRecord['outcome'] = 'failed';
        try {
          const result = await selected.adapter.complete(call.input, context.signal);
          call.capture(result.usage);
          context.signal.throwIfAborted();
          if (result.finishReason !== 'tool_calls' || !result.toolCalls.length)
            check?.(result.content);
          outcome = 'succeeded';
          return {
            ...base,
            object: 'chat.completion',
            model: call.input.model,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: result.content,
                  ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}),
                },
                finish_reason: result.finishReason,
              },
            ],
            usage: wireUsage(result.usage),
          };
        } finally {
          await call.finish(context.signal.aborted ? 'cancelled' : outcome);
        }
      }

      if (!stream) {
        try {
          return await complete(binding.primary, 1);
        } catch (error) {
          const fallback = mayFallback(context, binding, input.model, error);
          if (!fallback) throw error;
          return complete(fallback, 2);
        }
      }

      async function* events(selected: Route, attempt: number): AsyncGenerator<ChatEvent> {
        const call = await startAttempt(context, 'llm', binding, selected, input, attempt);
        const buffered: ChatEvent[] = [];
        let textBytes = 0;
        let hasTools = false;
        let outcome: UsageRecord['outcome'] = 'failed';
        try {
          for await (const event of selected.adapter.stream(call.input, context.signal)) {
            context.signal.throwIfAborted();
            if (event.type === 'done') {
              call.capture(event.usage);
              if (check && (event.finishReason !== 'tool_calls' || !hasTools)) {
                check(
                  buffered
                    .map((entry) => (entry.type === 'delta' ? (entry.content ?? '') : ''))
                    .join(''),
                );
              }
              outcome = 'succeeded';
              await call.finish(outcome);
              yield* buffered;
              yield event;
              return;
            }
            if (check) {
              hasTools ||= !!event.toolCalls?.length;
              textBytes += Buffer.byteLength(JSON.stringify(event));
              if (textBytes > 1_048_576 || buffered.length >= 8192) {
                throw new ApiError(502, 'structured_output_too_large');
              }
              buffered.push(event);
            } else {
              yield event;
            }
          }
          throw new ProviderError('unavailable');
        } finally {
          await call.finish(context.signal.aborted ? 'cancelled' : outcome);
        }
      }

      let selected = binding.primary;
      let iterator = events(selected, 1);
      let first: IteratorResult<ChatEvent>;
      try {
        first = await iterator.next();
      } catch (error) {
        const fallback = mayFallback(context, binding, input.model, error);
        if (!fallback) throw error;
        selected = fallback;
        iterator = events(selected, 2);
        first = await iterator.next();
      }

      const prefix = {
        ...base,
        object: 'chat.completion.chunk',
        model: modelFor(selected, input.model),
      };
      const choice = (delta: object, finish_reason: string | null = null) =>
        frame({
          ...prefix,
          choices: [{ index: 0, delta, finish_reason }],
          ...(includeUsage ? { usage: null } : {}),
        });

      async function* body() {
        try {
          yield choice({ role: 'assistant' });
          let item = first;
          while (!item.done) {
            context.signal.throwIfAborted();
            const event = item.value;
            if (event.type === 'delta') {
              yield choice({
                ...(event.content === undefined ? {} : { content: event.content }),
                ...(event.toolCalls === undefined ? {} : { tool_calls: event.toolCalls }),
              });
            } else {
              yield choice({}, event.finishReason);
              yield frame({
                ...prefix,
                type: 'final',
                choices: [],
                route: selected.routeId,
                bindingVersion: binding.version,
                usage: wireUsage(event.usage),
              });
              yield frame('[DONE]');
            }
            item = await iterator.next();
          }
        } catch (error) {
          const normalized = apiError(error);
          context.error = normalized.code;
          if (!reply.raw.destroyed) yield frame(errorShape(normalized));
        } finally {
          try {
            await iterator.return(undefined);
          } catch (error) {
            context.error = apiError(error).code;
          }
        }
      }

      const output = Readable.from(body());
      output.once('close', () => {
        // Also return the primed iterator if the client disconnected before the body was pulled.
        void iterator.return(undefined).catch((error: unknown) => {
          context.error = apiError(error).code;
        });
      });
      return reply
        .header('content-type', 'text/event-stream; charset=utf-8')
        .header('x-accel-buffering', 'no')
        .send(output);
    },
  );
};
