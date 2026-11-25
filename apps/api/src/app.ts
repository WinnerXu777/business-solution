import Fastify from 'fastify';

export function createApp() {
  const app = Fastify();
  app.get(
    '/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            properties: { status: { const: 'ok' } },
            required: ['status'],
          },
        },
      },
    },
    async () => ({ status: 'ok' }),
  );
  return app;
}
