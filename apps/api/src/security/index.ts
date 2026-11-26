import { isIP } from 'node:net';
import { Transform } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { FixedWindowLimiter } from './rate-limit.ts';

declare module 'fastify' {
  interface FastifyContextConfig {
    cookieSession?: boolean;
    requestsPerWindow?: number;
  }
}

export interface SecurityOptions {
  allowedOrigins: readonly string[];
  sessionOrigin?: string;
  verifiedTenant?: (request: FastifyRequest) => string | undefined | Promise<string | undefined>;
  trustedProxyIp?: string;
  bodyLimit?: number;
  jsonDepth?: number;
  windowMs?: number;
  requestsPerIp?: number;
  requestsPerRouteIp?: number;
  requestsPerTenantIp?: number;
  requestsPerTenantRouteIp?: number;
  maxBuckets?: number;
  now?: () => number;
}

const readMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const corsMethods = new Set([...readMethods, 'POST', 'PUT', 'PATCH', 'DELETE']);
const corsHeaders = new Set([
  'authorization',
  'content-type',
  'idempotency-key',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
  'traceparent',
]);

function exactOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || value !== url.origin) {
    throw new TypeError('Expected an exact HTTP origin');
  }
  return value;
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Invalid security limit');
  return value;
}

function requestIp(request: FastifyRequest, proxy: string | undefined): string {
  const peer = request.raw.socket.remoteAddress ?? request.ip;
  const forwarded = request.headers['x-forwarded-for'];
  if (proxy && peer === proxy && typeof forwarded === 'string' && isIP(forwarded)) {
    return forwarded;
  }
  return peer;
}

function exceedsDepth(value: unknown, limit: number): boolean {
  const stack = [{ value, depth: 1 }];
  while (stack.length) {
    const item = stack.pop()!;
    if (!item.value || typeof item.value !== 'object') continue;
    if (item.depth > limit) return true;
    for (const child of Object.values(item.value)) stack.push({ value: child, depth: item.depth + 1 });
  }
  return false;
}

function tooLarge() {
  return Object.assign(new Error('Request body is too large'), { statusCode: 413 });
}

function rateLimited(reply: FastifyReply, retryAfter: number) {
  return reply.header('retry-after', retryAfter).code(429).send({ error: 'rate_limited' });
}

export function sessionCookie(
  name: `__Host-${string}`,
  token: string,
  maxAgeSeconds: number,
  sameSite: 'Strict' | 'Lax' = 'Strict',
): string {
  if (
    !/^__Host-[a-zA-Z0-9_-]+$/.test(name) ||
    !/^[a-zA-Z0-9._~-]*$/.test(token) ||
    !Number.isSafeInteger(maxAgeSeconds) ||
    maxAgeSeconds < 0 ||
    (!token && maxAgeSeconds !== 0) ||
    !['Strict', 'Lax'].includes(sameSite)
  ) {
    throw new TypeError('Invalid session cookie');
  }
  return `${name}=${token}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=${sameSite}`;
}

