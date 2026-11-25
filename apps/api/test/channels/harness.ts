import Fastify from 'fastify';
import type { TestContext } from 'node:test';
import { createNativeBotModel } from '../../../../packages/adapters/src/llm/bot.ts';
import { createFixtureModelAdapter } from '../../../../packages/adapters/src/llm/fixture.ts';
import {
  Conversations,
  MemoryConversationRepository,
} from '../../../../packages/core/src/conversations/index.ts';
import {
  channelsPlugin,
  type ChannelsOptions,
  type TenantChannels,
} from '../../src/channels/index.ts';
import type { ConsentEvent } from '../../src/channels/inbound.ts';
import { llmPlugin } from '../../src/llm/index.ts';

export const tenantId = 'fictional-tenant-a';
export const otherId = 'fictional-tenant-b';
export const origin = 'https://shop.example';
export const otherOrigin = 'https://other-shop.example';
export const emailSecret = 'fictional email bridge secret';
export const smsSecret = 'fictional sms provider secret';
export const smsUrl = 'https://api.example/channels/inbound/sms/' + tenantId;
export const smsNumber = '+14165550109';
export const emailAddress = 'support@shop.example';
export const staffHeaders = { authorization: 'Bearer fictional-agent' };
export const otherStaff = { authorization: 'Bearer fictional-other-agent' };

export async function harness(t: TestContext, overrides: Partial<ChannelsOptions> = {}) {
  const app = Fastify();
  t.after(() => app.close());
  let time = 1_000_000;
  const now = () => time;
  const conversations = new Conversations(new MemoryConversationRepository(), now);
  const consent: ConsentEvent[] = [];
  const usage: string[] = [];
  const modelInputs: { tenant: string; payload: unknown }[] = [];
  const tenant: TenantChannels = {
    origins: [origin],
    defaultQueue: 'general',
    queues: [
      { id: 'general', skills: ['chat'], slaMs: 90 },
      { id: 'returns', skills: ['returns'], slaMs: 120 },
    ],
    email: { recipient: emailAddress, secret: emailSecret },
    sms: { recipient: smsNumber, signatureUrl: smsUrl, authToken: smsSecret },
  };
  conversations.setStaff(tenantId, { id: 'agent', available: true, skills: ['chat', 'returns'] });
  conversations.setStaff(otherId, { id: 'agent', available: true, skills: ['chat', 'returns'] });
  await app.register(llmPlugin, {
    verifyApiKey(key, endpoint) {
      if (endpoint !== 'chat.completions') return null;
      if (key === 'fictional-key-a') return { tenantId };
      if (key === 'fictional-key-b') return { tenantId: otherId };
      return null;
    },
    resolveBinding(tenant, capability) {
      if (capability !== 'llm') return null;
      usage.push(tenant);
      return {
        version: 'fixture-binding',
        primary: {
          routeId: 'fixture',
          priceVersion: 'fixture-price',
          chargeMode: 'native',
          models: { [tenant === tenantId ? 'shop-chat' : 'other-chat']: 'fixture-model' },
          adapter: createFixtureModelAdapter(),
          estimateInputTokens: (input) => Buffer.byteLength(JSON.stringify(input)),
        },
      };
    },
    emitUsage() {},
  });
  const model = createNativeBotModel(
    async ({ method, path, headers, body }) => {
      const response = await app.inject({
        method,
        url: path,
        headers,
        payload: JSON.stringify(body),
      });
      return { status: response.statusCode, json: async () => response.json() };
    },
    (tenant) =>
      tenant === tenantId
        ? { serviceKey: 'fictional-key-a', modelAlias: 'shop-chat' }
        : tenant === otherId
          ? { serviceKey: 'fictional-key-b', modelAlias: 'other-chat' }
          : undefined,
  );
  await app.register(channelsPlugin, {
    conversations,
    now,
    slaPollMs: 60_000,
    tokenSecret: 'fictional channel secret for tests only',
    tenants: new Map([
      [tenantId, tenant],
      [
        otherId,
        {
          ...tenant,
          origins: [otherOrigin],
          email: {
            recipient: 'support@other-shop.example',
            secret: 'fictional second email secret',
          },
          sms: {
            recipient: '+14165550119',
            signatureUrl: 'https://api.example/channels/inbound/sms/' + otherId,
            authToken: smsSecret,
          },
        },
      ],
    ]),
    verifyStaff: (token) =>
      token === 'fictional-agent'
        ? { tenantId, staffId: 'agent' }
        : token === 'fictional-other-agent'
          ? { tenantId: otherId, staffId: 'agent' }
          : null,
    consent: (event) => {
      consent.push(event);
    },
    model: (tenant, messages, signal) => {
      modelInputs.push({ tenant, payload: messages });
      return model(tenant, messages, signal);
    },
    ...overrides,
  });
  return {
    app,
    conversations,
    consent,
    modelInputs,
    usage,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

export function web(app: Awaited<ReturnType<typeof harness>>['app'], id = tenantId, page = origin) {
  return async (
    method: 'GET' | 'POST' | 'OPTIONS',
    path: string,
    token?: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url: path + (path.includes('?') ? '&' : '?') + 'tenant=' + id,
      headers: { origin: page, ...(token ? { authorization: 'Bearer ' + token } : {}) },
      payload,
    });
}

export function events(body: string) {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}
