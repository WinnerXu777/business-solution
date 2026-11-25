import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.ts';

test('health endpoint works through Fastify injection', async (t) => {
  const app = createApp();
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });
});
