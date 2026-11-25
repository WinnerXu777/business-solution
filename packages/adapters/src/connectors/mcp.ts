import {
  ConnectorError,
  type ChangePage,
  type Connector,
  type ConnectorContext,
  type ConnectorManifest,
  type Credential,
  type Fields,
  type Operation,
  type ProviderRecord,
  type RecordKey,
  type Snapshot,
} from './sdk.ts';

export interface InboundMcpClaims {
  subject: string;
  audience: string;
  tenantIds: readonly string[];
  scopes: readonly string[];
}

/** Verifiers authenticate the issuer, signature and lifetime before returning claims. */
export type TokenVerifier<Claims> = (token: string) => Promise<Claims | null>;

async function verifyToken<Claims>(verify: TokenVerifier<Claims>, token: string) {
  try {
    return await verify(token);
  } catch {
    return null;
  }
}

export function mcpCallerVerifier(
  verify: TokenVerifier<InboundMcpClaims>,
  platformAudience: string,
) {
  return async (token: string, tenantId: string, scope: string) => {
    const claims = await verifyToken(verify, token);
    if (!claims || claims.audience !== platformAudience || !claims.subject) {
      throw new ConnectorError('auth_required');
    }
    if (!claims.tenantIds.includes(tenantId) || !claims.scopes.includes(scope)) {
      throw new ConnectorError('permission_denied');
    }
    return { actorId: claims.subject, tenantId };
  };
}

interface PartnerClaims {
  audience: string;
  accountId: string;
  scopes: readonly string[];
}

export interface PartnerMcpServer {
  id: string;
  audience: string;
  tools: Readonly<Record<string, string>>;
  protocolVersion: string;
}

/** Transport binds the approved server ID to an operator-configured endpoint. */
export type McpTransport = (request: {
  serverId: string;
  protocolVersion: string;
  tool: string;
  args: Fields;
  providerToken: string;
}) => Promise<{ structuredContent?: unknown; isError?: boolean }>;

type ReadOperation = Extract<Operation, 'read' | 'snapshot' | 'listChangedSince'>;

export class PartnerMcpConnector implements Connector {
  readonly manifest: ConnectorManifest;
  private readonly server: PartnerMcpServer;
  private readonly names: Record<ReadOperation, string>;

  constructor(options: {
    allowlist: readonly PartnerMcpServer[];
    serverId: string;
    platformAudience: string;
    manifest: ConnectorManifest;
    names: Record<ReadOperation, string>;
    verifyPartnerToken: TokenVerifier<PartnerClaims>;
    transport: McpTransport;
  }) {
    const server = options.allowlist.find((entry) => entry.id === options.serverId);
    if (
      !server ||
      !server.audience ||
      server.audience === options.platformAudience ||
      !server.protocolVersion
    ) {
      throw new ConnectorError('permission_denied');
    }
    this.server = structuredClone(server);
    this.names = structuredClone(options.names);
    this.manifest = structuredClone(options.manifest);
    this.verifyPartnerToken = options.verifyPartnerToken;
    this.transport = options.transport;
    if (this.manifest.scopes.write || this.manifest.scopes.reconcile || this.manifest.webhook) {
      throw new ConnectorError('unsupported');
    }
    for (const operation of ['read', 'snapshot', 'listChangedSince'] as const) {
      this.requiredScope(operation);
    }
  }

  private readonly verifyPartnerToken: TokenVerifier<PartnerClaims>;
  private readonly transport: McpTransport;

  async verifyAccount(credential: Credential) {
    return (await this.grant(credential)).claims.accountId;
  }

  async read(context: ConnectorContext, key: RecordKey): Promise<ProviderRecord | null> {
    if (!this.manifest.recordClasses.includes(key.recordClass) || !key.externalId) {
      throw new ConnectorError('validation_failed');
    }
    const result = await this.call(context, 'read', {
      recordClass: key.recordClass,
      externalId: key.externalId,
    });
    if (!Object.hasOwn(result, 'record')) throw new ConnectorError('validation_failed');
    return result.record as ProviderRecord | null;
  }

  async snapshot(context: ConnectorContext): Promise<Snapshot> {
    return this.page(await this.call(context, 'snapshot', {}));
  }

  async listChangedSince(
    context: ConnectorContext,
    checkpoint: string | null,
  ): Promise<ChangePage> {
    const result = await this.call(context, 'listChangedSince', { checkpoint });
    if (typeof result.hasMore !== 'boolean') throw new ConnectorError('validation_failed');
    return { ...this.page(result), hasMore: result.hasMore };
  }

  private page(result: Record<string, unknown>): Snapshot {
    if (!Array.isArray(result.records) || typeof result.checkpoint !== 'string') {
      throw new ConnectorError('validation_failed');
    }
    return { records: result.records, checkpoint: result.checkpoint };
  }

  private requiredScope(operation: ReadOperation) {
    const name = this.names[operation];
    const scope = Object.hasOwn(this.server.tools, name) && this.server.tools[name];
    if (!scope || !this.manifest.scopes[operation]?.includes(scope)) {
      throw new ConnectorError('permission_denied');
    }
    return scope;
  }

  private async grant(credential: Credential) {
    const providerToken = credential.type === 'api-key' ? credential.key : credential.accessToken;
    const claims = await verifyToken(this.verifyPartnerToken, providerToken);
    if (!claims || claims.audience !== this.server.audience || !claims.accountId) {
      throw new ConnectorError('auth_required');
    }
    return { claims, providerToken };
  }

  private async call(context: ConnectorContext, operation: ReadOperation, args: Fields) {
    const required = this.requiredScope(operation);
    const { claims, providerToken } = await this.grant(context.credential);
    if (
      claims.accountId !== context.accountId ||
      !claims.scopes.includes(required) ||
      this.manifest.scopes[operation]?.some((scope) => !claims.scopes.includes(scope))
    ) {
      throw new ConnectorError('permission_denied');
    }
    let response: Awaited<ReturnType<McpTransport>>;
    try {
      response = await this.transport({
        serverId: this.server.id,
        protocolVersion: this.server.protocolVersion,
        tool: this.names[operation],
        args,
        providerToken,
      });
    } catch {
      throw new ConnectorError('provider_unavailable');
    }
    if (!response || response.isError) throw new ConnectorError('provider_unavailable');
    if (
      !response.structuredContent ||
      typeof response.structuredContent !== 'object' ||
      Array.isArray(response.structuredContent)
    ) {
      throw new ConnectorError('validation_failed');
    }
    return response.structuredContent as Record<string, unknown>;
  }
}
