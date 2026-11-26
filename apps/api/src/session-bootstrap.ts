import type { FastifyInstance } from 'fastify';

const auth = '/platform/v1/auth/';
const access = '__Host-bs_access';
const refresh = '__Host-bs_refresh';
const browser = '__Host-bs_browser';

function readCookie(header: string | undefined, name: string) {
  const values = header?.split(';').map((value) => value.trim())
    .filter((value) => value.startsWith(name + '='));
  if (values?.length === 1) return values[0].slice(name.length + 1);
}

const cookie = (name: string, value: string, maxAge?: number) =>
  name + '=' + value + '; Path=/; Secure; HttpOnly; SameSite=Lax' +
  (maxAge === undefined ? '' : '; Max-Age=' + maxAge);

/** Adapt the existing OIDC bearer exchange to the browser's cookie protocol. */
export function installCookieSessions(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    const accessToken = readCookie(request.headers.cookie, access);
    const refreshToken = readCookie(request.headers.cookie, refresh);
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    const cookieAuth = !request.headers.authorization && accessToken;
    if (mutation && (cookieAuth || (path.startsWith(auth) && refreshToken))) {
      const origin = request.headers.origin;
      const sameOrigin = origin === undefined
        ? request.headers['sec-fetch-site'] === 'same-origin'
        : origin === request.protocol + '://' + request.host;
      if (!sameOrigin) return reply.code(403).send({ code: 'forbidden' });
    }
    if (cookieAuth) request.headers.authorization = 'Bearer ' + accessToken;
  });
  app.addHook('preValidation', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (path === auth + 'login') {
      const query = request.query as { returnTo?: string; tenantId?: string };
      if (query.returnTo !== undefined && query.tenantId === undefined) {
        delete query.returnTo;
        query.tenantId = 'tenant-rivetquay';
        reply.header('Set-Cookie', cookie(browser, '1', 600));
      }
    }
    if (path === auth + 'refresh' || path === auth + 'logout') {
      if (request.body !== undefined) return;
      const token = readCookie(request.headers.cookie, refresh);
      if (!token) {
        if (path.endsWith('/logout')) return reply.code(204).send();
        return reply.code(401).send({ code: 'unauthenticated' });
      }
      request.body = { refreshToken: token };
    }
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const path = request.url.split('?')[0];
    if (!path.startsWith(auth)) return payload;
    const callback = path.endsWith('/callback') && readCookie(request.headers.cookie, browser);
    const session = readCookie(request.headers.cookie, refresh);
    if (!callback && !session) return payload;
    if (path.endsWith('/logout') && reply.statusCode < 300) {
      reply.header('Set-Cookie', [cookie(access, '', 0), cookie(refresh, '', 0)]);
      return payload;
    }
    if ((callback || path.endsWith('/refresh')) && reply.statusCode < 300 &&
      typeof payload === 'string') {
      const value = JSON.parse(payload) as { accessToken?: string; refreshToken?: string; expiresAt?: string };
      if (value.accessToken && value.refreshToken && value.expiresAt) {
        const earlier = reply.getHeader('Set-Cookie');
        reply.header('Set-Cookie', [
          ...(Array.isArray(earlier) ? earlier : typeof earlier === 'string' ? [earlier] : []),
          cookie(access, value.accessToken),
          cookie(refresh, value.refreshToken),
          cookie(browser, '', 0),
        ]);
        return JSON.stringify({ expiresAt: value.expiresAt });
      }
    }
    return payload;
  });
}
