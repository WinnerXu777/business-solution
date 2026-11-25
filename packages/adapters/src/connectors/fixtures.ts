import { createHash } from 'node:crypto';
import {
  MemoryOAuthStateStore,
  OAuthPkce,
  requestHttp,
  type HttpClient,
  type HttpRequest,
} from './auth.ts';
import type { ConnectorRegistration } from './lifecycle.ts';
import {
  ConnectorError,
  type ChangePage,
  type Clock,
  type Connector,
  type ConnectorContext,
  type ConnectorManifest,
  type Credential,
  type EffectResolution,
  type Fields,
  type ProviderRecord,
  type Snapshot,
  type WriteRequest,
} from './sdk.ts';

const accountingOrigin = 'https://accounting.fixture.example';
const crmOrigin = 'https://crm.fixture.example';
const fixtureTime = '2026-11-25T15:00:00.000Z';

export const fixtureAccounts = {
  accounting: 'fixture-rivetquay-realm',
  crm: 'fixture-rivetquay-portal',
  crmKey: 'synthetic-crm-key',
} as const;

const accounting: ConnectorManifest = {
  id: 'quickbooks-fixture',
  version: '1.0.0',
  edition: 'QuickBooks Online-shaped',
  environment: 'fixture',
  capability: 'accounting',
  recordClasses: ['customer', 'invoice', 'payment'],
  authoritativeFor: ['customer', 'invoice', 'payment'],
  authType: 'oauth2-pkce',
  scopes: {
    read: ['accounting.read'],
    snapshot: ['accounting.read'],
    listChangedSince: ['accounting.read'],
  },
  rateLimit: { requests: 50, windowMs: 60_000 },
  webhook: { recordClasses: ['customer', 'invoice', 'payment'] },
  dataClasses: ['business-fixture', 'accounting-fixture'],
  region: 'ca-central-1',
};

const crm: ConnectorManifest = {
  id: 'hubspot-fixture',
  version: '1.0.0',
  edition: 'HubSpot-shaped',
  environment: 'fixture',
  capability: 'crm',
  recordClasses: ['company', 'contact', 'deal'],
  authoritativeFor: ['company', 'contact', 'deal'],
  authType: 'api-key',
  scopes: {
    read: ['crm.read'],
    snapshot: ['crm.read'],
    listChangedSince: ['crm.read'],
    write: ['crm.write'],
    reconcile: ['crm.read'],
  },
  rateLimit: { requests: 30, windowMs: 10_000 },
  webhook: { recordClasses: ['company', 'contact', 'deal'] },
  dataClasses: ['business-fixture', 'contact-fixture'],
  region: 'ca-central-1',
};

interface AccountingRow {
  entity: 'Customer' | 'Invoice' | 'Payment';
  Id: string;
  SyncToken: string;
  MetaData: { LastUpdatedTime: string };
  CurrencyRef?: { value: string };
  values: Fields;
}

interface CrmRow {
  objectType: 'companies' | 'contacts' | 'deals';
  id: string;
  revision: string;
  updatedAt: string;
  properties: Fields;
}

type Row = AccountingRow | CrmRow;

function canonicalRecord(row: Row): ProviderRecord {
  if ('Id' in row) {
    return {
      recordClass: row.entity.toLowerCase(),
      externalId: row.Id,
      version: row.SyncToken,
      updatedAt: row.MetaData.LastUpdatedTime,
      currency: row.CurrencyRef?.value,
      fields: row.values,
    };
  }
  const recordClasses = { companies: 'company', contacts: 'contact', deals: 'deal' };
  return {
    recordClass: recordClasses[row.objectType],
    externalId: row.id,
    version: row.revision,
    updatedAt: row.updatedAt,
    fields: row.properties,
  };
}

