import { useCallback, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  Select,
  StatusPill,
  Table,
} from '../components.tsx';
import { RemoteContent, useAction, useResource } from '../data.tsx';
import type { Capability, Provider } from '../platform-client.ts';
import type { ScreenProps } from './screen-helpers.tsx';

const modes = { native: 'Native', byo: 'BYO', premium: 'Premium' };

function ProviderForm({
  providers,
  item,
  client,
  notify,
  onClose,
  onSaved,
  action,
}: ScreenProps & {
  providers: Provider[];
  item: Capability;
  onClose: () => void;
  onSaved: () => void;
  action: ReturnType<typeof useAction>;
}) {
  const [providerId, setProviderId] = useState(item.binding.providerId);
  const [credential, setCredential] = useState('');
  const [fallback, setFallback] = useState(item.binding.fallbackProviderId ?? '');
  const { run, busy } = action;
  const supported = providers.filter((provider) => provider.regions.includes(item.binding.region));
  const selected = supported.find((provider) => provider.providerId === providerId);
  const requiresCredential = selected?.mode === 'byo' && providerId !== item.binding.providerId;
  return (
    <form
      className="bs-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!selected || (requiresCredential && !credential.trim())) return;
        void run(
          () =>
            client.updateBinding(item.capability, {
              providerId,
              ...(credential.trim() &&
                selected.mode !== 'native' && { credentialRef: credential.trim() }),
              ...(fallback && { fallbackProviderId: fallback }),
            }),
          () => {
            notify('Provider binding updated.');
            onSaved();
          },
        );
      }}
    >
      <Field label="Provider" hint={'Eligible region ' + item.binding.region}>
        {(props) => (
          <Select
            {...props}
            disabled={busy}
            value={selected ? providerId : ''}
            onChange={(event) => {
              setProviderId(event.target.value);
              setCredential('');
              if (event.target.value === fallback) setFallback('');
            }}
          >
            {!selected && <option value="">Select a provider</option>}
            {supported.map((provider) => (
              <option key={provider.providerId} value={provider.providerId}>
                {provider.name} ({modes[provider.mode]})
              </option>
            ))}
          </Select>
        )}
      </Field>
      {!supported.length && <EmptyState title="No providers are available in this region." />}
      {selected && (
        <p className="bs-muted">
          {selected.notes} {selected.features.join(' · ')}
        </p>
      )}
      {selected && selected.mode !== 'native' && (
        <Field label="Credential reference" hint="Enter the stored credential reference.">
          {(props) => (
            <Input
              {...props}
              autoComplete="off"
              value={credential}
              required={requiresCredential}
              disabled={busy}
              onChange={(event) => setCredential(event.target.value)}
            />
          )}
        </Field>
      )}
      <Field label="Fallback provider">
        {(props) => (
          <Select
            {...props}
            value={fallback}
            onChange={(event) => setFallback(event.target.value)}
            disabled={busy || !selected}
          >
            <option value="">None</option>
            {supported
              .filter((provider) => provider.providerId !== providerId)
              .map((provider) => (
                <option key={provider.providerId} value={provider.providerId}>
                  {provider.name}
                </option>
              ))}
          </Select>
        )}
      </Field>
      <div className="bs-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={!selected || busy || (requiresCredential && !credential.trim())}
        >
          Save binding
        </Button>
      </div>
    </form>
  );
}

function ProviderDialog({
  item,
  onClose,
  onSaved,
  ...props
}: ScreenProps & {
  item: Capability;
  onClose: () => void;
  onSaved: () => void;
}) {
  const resource = useResource(
    useCallback(() => props.client.getProviders(item.capability), [props.client, item.capability]),
  );
  const action = useAction(props.notify);
  return (
    <Dialog title={'Change provider for ' + item.label} onClose={onClose} busy={action.busy}>
      <RemoteContent resource={resource} label="provider options">
        {(providers) => (
          <ProviderForm
            item={item}
            providers={providers}
            {...props}
            action={action}
            onClose={onClose}
            onSaved={onSaved}
          />
        )}
      </RemoteContent>
    </Dialog>
  );
}
export function ProvidersScreen(props: ScreenProps) {
  const { client, me } = props;
  const resource = useResource(useCallback(() => client.getCapabilities(), [client]));
  const [selected, setSelected] = useState<Capability>();
  return (
    <Card title="Capability bindings">
      <RemoteContent resource={resource} label="capabilities">
        {(items) => (
          <Table
            label="Capability bindings"
            rows={items}
            rowKey={(row) => row.capability}
            pageSize={14}
            empty="No capabilities are assigned to this workspace."
            columns={[
              {
                key: 'capability',
                title: 'Capability',
                sortValue: (row) => row.label,
                render: (row) => <strong>{row.label}</strong>,
              },
              {
                key: 'provider',
                title: 'Current provider',
                render: ({ binding }) => (
                  <>
                    {binding.providerId}
                    <small className="bs-subline">
                      Version {binding.version}
                      {binding.fallbackProviderId && ' · Fallback ' + binding.fallbackProviderId}
                    </small>
                  </>
                ),
              },
              {
                key: 'mode',
                title: 'Mode',
                render: ({ binding }) => <Badge tone="accent">{modes[binding.mode]}</Badge>,
              },
              {
                key: 'status',
                title: 'Status',
                render: ({ binding }) => <StatusPill status={binding.status} />,
              },
              { key: 'region', title: 'Region', render: ({ binding }) => binding.region },
              {
                key: 'data',
                title: 'Data classes',
                render: ({ binding }) => binding.dataClasses.join(', ') || 'None',
              },
              ...(me.role === 'admin'
                ? [
                    {
                      key: 'change',
                      title: 'Manage',
                      render: (row: Capability) => (
                        <Button
                          variant="secondary"
                          aria-label={'Change provider for ' + row.label}
                          onClick={() => setSelected(row)}
                        >
                          Change
                        </Button>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </RemoteContent>
      {selected && (
        <ProviderDialog
          {...props}
          item={selected}
          onClose={() => setSelected(undefined)}
          onSaved={() => {
            setSelected(undefined);
            resource.reload();
          }}
        />
      )}
    </Card>
  );
}