// Install on the root before registering routes. Authenticate tenants from verified identity only.
export function installSecurity(app: FastifyInstance, options: SecurityOptions): void {
  const allowedOrigins = new Set(options.allowedOrigins.map(exactOrigin));
  const sessionOrigin = options.sessionOrigin && exactOrigin(options.sessionOrigin);
  const bodyLimit = positiveInteger(options.bodyLimit ?? 256 * 1024);
  const jsonDepth = positiveInteger(options.jsonDepth ?? 32);
  const ipBudget = positiveInteger(options.requestsPerIp ?? 600);
  const routeIpBudget = positiveInteger(options.requestsPerRouteIp ?? 120);
  const tenantIpBudget = positiveInteger(options.requestsPerTenantIp ?? 300);
  const tenantRouteIpBudget = positiveInteger(options.requestsPerTenantRouteIp ?? 60);
  const routeBudget = (request: FastifyRequest) => request.routeOptions.config.requestsPerWindow;
  const limits = new FixedWindowLimiter(
    positiveInteger(options.windowMs ?? 60_000),
    positiveInteger(options.maxBuckets ?? 20_000),
    options.now ?? (() => performance.now()),
  );
  if (options.trustedProxyIp !== undefined && !isIP(options.trustedProxyIp)) {
    throw new TypeError('Expected a trusted proxy IP address');
  }

  app.addHook('onRoute', (route) => {
    route.bodyLimit = Math.min(route.bodyLimit ?? app.initialConfig.bodyLimit ?? bodyLimit, bodyLimit);
    if (route.config?.requestsPerWindow !== undefined) {
      positiveInteger(route.config.requestsPerWindow);
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    const preflight = request.method === 'OPTIONS' && request.headers['access-control-request-method'];
    reply
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('x-frame-options', 'DENY')
      .header('referrer-policy', 'no-referrer')
      .header('permissions-policy', 'camera=(), microphone=(), geolocation=()')
      .header('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
      .header('vary', preflight ? 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers' : 'Origin');
    if (origin && allowedOrigins.has(origin)) {
      reply
        .header('access-control-allow-origin', origin)
        .header('access-control-expose-headers', 'Mcp-Session-Id, Retry-After');
      if (origin === sessionOrigin) reply.header('access-control-allow-credentials', 'true');
    }

    // The local container probe has a dedicated route outside the rate budget.
    const path = request.is404 ? 'unmatched' : request.routeOptions.url;
    const ip = requestIp(request, options.trustedProxyIp);
    const route = request.method + ' ' + path;
    const retryAfter =
      path === '/ops/ready' && (ip === '127.0.0.1' || ip === '::1')
        ? 0
        : limits.take(['ip', ip], ipBudget) ||
          limits.take(['route-ip', ip, route], Math.min(routeIpBudget, routeBudget(request) ?? Infinity));
    if (retryAfter) return rateLimited(reply, retryAfter);
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      return reply.code(403).send({ error: 'origin_forbidden' });
    }
    if (request.routeOptions.config.cookieSession && !readMethods.has(request.method)) {
      if (!sessionOrigin || origin !== sessionOrigin) {
        return reply.code(403).send({ error: 'csrf_origin_required' });
      }
    }
  });

  app.options('/*', async (request, reply) => {
    const origin = request.headers.origin;
    const method = request.headers['access-control-request-method'];
    const requested = request.headers['access-control-request-headers'];
    const headers =
      typeof requested === 'string' ? requested.split(',').map((name) => name.trim().toLowerCase()) : [];
    if (!origin || typeof method !== 'string' || !corsMethods.has(method) ||
      (requested !== undefined && typeof requested !== 'string') ||
      headers.some((name) => !corsHeaders.has(name))) {
      return reply.code(403).send({ error: 'preflight_forbidden' });
    }
    if (headers.length) reply.header('access-control-allow-headers', headers.join(', '));
    return reply.header('access-control-allow-methods', method).code(204).send();
  });

  // Also covers routes already declared before a container wrapper installs the hooks.
  app.addHook('preParsing', (request, _reply, payload, done) => {
    const limit = Math.min(request.routeOptions.bodyLimit ?? bodyLimit, bodyLimit);
    if (Number(request.headers['content-length']) > limit) return done(tooLarge());
    if (request.method === 'GET' || request.method === 'HEAD') return done(null, payload);
    const capped = Object.assign(
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          capped.receivedEncodedLength += chunk.length;
          if (capped.receivedEncodedLength > limit) return callback(tooLarge());
          callback(null, chunk);
        },
      }),
      { receivedEncodedLength: 0 },
    );
    // Fastify may reject the content type without attaching a body parser.
    capped.on('error', () => {});
    const forwardError = (error: Error) => capped.destroy(error);
    payload.on('error', forwardError);
    capped.once('close', () => {
      payload.unpipe(capped);
      payload.off('error', forwardError);
    });
    done(null, payload.pipe(capped));
  });

  app.addHook('preValidation', async (request, reply) => {
    const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
    if ((contentType === 'application/json' || contentType?.endsWith('+json')) &&
      exceedsDepth(request.body, jsonDepth)) {
      return reply.code(400).send({ error: 'json_depth_exceeded' });
    }
    const tenant = await options.verifiedTenant?.(request);
    if (tenant === undefined) return;
    const ip = requestIp(request, options.trustedProxyIp);
    const route = request.method + ' ' + request.routeOptions.url;
    const retryAfter =
      limits.take(['tenant-ip', tenant, ip], tenantIpBudget) ||
      limits.take(['tenant-route-ip', tenant, ip, route], Math.min(tenantRouteIpBudget, routeBudget(request) ?? Infinity));
    if (retryAfter) return rateLimited(reply, retryAfter);
  });
}
