import { randomUUID } from 'node:crypto';
import { setMaxListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { BotModel } from '../../../../packages/adapters/src/llm/bot.ts';
import {
  InboundError,
  parseSesInbound,
  parseTwilioInbound,
} from '../../../../packages/adapters/src/messaging/inbound.ts';
import type { IceCandidate } from '../../../../packages/adapters/src/voice/peer.ts';
import {
  ConversationError,
  type Conversation,
  type ConversationEvent,
  type Conversations,
  type Participant,
  type Queue,
} from '../../../../packages/core/src/conversations/index.ts';
import {
  bearer,
  ChannelHttpError,
  ChannelLimits,
  field,
  invalid,
  object,
  visitorTokens,
} from './access.ts';
import { ChannelBot } from './bot.ts';
import { Inbound, type ConsentEvent } from './inbound.ts';
import { cursor, sendEvents } from './stream.ts';
import { VoiceCall, type VoiceOptions } from './voice.ts';

type StaffIdentity = { tenantId: string; staffId: string };
export type TenantChannels = {
  origins: readonly string[];
  defaultQueue: string;
  queues: readonly Queue[];
  email?: { recipient: string; secret: string };
  sms?: { recipient: string; signatureUrl: string; authToken: string };
};

export type ChannelsOptions = {
  conversations: Conversations;
  tenants: ReadonlyMap<string, TenantChannels>;
  tokenSecret: string;
  tokenTtlMs?: number;
  verifyStaff: (token: string) => StaffIdentity | null | Promise<StaffIdentity | null>;
  consent: (event: ConsentEvent) => void | Promise<void>;
  model: BotModel;
  voice?: VoiceOptions;
  now?: () => number;
  slaPollMs?: number;
};

const notFound = () => new ChannelHttpError(404, 'not_found');
const conflict = () => new ChannelHttpError(409, 'conflict');
const base = '/channels';
const widget = readFileSync(new URL('./widget.js', import.meta.url), 'utf8');
const summary = ({
  conversationId,
  channel,
  state,
  createdAt,
  assignment,
  resolvedAt,
}: Conversation) => ({ conversationId, channel, state, createdAt, assignment, resolvedAt });

function visitorEvent(event: ConversationEvent) {
  if (event.type === 'state')
    return { cursor: event.cursor, type: event.type, state: event.state, at: event.at };
  if (event.type === 'sla_breached')
    return { cursor: event.cursor, type: event.type, at: event.at };
  if (event.type !== 'message') return event;
  const { id, author, text, at } = event.message;
  return { ...event, message: { id, role: author.role, text, at } };
}

function activity(value: unknown) {
  const data = object(value);
  if (data.type === 'typing' && typeof data.active === 'boolean') return { active: data.active };
  if (data.type === 'read') return { messageId: field(data.messageId) };
  throw invalid();
}

function iceCandidate(value: unknown): IceCandidate | null {
  if (value === null) return null;
  const data = object(value);
  const { sdpMid, sdpMLineIndex, usernameFragment } = data;
  if (
    (sdpMid != null && (typeof sdpMid !== 'string' || sdpMid.length > 256)) ||
    (usernameFragment != null &&
      (typeof usernameFragment !== 'string' || usernameFragment.length > 256)) ||
    (sdpMLineIndex != null &&
      (typeof sdpMLineIndex !== 'number' ||
        !Number.isInteger(sdpMLineIndex) ||
        sdpMLineIndex < 0 ||
        sdpMLineIndex > 65535)) ||
    typeof data.candidate !== 'string' ||
    data.candidate.length > 4096
  )
    throw invalid();
  return { candidate: data.candidate, sdpMid, sdpMLineIndex, usernameFragment };
}

export const channelsPlugin: FastifyPluginAsync<ChannelsOptions> = async (app, options) => {
  const { conversations, tenants } = options;
  const now = options.now ?? Date.now;
  const tokens = visitorTokens(options.tokenSecret, now, options.tokenTtlMs ?? 10 * 60_000);
  const limits = new ChannelLimits(now);
  const inbound = new Inbound(conversations, options.consent);
  const bot = new ChannelBot(conversations, options.model);
  const shutdown = new AbortController();
  setMaxListeners(0, shutdown.signal);
  const calls = new Map<string, VoiceCall>();
  const streams = new Set<string>();
  const turns = new Set<string>();

  for (const [tenantId, tenant] of tenants) {
    if (
      !tenant.queues.some(({ id }) => id === tenant.defaultQueue) ||
      (tenant.email && !tenant.email.secret) ||
      (tenant.sms && (!tenant.sms.authToken || !tenant.sms.signatureUrl))
    ) {
      throw new Error('Invalid channel tenant configuration');
    }
    for (const queue of tenant.queues) conversations.configureQueue(tenantId, queue);
  }

  const sla = setInterval(() => {
    conversations.checkSla();
    limits.sweep();
  }, options.slaPollMs ?? 1_000).unref();
  app.addHook('preClose', async () => {
    clearInterval(sla);
    shutdown.abort();
    for (const call of calls.values()) call.end();
  });

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ChannelHttpError || error instanceof InboundError) {
      return reply.code(error.status).send({ error: error.message });
    }
    if (error instanceof ConversationError) {
      const status = { not_found: 404, conflict: 409, invalid_input: 400 }[error.code];
      return reply.code(status).send({ error: error.code });
    }
    const status = (error as { statusCode?: number } | null)?.statusCode;
    if (status === 400 || status === 413 || status === 415) {
      return reply.code(status).send({ error: 'invalid_input' });
    }
    return reply.code(503).send({ error: 'unavailable' });
  });

  const rawJson = new WeakMap<FastifyRequest, Buffer>();
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, raw, done) => {
    if (!Buffer.isBuffer(raw)) return done(invalid());
    if (request.routeOptions.url?.endsWith(base + '/inbound/email/:tenant')) {
      rawJson.set(request, raw);
      return done(null, undefined);
    }
    return parseJson(request, raw.toString(), done);
  });
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, raw, done) => done(null, raw),
  );

  function origin(request: FastifyRequest, reply: FastifyReply) {
    const query = object(request.query);
    const tenantId = typeof query.tenant === 'string' ? query.tenant : '';
    const tenant = tenants.get(tenantId);
    const value =
      request.headers.origin ??
      (request.method === 'GET' && request.headers['sec-fetch-site'] === 'same-origin'
        ? request.protocol + '://' + request.host
        : undefined);
    if (!value || !tenant?.origins.includes(value))
      throw new ChannelHttpError(403, 'origin_denied');
    reply.header('access-control-allow-origin', value).header('vary', 'Origin');
    return { tenantId, tenant, origin: value, query };
  }

  function session(request: FastifyRequest, reply: FastifyReply, kind: 'web' | 'voice') {
    const context = origin(request, reply);
    const scope = tokens.read(
      bearer(request.headers.authorization),
      context.tenantId,
      context.origin,
      kind,
    );
    limits.take(['visitor', scope.tenantId, scope.customerId], kind === 'voice' ? 120 : 60);
    const customer = { id: scope.customerId, role: 'customer' } as const;
    return { ...context, scope, customer };
  }

  function checkHistory(after: number, count: number) {
    if (after > count) throw invalid();
  }

  function streamSlot(id: string) {
    if (streams.has(id)) throw conflict();
    if (streams.size >= 128) throw new ChannelHttpError(429, 'rate_limited');
    streams.add(id);
    return () => {
      streams.delete(id);
    };
  }

  app.options(base + '/*', async (request, reply) => {
    origin(request, reply);
    return reply
      .header('access-control-allow-methods', 'GET, POST, OPTIONS')
      .header('access-control-allow-headers', 'authorization, content-type, last-event-id')
      .code(204)
      .send();
  });
  app.get(base + '/widget.js', async (_request, reply) =>
    reply.type('application/javascript').send(widget),
  );

  app.post(base + '/widget/session', async (request, reply) => {
    const context = origin(request, reply);
    limits.take(['session', context.tenantId, request.ip], 12);
    if (request.headers.authorization) {
      const prior = tokens.read(
        bearer(request.headers.authorization),
        context.tenantId,
        context.origin,
        'web',
      );
      conversations.get(prior);
      return tokens.issue({ ...prior });
    }
    const customerId = randomUUID();
    const scope = conversations.open(context.tenantId, 'web', customerId);
    return reply.code(201).send(
      tokens.issue({
        tenantId: context.tenantId,
        conversationId: scope.conversationId,
        origin: context.origin,
        customerId,
        kind: 'web',
      }),
    );
  });

  app.post(base + '/widget/messages', { bodyLimit: 16_384 }, async (request, reply) => {
    const { scope, tenant, customer } = session(request, reply, 'web');
    const text = field(object(request.body).text, 4096);
    const id = scope.conversationId;
    if (turns.has(id)) throw conflict();
    const metadata = { channel: 'web' } as const;
    const message = conversations.post(scope, customer, text, metadata);
    const before = conversations.get(scope);
    if (before.state === 'bot') {
      turns.add(id);
      try {
        const deadline = AbortSignal.timeout(10_000);
        await bot.reply(scope, metadata, AbortSignal.any([shutdown.signal, deadline]));
        deadline.throwIfAborted();
      } catch {
        const current = conversations.get(scope);
        if (
          !shutdown.signal.aborted &&
          current.state === 'bot' &&
          current.routingVersion === before.routingVersion
        ) {
          conversations.handoff(scope, tenant.defaultQueue);
        }
      } finally {
        turns.delete(id);
      }
    }
    return reply.code(201).send({ messageId: message.id });
  });

  app.post(base + '/widget/events', async (request, reply) => {
    const { scope, customer } = session(request, reply, 'web');
    conversations.activity(scope, customer, activity(request.body));
    return reply.code(204).send();
  });
  app.post(base + '/widget/handoff', async (request, reply) => {
    const { scope, tenant } = session(request, reply, 'web');
    return summary(conversations.handoff(scope, tenant.defaultQueue));
  });
  app.get(base + '/widget/stream', async (request, reply) => {
    const { scope, query } = session(request, reply, 'web');
    const after = cursor(request.headers['last-event-id'] ?? query.after);
    const events = conversations.get(scope).events;
    checkHistory(after, events.length);
    return sendEvents(
      reply,
      events.slice(after).map(visitorEvent),
      (listener) => conversations.subscribe(scope, (event) => listener(visitorEvent(event))),
      scope.expiresAt - now(),
      streamSlot(scope.conversationId),
      query.once === '1',
      shutdown.signal,
    );
  });

  app.post<{ Params: { tenant: string } }>(
    base + '/inbound/email/:tenant',
    { bodyLimit: 1_048_576 },
    async (request, reply) => {
      const tenantId = request.params.tenant;
      const tenant = tenants.get(tenantId);
      if (!tenant?.email) throw notFound();
      const raw = rawJson.get(request);
      if (!raw) throw invalid();
      const signature = request.headers['x-channel-signature'];
      const records = parseSesInbound(
        raw,
        typeof signature === 'string' ? signature : undefined,
        tenant.email.secret,
        tenant.email.recipient,
      );
      const receipts = [];
      for (const record of records)
        receipts.push(await inbound.email(tenantId, tenant.defaultQueue, record));
      return reply.code(202).send({ receipts });
    },
  );

  app.post<{ Params: { tenant: string } }>(
    base + '/inbound/sms/:tenant',
    { bodyLimit: 32_768 },
    async (request, reply) => {
      const tenantId = request.params.tenant;
      const tenant = tenants.get(tenantId);
      if (!tenant?.sms) throw notFound();
      if (
        typeof request.body !== 'string' ||
        !request.headers['content-type']
          ?.toLowerCase()
          .startsWith('application/x-www-form-urlencoded')
      )
        throw invalid();
      const signature = request.headers['x-twilio-signature'];
      const sms = parseTwilioInbound(
        request.body,
        typeof signature === 'string' ? signature : undefined,
        tenant.sms.signatureUrl,
        tenant.sms.authToken,
      );
      if (sms.to !== tenant.sms.recipient) throw invalid();
      await inbound.sms(tenantId, tenant.defaultQueue, sms);
      return reply.type('text/xml').send('<Response/>');
    },
  );

  app.post(base + '/voice/session', async (request, reply) => {
    const voice = options.voice;
    if (!voice) throw notFound();
    const context = origin(request, reply);
    limits.take(['voice-session', context.tenantId, request.ip], 6);
    const customer = { id: randomUUID(), role: 'customer' } as const;
    const scope = conversations.open(context.tenantId, 'voice', customer.id);
    const lifetime = Math.min(voice.maxCallMs ?? Infinity, options.tokenTtlMs ?? 10 * 60_000);
    const call = new VoiceCall(
      scope,
      customer,
      context.tenant.defaultQueue,
      { ...voice, maxCallMs: lifetime },
      conversations,
      bot,
      now,
    );
    calls.set(scope.conversationId, call);
    return reply.code(201).send({
      ...tokens.issue({
        tenantId: scope.tenantId,
        conversationId: scope.conversationId,
        origin: context.origin,
        customerId: customer.id,
        kind: 'voice',
      }),
      callId: call.record.callId,
    });
  });
  app.post(base + '/voice/signal', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const { scope } = session(request, reply, 'voice');
    const call = calls.get(scope.conversationId);
    if (!call || call.record.tenantId !== scope.tenantId) throw notFound();
    const data = object(request.body);
    switch (data.type) {
      case 'offer':
        await call.offer(field(data.sdp, 60_000));
        break;
      case 'ice':
        await call.ice(iceCandidate(data.candidate));
        break;
      case 'dtmf':
        call.dtmf(field(data.digit, 1));
        break;
      case 'transfer':
        call.transfer();
        break;
      case 'hangup':
        call.end();
        break;
      default:
        throw invalid();
    }
    return reply.code(204).send();
  });
  app.get(base + '/voice/stream', async (request, reply) => {
    const { scope, query } = session(request, reply, 'voice');
    const call = calls.get(scope.conversationId);
    if (!call || call.record.tenantId !== scope.tenantId) throw notFound();
    const after = cursor(request.headers['last-event-id'] ?? query.after);
    return sendEvents(
      reply,
      call.history(after),
      (listener) => call.subscribe(listener),
      scope.expiresAt - now(),
      streamSlot(scope.conversationId),
      query.once === '1' || call.ended,
      shutdown.signal,
    );
  });

  async function staff(request: FastifyRequest) {
    const token = bearer(request.headers.authorization);
    const identity = token ? await options.verifyStaff(token) : null;
    if (!identity) throw new ChannelHttpError(401, 'unauthorized');
    return identity;
  }

  app.get(base + '/staff/queue', async (request) => {
    const { tenantId, staffId } = await staff(request);
    const query = object(request.query);
    const queueId = query.queue === undefined ? undefined : field(query.queue);
    return { conversations: conversations.listForStaff(tenantId, staffId, queueId).map(summary) };
  });
  app.get<{ Params: { id: string } }>(base + '/staff/conversations/:id', async (request) => {
    const { tenantId, staffId } = await staff(request);
    const scope = { tenantId, conversationId: request.params.id };
    const conversation = conversations.canReadAsStaff(scope, staffId);
    return {
      ...summary(conversation),
      participants: conversation.participants,
      transcript: conversation.messages,
      call: conversation.channel === 'voice' ? calls.get(scope.conversationId)?.record : undefined,
    };
  });

  app.post<{ Params: { id: string; action: string } }>(
    base + '/staff/conversations/:id/:action',
    { bodyLimit: 40 * 1024 },
    async (request, reply) => {
      const { tenantId, staffId } = await staff(request);
      const scope = { tenantId, conversationId: request.params.id };
      const author: Participant = { id: staffId, role: 'staff' };
      switch (request.params.action) {
        case 'claim':
          return summary(conversations.claim(scope, staffId));
        case 'resolve':
          return summary(conversations.resolve(scope, staffId));
        case 'handback':
          return summary(conversations.handback(scope, staffId));
        case 'transfer':
          return summary(
            conversations.transfer(scope, staffId, field(object(request.body).queueId)),
          );
        case 'events':
          conversations.activity(scope, author, activity(request.body));
          return reply.code(204).send();
        case 'messages': {
          const conversation = conversations.canReadAsStaff(scope, staffId);
          if (conversation.channel !== 'web') throw conflict();
          const message = conversations.post(
            scope,
            author,
            field(object(request.body).text, 4096),
            { channel: 'web' },
          );
          return reply.code(201).send({ messageId: message.id });
        }
        default:
          throw notFound();
      }
    },
  );
};
