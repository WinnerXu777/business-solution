import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import Fastify from 'fastify';
import { installSecurity, sessionCookie } from '../../src/security/index.ts';

const origin = 'https://portal.example';
const partner = 'https://client.example';
const attacker = 'https://portal.example.attacker.example';

test('headers, exact origins and preflights are enforced', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  installSecurity(app, { allowedOrigins: [origin, partner], sessionOrigin: origin });
  app.post('/message', async () => ({ ok: true }));
  const accepted = await app.inject({ method: 'POST', url: '/message', headers: { origin } });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.headers['access-control-allow-origin'], origin);
  assert.equal(accepted.headers['access-control-allow-credentials'], 'true');
  assert.equal(accepted.headers['x-content-type-options'], 'nosniff');
  assert.equal(accepted.headers['x-frame-options'], 'DENY');
  assert.equal(accepted.headers['cache-control'], 'no-store');
  assert.match(String(accepted.headers['content-security-policy']), /frame-ancestors 'none'/);
  for (const deniedOrigin of [attacker, 'null', origin + '/', origin + ', ' + partner]) {
    const denied = await app.inject({
      method: 'POST',
      url: '/message',
      headers: { origin: deniedOrigin },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
  }
  const preflight = (method: string, headers: string) =>
    app.inject({
      method: 'OPTIONS',
      url: '/message',
      headers: {
        origin: partner,
        'access-control-request-method': method,
        'access-control-request-headers': headers,
      },
    });
  const allowed = await preflight('POST', 'Content-Type, Authorization');
  assert.equal(allowed.statusCode, 204);
  assert.equal(allowed.headers['access-control-allow-methods'], 'POST');
  assert.equal(allowed.headers['access-control-allow-headers'], 'content-type, authorization');
  assert.equal(allowed.headers['access-control-allow-credentials'], undefined);
  assert.match(String(allowed.headers.vary), /Access-Control-Request-Headers/);
  assert.equal((await preflight('CONNECT', 'Authorization')).statusCode, 403);
  assert.equal((await preflight('POST', 'X-Unknown')).statusCode, 403);
});

test('cookie session mutations require the session origin even with Authorization', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  installSecurity(app, { allowedOrigins: [origin, partner], sessionOrigin: origin });
  app.post('/session', { config: { cookieSession: true } }, async (_request, reply) =>
    reply.header('set-cookie', sessionCookie('__Host-session', 'synthetic-token', 300)).send({}),
  );
  app.post('/bearer', async () => ({}));
  const session = (source?: string) =>
    app.inject({
      method: 'POST',
      url: '/session',
      headers: {
        ...(source ? { origin: source } : {}),
        cookie: '__Host-session=synthetic-token',
        authorization: 'Bearer synthetic',
      },
    });
  for (const source of [undefined, partner, attacker]) {
    assert.equal((await session(source)).statusCode, 403);
  }
  const ok = await session(origin);
  assert.equal(ok.statusCode, 200);
  assert.equal(
    ok.headers['set-cookie'],
    '__Host-session=synthetic-token; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=Strict',
  );
  assert.match(sessionCookie('__Host-correlation', '', 0, 'Lax'), /Max-Age=0;.*SameSite=Lax/);
  assert.throws(() => sessionCookie('__Host-session', 'bad; Domain=example', 30), TypeError);
  assert.equal((await app.inject({ method: 'POST', url: '/bearer' })).statusCode, 200);
});

test('raw body and JSON depth caps run before handlers, including chunked payloads', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  app.post('/early', async () => ({}));
  installSecurity(app, { allowedOrigins: [], bodyLimit: 100, jsonDepth: 2 });
  app.post('/small', { bodyLimit: 20 }, async () => ({}));
  const send = (url: string, payload: string | Readable) =>
    app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/json',
        ...(typeof payload === 'string' ? {} : { 'transfer-encoding': 'chunked' }),
      },
      payload,
    });
  assert.equal((await send('/early', '{"a":[1]}')).statusCode, 200);
  assert.equal((await send('/early', '{"a":[{}]}')).json().error, 'json_depth_exceeded');
  assert.equal((await send('/early', JSON.stringify('é'.repeat(51)))).statusCode, 413);
  assert.equal(
    (await send('/early', Readable.from(['"', 'a'.repeat(55), 'b'.repeat(55), '"']))).statusCode,
    413,
  );
  assert.equal((await send('/small', JSON.stringify('a'.repeat(20)))).statusCode, 413);
});

test('rate limits use route templates, verified tenant and the immediate IP', async (t) => {
  let now = 0;
  const app = Fastify({ trustProxy: true });
  t.after(() => app.close());
  installSecurity(app, {
    allowedOrigins: [],
    now: () => now,
    windowMs: 1000,
    requestsPerIp: 6,
    requestsPerTenantIp: 2,
    requestsPerTenantRouteIp: 1,
    verifiedTenant: (request) =>
      request.headers.authorization === 'Bearer a'
        ? 'tenant-a'
        : request.headers.authorization === 'Bearer b'
          ? 'tenant-b'
          : undefined,
  });
  app.get('/item/:id', async () => ({}));
  app.get('/other', async () => ({}));
  app.get('/extra', async () => ({}));
  const send = (url: string, bearer: string, ip = '192.0.2.1') =>
    app.inject({
      url,
      remoteAddress: ip,
      headers: { authorization: 'Bearer ' + bearer, 'x-forwarded-for': '192.0.2.99' },
    });
  assert.equal((await send('/item/a', 'a')).statusCode, 200);
  const routeLimited = await send('/item/b', 'a');
  assert.equal(routeLimited.statusCode, 429);
  assert.equal(routeLimited.headers['retry-after'], '1');
  assert.equal((await send('/item/b', 'b')).statusCode, 200);
  assert.equal((await send('/other', 'a')).statusCode, 429);
  assert.equal((await send('/extra', 'invalid')).statusCode, 200);
  assert.equal((await send('/extra', 'invalid')).statusCode, 200);
  assert.equal((await send('/extra', 'b')).statusCode, 429);
  assert.equal((await send('/item/c', 'a', '192.0.2.2')).statusCode, 200);
  now = 1000;
  assert.equal((await send('/item/c', 'a')).statusCode, 200);
});

test('only the configured proxy can supply one client address', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  installSecurity(app, {
    allowedOrigins: [],
    trustedProxyIp: '192.0.2.1',
    requestsPerIp: 1,
  });
  app.get('/ping', async () => ({}));
  const ping = (peer: string, forwarded: string) =>
    app.inject({ url: '/ping', remoteAddress: peer, headers: { 'x-forwarded-for': forwarded } });
  assert.equal((await ping('192.0.2.1', '192.0.2.8')).statusCode, 200);
  assert.equal((await ping('192.0.2.1', '192.0.2.9')).statusCode, 200);
  assert.equal((await ping('192.0.2.2', '192.0.2.10')).statusCode, 200);
  assert.equal((await ping('192.0.2.2', '192.0.2.11')).statusCode, 429);
  assert.equal((await ping('192.0.2.1', '192.0.2.10, 192.0.2.11')).statusCode, 200);
  assert.equal((await ping('192.0.2.1', '192.0.2.12, 192.0.2.11')).statusCode, 429);
});
