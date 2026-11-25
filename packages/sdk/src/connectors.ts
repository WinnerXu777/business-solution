import { pathSegment, type CallOptions, type HttpClient } from './http.ts';

type ConnectorOperation = 'read' | 'snapshot' | 'listChangedSince' | 'write' | 'reconcile';
export type ConnectorManifest = {
  id: string;
  version: string;
  edition: string;
  environment: 'fixture' | 'sandbox' | 'production';
  capability: string;
  recordClasses: string[];
  authoritativeFor: string[];
  authType: 'oauth2-pkce' | 'api-key';
  scopes: Partial<Record<ConnectorOperation, string[]>>;
  rateLimit: { requests: number; windowMs: number };
  webhook: false | { recordClasses: string[] };
  dataClasses: string[];
  region: string;
};
type RecordKey = { recordClass: string; externalId: string };
export type ConnectorReport = {
  checkedAt: string;
  checkpoint: string | null;
  missing: RecordKey[];
  added: RecordKey[];
  changed: RecordKey[];
  conflicting: RecordKey[];
};
export type PollResult = {
  checkpoint: string | null;
  syncedAt: string | null;
  pages: number;
  hasMore: boolean;
};
export type SyncRequest = { mode: 'snapshot' } | { mode: 'poll'; maxPages?: number };

export function createConnectorsClient(http: HttpClient) {
  return {
    list: (options?: CallOptions) =>
      http.json<{ connectors: ConnectorManifest[] }>('/connectors', options),
    sync<Input extends SyncRequest>(id: string, input: Input, options?: CallOptions) {
      return http.json<Input extends { mode: 'poll' } ? PollResult : ConnectorReport>(
        `/connectors/${pathSegment(id)}/sync`,
        { ...options, method: 'POST', body: input },
      );
    },
  };
}
