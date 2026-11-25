import Fastify from 'fastify';
import { FakeGateway } from '@bs/core';
import { loadDemoFixtures } from '@bs/contracts';
import { createFakeProviders } from '../../../../packages/adapters/src/fake-providers.ts';
import { createFixtureRouter } from '../../../../packages/adapters/src/llm/index.ts';
import { createMessagingAdapters } from '../../../../packages/adapters/src/messaging/index.ts';
import { registerAutomation } from './index.ts';

export function createAutomationDemo(options: { gateway?: FakeGateway; python?: string } = {}) {
  const app = Fastify();
  const fixtures = loadDemoFixtures();
  const gateway =
    options.gateway ??
    new FakeGateway({
      providers: {
        ...createFakeProviders(),
        llm: createFixtureRouter(),
        messages: createMessagingAdapters({
          enabled: process.env.BS_MAILPIT === '1',
          host: process.env.BS_MAILPIT_HOST,
          port: Number(process.env.BS_MAILPIT_PORT ?? 1025),
        }),
      },
    });
  void app.register(
    (instance) =>
      registerAutomation(instance, {
        gateway,
        python: options.python,
        identity: (_request, role) => ({
          tenantId: 'tenant-rivetquay',
          actor: { id: role === 'approver' ? 'actor-approver' : 'actor-operator', kind: 'person' },
        }),
        sign: (scope, id) => gateway.approveFixture(scope, id),
        authorizeRuntime: (scope, capability) => {
          const grant = fixtures.grants.find(
            ({ tenantId, actor }) =>
              tenantId === scope.tenantId &&
              actor.id === scope.actor.id &&
              actor.kind === scope.actor.kind,
          );
          return (
            grant?.role === 'operator' ||
            (grant?.role === 'approver' && (capability === 'bot' || capability === 'workflow'))
          );
        },
      }),
    { prefix: '/automation' },
  );
  return app;
}

if (import.meta.main) {
  await createAutomationDemo().listen({
    host: '127.0.0.1',
    port: Number(process.env.API_PORT ?? 3000),
  });
}