function createFixtureConnector(
  manifest: ConnectorManifest,
  origin: string,
  http: HttpClient,
): Connector {
  const request = <T>(credential: Credential, path: string, body?: object) =>
    requestHttp(http, {
      url: origin + path,
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${credential.type === 'api-key' ? credential.key : credential.accessToken}`,
      },
      body: body && JSON.stringify(body),
    }) as Promise<T>;
  const page = async (context: ConnectorContext, path: string): Promise<ChangePage> => {
    const wire = await request<{ records: Row[]; checkpoint: string; hasMore: boolean }>(
      context.credential,
      path,
    );
    return { ...wire, records: wire.records.map(canonicalRecord) };
  };
  return {
    manifest,
    async verifyAccount(credential) {
      return (await request<{ accountId: string }>(credential, '/fixture/account')).accountId;
    },
    async read(context, key) {
      const query = new URLSearchParams({
        recordClass: key.recordClass,
        externalId: key.externalId,
      });
      const row = await request<Row | null>(context.credential, `/fixture/record?${query}`);
      return row && canonicalRecord(row);
    },
    async snapshot(context): Promise<Snapshot> {
      const { records, checkpoint } = await page(context, '/fixture/snapshot');
      return { records, checkpoint };
    },
    listChangedSince(context, checkpoint) {
      const query = new URLSearchParams(checkpoint === null ? {} : { checkpoint });
      return page(context, `/fixture/changes?${query}`);
    },
    ...(manifest.scopes.write && {
      write: (context: ConnectorContext, intent: WriteRequest) =>
        request<EffectResolution>(context.credential, '/fixture/write', intent),
      reconcile: (context: ConnectorContext, effectId: string) =>
        request<EffectResolution>(
          context.credential,
          `/fixture/effect?${new URLSearchParams({ effectId })}`,
        ),
    }),
  };
}

export function createFixtureConnectors(clock: Clock = Date.now) {
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const sessions = new Map<string, string>();
  const effects = new Map<string, EffectResolution>();
  let tokenVersion = 0;
  const qbo: AccountingRow[] = [
    {
      entity: 'Customer',
      Id: 'qb-customer-1',
      SyncToken: '0',
      MetaData: { LastUpdatedTime: fixtureTime },
      values: { DisplayName: 'Rivetquay Fixture Customer' },
    },
    {
      entity: 'Invoice',
      Id: 'qb-invoice-1',
      SyncToken: '0',
      MetaData: { LastUpdatedTime: fixtureTime },
      CurrencyRef: { value: 'CAD' },
      values: { CustomerRef: 'qb-customer-1', TotalAmt: '325.00', Balance: '200.00' },
    },
    {
      entity: 'Payment',
      Id: 'qb-payment-1',
      SyncToken: '0',
      MetaData: { LastUpdatedTime: fixtureTime },
      CurrencyRef: { value: 'CAD' },
      values: { CustomerRef: 'qb-customer-1', TotalAmt: '125.00' },
    },
  ];
  const hubspot: CrmRow[] = [
    {
      objectType: 'companies',
      id: 'hs-company-1',
      revision: '1',
      updatedAt: fixtureTime,
      properties: { name: 'Fictional Spindle Works', domain: 'spindle.example' },
    },
    {
      objectType: 'contacts',
      id: 'hs-contact-1',
      revision: '1',
      updatedAt: fixtureTime,
      properties: { firstname: 'Fixture', email: 'fixture@spindle.example' },
    },
    {
      objectType: 'deals',
      id: 'hs-deal-1',
      revision: '1',
      updatedAt: fixtureTime,
      properties: { dealname: 'Synthetic hardware renewal', dealstage: 'qualified' },
    },
  ];
  const changes: { accounting: Row[]; crm: Row[] } = { accounting: [...qbo], crm: [...hubspot] };

  function grant() {
    const id = ++tokenVersion;
    const accessToken = `synthetic-access-${id}`;
    const refreshToken = `synthetic-refresh-${id}`;
    sessions.set(refreshToken, accessToken);
    return {
      status: 200,
      body: {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: 60,
        scope: 'accounting.read',
      },
    };
  }

  function oauthRequest(url: URL, request: HttpRequest) {
    const form = new URLSearchParams(request.body);
    if (request.method !== 'POST' || form.get('client_id') !== 'fixture-accounting-client') {
      return { status: 400, body: null };
    }
    if (url.pathname === '/oauth/revoke') {
      const token = form.get('token') ?? '';
      for (const [refresh, access] of sessions) {
        if (refresh === token || access === token) sessions.delete(refresh);
      }
      return { status: 204, body: null };
    }
    if (form.get('grant_type') === 'refresh_token') {
      if (!sessions.delete(form.get('refresh_token') ?? '')) return { status: 400, body: null };
      return grant();
    }
    const code = form.get('code') ?? '';
    const attempt = codes.get(code);
    codes.delete(code);
    const challenge = createHash('sha256')
      .update(form.get('code_verifier') ?? '')
      .digest('base64url');
    if (
      form.get('grant_type') !== 'authorization_code' ||
      !attempt ||
      attempt.challenge !== challenge ||
      attempt.redirectUri !== form.get('redirect_uri')
    )
      return { status: 400, body: null };
    return grant();
  }

  const http: HttpClient = async (request) => {
    const url = new URL(request.url);
    if (url.origin !== accountingOrigin && url.origin !== crmOrigin) {
      throw new ConnectorError('provider_unavailable');
    }
    const isAccounting = url.origin === accountingOrigin;
    if (isAccounting && ['/oauth/token', '/oauth/revoke'].includes(url.pathname)) {
      return oauthRequest(url, request);
    }
    const token = request.headers?.authorization;
    const authorized = isAccounting
      ? [...sessions.values()].some((access) => token === `Bearer ${access}`)
      : token === `Bearer ${fixtureAccounts.crmKey}`;
    if (!authorized) return { status: 401, body: null };
    const rows = isAccounting ? qbo : hubspot;
    const log = isAccounting ? changes.accounting : changes.crm;
    switch (url.pathname) {
      case '/fixture/account':
        return {
          status: 200,
          body: { accountId: isAccounting ? fixtureAccounts.accounting : fixtureAccounts.crm },
        };
      case '/fixture/record':
        return {
          status: 200,
          body:
            rows.find((row) => {
              const record = canonicalRecord(row);
              return (
                record.recordClass === url.searchParams.get('recordClass') &&
                record.externalId === url.searchParams.get('externalId')
              );
            }) ?? null,
        };
      case '/fixture/snapshot':
        return {
          status: 200,
          body: { records: rows, checkpoint: String(log.length), hasMore: false },
        };
      case '/fixture/changes': {
        const offset = Number(url.searchParams.get('checkpoint') ?? '0');
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > log.length)
          return { status: 409, body: null };
        const next = Math.min(offset + 2, log.length);
        return {
          status: 200,
          body: {
            records: log.slice(offset, next),
            checkpoint: String(next),
            hasMore: next < log.length,
          },
        };
      }
      case '/fixture/write': {
        if (isAccounting || request.method !== 'POST' || !request.body)
          return { status: 403, body: null };
        const { effectId, fields, recordClass, externalId, expectedVersion } = JSON.parse(
          request.body,
        ) as WriteRequest;
        const existing = effects.get(effectId);
        if (existing) return { status: 200, body: existing };
        const index = hubspot.findIndex(
          (row) => canonicalRecord(row).recordClass === recordClass && row.id === externalId,
        );
        const row = hubspot[index];
        const result: EffectResolution = { status: 'not_applied', effectId };
        if (row && row.revision === expectedVersion) {
          const next: CrmRow = {
            ...row,
            properties: { ...row.properties, ...fields },
            revision: String(Number(row.revision) + 1),
            updatedAt: new Date(Math.max(clock(), Date.parse(row.updatedAt) + 1)).toISOString(),
          };
          hubspot[index] = next;
          changes.crm.push(next);
          result.status = 'applied';
        }
        effects.set(effectId, result);
        return { status: 200, body: result };
      }
      case '/fixture/effect': {
        if (isAccounting) return { status: 403, body: null };
        const effectId = url.searchParams.get('effectId') ?? '';
        return { status: 200, body: effects.get(effectId) ?? { status: 'not_applied', effectId } };
      }
    }
    return { status: 404, body: null };
  };

  const registrations: ConnectorRegistration[] = [
    {
      connector: createFixtureConnector(accounting, accountingOrigin, http),
      oauth: new OAuthPkce(
        {
          authorizationEndpoint: accountingOrigin + '/oauth/authorize',
          tokenEndpoint: accountingOrigin + '/oauth/token',
          revocationEndpoint: accountingOrigin + '/oauth/revoke',
          clientId: 'fixture-accounting-client',
          redirectUri: 'https://platform.fixture.example/connectors/oauth/callback',
          scopes: ['accounting.read'],
        },
        http,
        new MemoryOAuthStateStore(),
        clock,
      ),
    },
    { connector: createFixtureConnector(crm, crmOrigin, http) },
  ];
  return {
    registrations,
    /** In-process simulation of an end user completing the fictional consent screen. */
    consent(authorizeUrl: string) {
      const url = new URL(authorizeUrl);
      const challenge = url.searchParams.get('code_challenge');
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');
      if (
        url.href.split('?')[0] !== accountingOrigin + '/oauth/authorize' ||
        url.searchParams.get('code_challenge_method') !== 'S256' ||
        !challenge ||
        !redirectUri ||
        !state
      )
        throw new ConnectorError('validation_failed');
      const code = `synthetic-code-${++tokenVersion}`;
      codes.set(code, { challenge, redirectUri });
      return { state, code };
    },
  };
}
