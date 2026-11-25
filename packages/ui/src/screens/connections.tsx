import { useCallback, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  Dialog,
  Field,
  Input,
  Select,
  Table,
} from '../components.tsx';
import { RemoteContent, useAction, useResource } from '../data.tsx';
import { canCreateConnection } from '../platform-client.ts';
import type { Connection, NewConnection } from '../platform-client.ts';
import { formatTime } from './reporting.tsx';
import type { ScreenProps } from './screen-helpers.tsx';

const kinds = { api_client: 'API client', mcp_client: 'MCP client' };

function NewConnectionDialog({
  client,
  notify,
  onClose,
  reload,
}: ScreenProps & { onClose: () => void; reload: () => void }) {
  const [kind, setKind] = useState<NewConnection['kind']>('api_client');
  const [name, setName] = useState('');
  const [rawScopes, setScopes] = useState('');
  const [secret, setSecret] = useState<string>();
  const { busy, run } = useAction(notify);
  const scopes = [
    ...new Set(
      rawScopes
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  ];
  return (
    <Dialog
      title={secret === undefined ? 'Create connection' : 'Connection secret'}
      busy={busy}
      onClose={onClose}
    >
      {secret !== undefined ? (
        <div className="bs-form">
          <p>Copy this secret now. It is shown only once.</p>
          <CodeBlock label="Connection secret">{secret}</CodeBlock>
          <div className="bs-actions">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <form
          className="bs-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || !scopes.length) return;
            void run(
              () => client.createConnection({ kind, name: name.trim(), scopes }),
              (result) => {
                setSecret(result.secret);
                reload();
                notify('Connection created.');
              },
            );
          }}
        >
          <Field label="Client type">
            {(props) => (
              <Select
                {...props}
                value={kind}
                disabled={busy}
                onChange={(event) => setKind(event.target.value as NewConnection['kind'])}
              >
                {Object.entries(kinds).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Name">
            {(props) => (
              <Input
                {...props}
                required
                value={name}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <Field label="Scopes" hint="Separate scopes with commas.">
            {(props) => (
              <Input
                {...props}
                required
                value={rawScopes}
                disabled={busy}
                onChange={(event) => setScopes(event.target.value)}
              />
            )}
          </Field>
          <div className="bs-actions">
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || !scopes.length}>
              Create client
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function RevokeDialog({
  row,
  client,
  notify,
  onClose,
  reload,
}: ScreenProps & { row: Connection; onClose: () => void; reload: () => void }) {
  const { busy, run } = useAction(notify);
  return (
    <Dialog title="Revoke connection" busy={busy} onClose={onClose}>
      <p>
        <strong>{row.name}</strong> will lose access to this workspace.
      </p>
      <div className="bs-actions bs-confirm">
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => {
            void run(
              () => client.revokeConnection(row.id),
              () => {
                notify('Connection revoked.');
                onClose();
                reload();
              },
            );
          }}
        >
          Confirm revoke
        </Button>
      </div>
    </Dialog>
  );
}

export function ConnectionsScreen(props: ScreenProps) {
  const { client, me } = props;
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<Connection>();
  const resource = useResource(useCallback(() => client.getConnections(), [client]));
  return (
    <Card
      title="API and MCP clients"
      action={
        canCreateConnection(me.role) && (
          <Button onClick={() => setCreating(true)}>New connection</Button>
        )
      }
    >
      <RemoteContent resource={resource} label="connections">
        {(rows) => (
          <Table
            label="Connections"
            rows={rows}
            rowKey={(row) => row.id}
            empty="No clients are connected to this workspace."
            columns={[
              {
                key: 'name',
                title: 'Name',
                render: (row) => (
                  <>
                    <strong>{row.name}</strong>
                    <small className="bs-subline">{row.id}</small>
                  </>
                ),
                sortValue: (row) => row.name,
              },
              { key: 'kind', title: 'Type', render: (row) => <Badge>{kinds[row.kind]}</Badge> },
              { key: 'scopes', title: 'Scopes', render: (row) => row.scopes.join(', ') },
              {
                key: 'created',
                title: 'Created (Toronto)',
                render: (row) => formatTime(row.createdAt),
              },
              {
                key: 'last',
                title: 'Last used (Toronto)',
                render: (row) => (row.lastUsedAt ? formatTime(row.lastUsedAt) : 'Never'),
              },
              ...(me.role === 'admin'
                ? [
                    {
                      key: 'revoke',
                      title: 'Manage',
                      render: (row: Connection) => (
                        <Button
                          variant="secondary"
                          aria-label={'Revoke ' + row.name}
                          onClick={() => setRevoking(row)}
                        >
                          Revoke
                        </Button>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </RemoteContent>
      {creating && (
        <NewConnectionDialog
          {...props}
          onClose={() => setCreating(false)}
          reload={resource.reload}
        />
      )}
      {revoking && (
        <RevokeDialog
          {...props}
          row={revoking}
          onClose={() => setRevoking(undefined)}
          reload={resource.reload}
        />
      )}
    </Card>
  );
}
