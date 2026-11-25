import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  PlatformError,
  type Permission,
  type PlatformAuth,
  type PlatformIdentity,
  type PlatformServices,
  type TenantInput,
} from '../../../../packages/core/src/platform/index.ts';
import document from './openapi.json' with { type: 'json' };

type Schema = Record<string, unknown>;

interface AccessRoutes {
  base: string;
  services: PlatformServices;
  auth?: PlatformAuth;
  context(request: FastifyRequest): PlatformIdentity;
  requirePermission(request: FastifyRequest, permission: Permission, sensitive?: boolean): void;
  requireOperator(request: FastifyRequest): void;
  validate<T>(request: FastifyRequest, schema: Schema, input: unknown): T;
  query<T>(request: FastifyRequest, schema: Schema): T;
}

const cookieName = '__Host-bs_oidc';

function browserToken(request: FastifyRequest) {
  const cookies = request.headers.cookie?.split(';').map((cookie) => cookie.trim()) ?? [];
  const matches = cookies.filter((cookie) => cookie.startsWith(cookieName + '='));
  if (matches.length === 1) return matches[0].slice(cookieName.length + 1);
}

export function registerAccessRoutes(
  app: FastifyInstance,
  {
    base,
    services,
    auth,
    context,
    requirePermission,
    requireOperator,
    validate,
    query,
  }: AccessRoutes,
) {
  const { directory } = services;
  const schemas = document.components.schemas;
  const publicRoute = { config: { platformPublic: true } };
  const accessRoute = { config: { platformAccess: true } };
  const callbackPath = base + '/auth/callback';

  function cookie(token: string, maxAge: number) {
    return (
      cookieName + '=' + token + '; Path=/; Max-Age=' + maxAge + '; Secure; HttpOnly; SameSite=Lax'
    );
  }

  function oidc() {
    if (!auth) throw new PlatformError('unavailable');
    return auth;
  }

  app.get(base + '/auth/login', publicRoute, async (request, reply) => {
    const { tenantId, stepUp } = query<{ tenantId: string; stepUp?: 'true' | 'false' }>(
      request,
      schemas.AuthLogin,
    );
    const attempt = await oidc().login(tenantId, stepUp === 'true');
    reply.header('Set-Cookie', cookie(attempt.browserToken, attempt.maxAgeSeconds));
    return { authorizeUrl: attempt.authorizeUrl };
  });

  app.get(callbackPath, publicRoute, async (request, reply) => {
    const { state, code } = query<{ state: string; code: string }>(request, schemas.AuthCallback);
    const result = await oidc().callback(state, code, browserToken(request));
    reply.header('Set-Cookie', cookie('', 0));
    return result;
  });

  app.post(base + '/auth/refresh', publicRoute, async (request) => {
    const { refreshToken } = validate<{ refreshToken: string }>(
      request,
      schemas.RefreshRequest,
      request.body,
    );
    return oidc().sessions.refresh(refreshToken);
  });

  app.post(base + '/auth/logout', publicRoute, async (request) => {
    const { refreshToken } = validate<{ refreshToken: string }>(
      request,
      schemas.RefreshRequest,
      request.body,
    );
    return oidc().logout(refreshToken);
  });

  app.get(base + '/members', accessRoute, async (request) => {
    requirePermission(request, 'members.read');
    return directory.members(context(request).tenantId);
  });

  app.post(base + '/invites', async (request, reply) => {
    requirePermission(request, 'members.manage', true);
    const { email, roleId } = validate<{ email: string; roleId: string }>(
      request,
      schemas.InviteCreate,
      request.body,
    );
    const invite = directory.createInvite(context(request), email, roleId);
    return reply.code(201).send(invite);
  });

  app.post<{ Params: { token: string } }>(
    base + '/invites/:token/accept',
    publicRoute,
    async (request) => {
      const token = validate<string>(request, schemas.OpaqueAuthToken, request.params.token);
      const { enrollmentToken } = validate<{ enrollmentToken: string }>(
        request,
        schemas.InviteAccept,
        request.body,
      );
      return oidc().acceptInvite(token, enrollmentToken);
    },
  );

  app.patch<{ Params: { id: string } }>(base + '/members/:id/role', async (request) => {
    requirePermission(request, 'members.manage', true);
    const id = validate<string>(request, schemas.Id, request.params.id);
    const { roleId } = validate<{ roleId: string }>(
      request,
      schemas.MemberRoleUpdate,
      request.body,
    );
    return directory.assignRole(context(request), id, roleId);
  });

  app.delete<{ Params: { id: string } }>(base + '/members/:id', async (request, reply) => {
    requirePermission(request, 'members.manage', true);
    const id = validate<string>(request, schemas.Id, request.params.id);
    directory.removeMember(context(request), id);
    return reply.code(204).send();
  });

  app.get(base + '/roles', accessRoute, async (request) => {
    requirePermission(request, 'roles.read');
    return directory.roles(context(request).tenantId);
  });

  app.post(base + '/roles', async (request, reply) => {
    requirePermission(request, 'roles.manage', true);
    const input = validate<Parameters<typeof directory.createRole>[1]>(
      request,
      schemas.RoleCreate,
      request.body,
    );
    return reply.code(201).send(directory.createRole(context(request), input));
  });

  app.post(base + '/tenants', async (request, reply) => {
    requireOperator(request);
    const input = validate<TenantInput>(request, schemas.TenantCreate, request.body);
    return reply.code(201).send(directory.provision(input));
  });

  for (const action of ['suspend', 'resume'] as const) {
    app.post<{ Params: { id: string } }>(base + '/tenants/:id/' + action, async (request) => {
      requireOperator(request);
      const id = validate<string>(request, schemas.Id, request.params.id);
      return directory.setTenantStatus(id, action === 'suspend' ? 'suspended' : 'active');
    });
  }
}
