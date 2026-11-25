import { useCallback, useState } from 'react';
import {
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
import { canOperate, capabilityIds, PlatformError } from '../platform-client.ts';
import type { CapabilityId } from '../platform-client.ts';
import type { PlatformRouteContext } from '../platform-app.tsx';
import type {
  BillingAddOn,
  BillingPlan,
  BillingSku,
  CredentialRef,
} from '../clients/administration.ts';
import { cad, Details, ResourceTable, routeId, routeLink } from './feature-helpers.tsx';
import { ModulesScreen } from './reporting.tsx';

export function ModulesAndBillingScreen(props: PlatformRouteContext) {
  return (
    <div className="bs-stack">
      <nav className="bs-feature-actions bs-subnav" aria-label="Modules and billing sections">
        <a href="#/modules" aria-current={props.path === '/modules' ? 'page' : undefined}>
          Module access
        </a>
        <a href="#/billing" aria-current={props.path === '/billing' ? 'page' : undefined}>
          Billing
        </a>
      </nav>
      {props.path === '/modules' ? (
        <ModulesScreen {...props} />
      ) : props.path === '/billing' ? (
        <Billing {...props} />
      ) : (
        <InvoiceDetail {...props} />
      )}
    </div>
  );
}

function Billing({ client, me, notify }: PlatformRouteContext) {
  const api = client.billing;
  const plan = useResource(
    useCallback(async () => {
      const [current, skus] = await Promise.all([api.getPlan(), api.listSkus()]);
      return { current, skus };
    }, [api]),
  );
  const invoices = useResource(useCallback(() => api.listInvoices(), [api]));
  const action = useAction(notify);
  return (
    <div className="bs-stack">
      <RemoteContent resource={plan} label="billing plan">
        {({ current, skus }) => (
          <>
            <Card title="Current plan">
              {current ? (
                <>
                  <Details
                    fields={[
                      [
                        'Subscription',
                        [
                          'Platform',
                          ...current.addOns.map(
                            (id) => skus.find((sku) => sku.id === id)?.name ?? id,
                          ),
                        ].join(', '),
                      ],
                      ['Monthly price', cad(current.monthlyCents)],
                      ['Effective date', current.effectiveAt.slice(0, 10)],
                      [
                        'Billing window',
                        current.windowStart.slice(0, 10) +
                          ' to ' +
                          current.windowEnd.slice(0, 10) +
                          ' (UTC)',
                      ],
                    ]}
                  />
                  <Table
                    label="Billing allowances"
                    rows={current.allowances}
                    rowKey={(row) => row.skuId + ':' + row.unit}
                    columns={[
                      { key: 'sku', title: 'SKU', render: (row) => row.skuId },
                      {
                        key: 'unit',
                        title: 'Unit',
                        render: (row) => row.unit.replaceAll('_', ' '),
                      },
                      { key: 'included', title: 'Included', render: (row) => row.included },
                      { key: 'used', title: 'Used', render: (row) => row.used },
                      { key: 'overage', title: 'Overage', render: (row) => row.overage },
                    ]}
                  />
                </>
              ) : (
                <EmptyState title="No active plan." />
              )}
              {me.role === 'admin' && skus.some(({ id }) => id !== 'platform') && (
                <PlanEditor
                  key={current?.version ?? 'new'}
                  skus={skus}
                  current={current}
                  busy={action.busy}
                  save={(addOns) => {
                    void action.run(
                      () => api.changePlan({ addOns }),
                      () => {
                        plan.reload();
                        notify('Billing plan changed.');
                      },
                    );
                  }}
                />
              )}
            </Card>
            <Card title="SKU catalogue">
              <Table
                label="Billing SKUs"
                rows={skus}
                rowKey={(sku) => sku.id}
                empty="No billing SKUs."
                columns={[
                  { key: 'sku', title: 'SKU', render: (sku) => sku.id },
                  { key: 'name', title: 'Plan', render: (sku) => sku.name },
                  { key: 'price', title: 'Monthly price', render: (sku) => cad(sku.monthlyCents) },
                  {
                    key: 'meters',
                    title: 'Included',
                    render: (sku) =>
                      sku.meters
                        .map(
                          (meter) =>
                            meter.allowance.toLocaleString('en-CA') +
                            ' ' +
                            meter.unit.replaceAll('_', ' '),
                        )
                        .join(', ') || '—',
                  },
                ]}
              />
            </Card>
          </>
        )}
      </RemoteContent>
      <Card title="Billing invoices">
        <RemoteContent resource={invoices} label="billing invoices">
          {({ items, creditNotes }) => (
            <>
              <Table
                label="Billing invoices"
                rows={items}
                rowKey={(row) => row.id}
                empty="No billing invoices."
                columns={[
                  {
                    key: 'id',
                    title: 'Invoice',
                    render: (row) => <a href={routeLink('/billing/invoice', row.id)}>{row.id}</a>,
                  },
                  {
                    key: 'window',
                    title: 'Window start',
                    render: (row) => row.windowStart.slice(0, 10),
                  },
                  {
                    key: 'status',
                    title: 'Status',
                    render: (row) => <StatusPill status={row.status} />,
                  },
                  { key: 'total', title: 'Total', render: (row) => cad(row.totalCents) },
                ]}
              />
              {creditNotes.length > 0 && (
                <Table
                  label="Credit notes"
                  rows={creditNotes}
                  rowKey={(row) => row.id}
                  columns={[
                    { key: 'id', title: 'Credit note', render: (row) => row.id },
                    {
                      key: 'invoice',
                      title: 'Invoice',
                      render: (row) => (
                        <a href={routeLink('/billing/invoice', row.invoiceId)}>{row.invoiceId}</a>
                      ),
                    },
                    { key: 'date', title: 'Issued', render: (row) => row.issuedAt.slice(0, 10) },
                    { key: 'total', title: 'Total', render: (row) => cad(row.totalCents) },
                  ]}
                />
              )}
            </>
          )}
        </RemoteContent>
      </Card>
    </div>
  );
}

function PlanEditor({
  current,
  skus,
  busy,
  save,
}: {
  current: BillingPlan | null;
  skus: BillingSku[];
  busy: boolean;
  save: (addOns: BillingAddOn[]) => void;
}) {
  const [selected, setSelected] = useState<BillingAddOn[]>(current?.addOns ?? []);
  const unchanged =
    selected.length === (current?.addOns.length ?? 0) &&
    selected.every((id) => current?.addOns.includes(id));
  return (
    <form
      className="bs-stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (!unchanged) save(selected);
      }}
    >
      <fieldset className="bs-plan-options" disabled={busy}>
        <legend>Plan add-ons</legend>
        {skus.map(({ id, name, monthlyCents }) =>
          id === 'platform' ? null : (
            <label key={id}>
              <input
                type="checkbox"
                checked={selected.includes(id)}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? [...selected, id]
                      : selected.filter((item) => item !== id),
                  )
                }
              />{' '}
              {name} · {cad(monthlyCents)}/month
            </label>
          ),
        )}
      </fieldset>
      <div>
        <Button type="submit" disabled={busy || unchanged}>
          Change plan
        </Button>
      </div>
    </form>
  );
}

function InvoiceDetail({ client, me, notify, path }: PlatformRouteContext) {
  const id = routeId(path);
  const invoice = useResource(useCallback(() => client.billing.getInvoice(id), [client, id]));
  const [confirm, setConfirm] = useState(false);
  const action = useAction(notify);
  return (
    <Card title={id}>
      <RemoteContent resource={invoice} label="billing invoice">
        {(row) => (
          <div className="bs-stack">
            <Table
              label="Billing line items"
              rows={row.lines.map((line, index) => ({ ...line, index }))}
              rowKey={(line) => String(line.index)}
              empty="No invoice lines."
              columns={[
                { key: 'description', title: 'Description', render: (line) => line.description },
                { key: 'quantity', title: 'Quantity', render: (line) => line.quantity ?? '—' },
                { key: 'sku', title: 'SKU', render: (line) => line.skuId },
                { key: 'total', title: 'Amount', render: (line) => cad(line.amountCents) },
              ]}
            />
            <Details
              fields={[
                ['Status', <StatusPill status={row.status} />],
                [
                  'Window',
                  row.windowStart.slice(0, 10) + ' to ' + row.windowEnd.slice(0, 10) + ' (UTC)',
                ],
                ['Subtotal', cad(row.subtotalCents)],
                [row.tax.code, cad(row.tax.amountCents)],
                ['Total', cad(row.totalCents)],
                ...(row.status === 'finalized'
                  ? ([['Settlement', row.settlement.reference]] as [string, string][])
                  : []),
              ]}
            />
            {me.role === 'admin' && row.status === 'draft' && (
              <div>
                <Button onClick={() => setConfirm(true)}>Finalize invoice</Button>
              </div>
            )}
            {confirm && (
              <Dialog title="Finalize invoice" busy={action.busy} onClose={() => setConfirm(false)}>
                <div className="bs-stack">
                  <p>
                    Finalize {id} for {cad(row.totalCents)} including {row.tax.code}?
                  </p>
                  <div>
                    <Button
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(
                          () => client.billing.finalizeInvoice(id),
                          () => {
                            setConfirm(false);
                            invoice.reload();
                            notify('Invoice finalized.');
                          },
                        )
                      }
                    >
                      Confirm finalize
                    </Button>
                  </div>
                </div>
              </Dialog>
            )}
          </div>
        )}
      </RemoteContent>
    </Card>
  );
}

type CredentialDialog = { mode: 'add' } | { mode: 'rotate' | 'revoke'; entry: CredentialRef };

export function CredentialsScreen({ client, me, notify }: PlatformRouteContext) {
  const api = client.credentials;
  const resource = useResource(useCallback(() => api.list(), [api]));
  const action = useAction(notify);
  const [dialog, setDialog] = useState<CredentialDialog>();
  const admin = me.role === 'admin';
  function done(message: string) {
    setDialog(undefined);
    resource.reload();
    notify(message);
  }

  return (
    <div className="bs-stack">
      {admin && (
        <div>
          <Button onClick={() => setDialog({ mode: 'add' })}>Add credential</Button>
        </div>
      )}
      <ResourceTable
        label="Credential references"
        resource={resource}
        rowKey={(row) => row.ref}
        columns={[
          { key: 'ref', title: 'Reference', render: (row) => <code>{row.ref}</code> },
          ...(admin
            ? [
                {
                  key: 'actions',
                  title: 'Actions',
                  render: (row: CredentialRef) => (
                    <div className="bs-feature-actions">
                      <Button
                        variant="secondary"
                        aria-label={'Rotate ' + row.ref}
                        onClick={() => setDialog({ mode: 'rotate', entry: row })}
                      >
                        Rotate
                      </Button>
                      <Button
                        variant="quiet"
                        aria-label={'Revoke ' + row.ref}
                        onClick={() => setDialog({ mode: 'revoke', entry: row })}
                      >
                        Revoke
                      </Button>
                    </div>
                  ),
                },
              ]
            : []),
        ]}
      />
      {dialog && (
        <Dialog
          title={
            dialog.mode === 'add'
              ? 'Add credential'
              : dialog.mode === 'rotate'
                ? 'Rotate credential'
                : 'Revoke credential'
          }
          busy={action.busy}
          onClose={() => setDialog(undefined)}
        >
          {dialog.mode === 'revoke' ? (
            <div className="bs-stack">
              <p>
                Revoke <code>{dialog.entry.ref}</code>?
              </p>
              <div>
                <Button
                  variant="danger"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(
                      () => api.revoke(dialog.entry.ref),
                      () => done('Credential revoked.'),
                    )
                  }
                >
                  Confirm revoke
                </Button>
              </div>
            </div>
          ) : dialog.mode === 'add' ? (
            <AddCredential
              client={client}
              busy={action.busy}
              submit={(capability, providerId, secret) => {
                void action.run(
                  () => api.add({ capability, providerId, secret }),
                  () => done('Credential added.'),
                );
              }}
            />
          ) : (
            <form
              className="bs-stack"
              onSubmit={(event) => {
                event.preventDefault();
                const secret = takeSecret(event.currentTarget);
                void action.run(
                  () => api.rotate(dialog.entry.ref, secret),
                  () => done('Credential rotated.'),
                );
              }}
            >
              <p>
                Replace the secret for <code>{dialog.entry.ref}</code>.
              </p>
              <SecretField />
              <div>
                <Button type="submit" disabled={action.busy}>
                  Save new secret
                </Button>
              </div>
            </form>
          )}
        </Dialog>
      )}
    </div>
  );
}

function SecretField() {
  return (
    <Field label="Secret" hint="Enter the secret to submit it once.">
      {(props) => (
        <Input
          {...props}
          name="secret"
          autoComplete="new-password"
          type="password"
          maxLength={16384}
          required
        />
      )}
    </Field>
  );
}

function takeSecret(form: HTMLFormElement) {
  const input = form.elements.namedItem('secret');
  if (!(input instanceof HTMLInputElement)) return '';
  const secret = input.value;
  input.value = '';
  return secret;
}

function AddCredential({
  client,
  busy,
  submit,
}: Pick<PlatformRouteContext, 'client'> & {
  busy: boolean;
  submit: (capability: CapabilityId, providerId: string, secret: string) => void;
}) {
  const [capability, setCapability] = useState<CapabilityId>('llm');
  const [providerId, setProvider] = useState('');
  const providers = useResource(
    useCallback(() => client.getProviders(capability), [client, capability]),
  );
  return (
    <form
      className="bs-stack"
      onSubmit={(event) => {
        event.preventDefault();
        const secret = takeSecret(event.currentTarget);
        if (providerId && secret && !busy) submit(capability, providerId, secret);
      }}
    >
      <Field label="Capability">
        {(props) => (
          <Select
            {...props}
            value={capability}
            disabled={busy}
            onChange={(event) => {
              const next = capabilityIds.find((id) => id === event.target.value);
              if (next) {
                setCapability(next);
                setProvider('');
              }
            }}
          >
            {capabilityIds.map((id) => (
              <option key={id}>{id}</option>
            ))}
          </Select>
        )}
      </Field>
      <RemoteContent resource={providers} label="providers">
        {(rows) =>
          rows.length ? (
            <>
              <Field label="Provider">
                {(props) => (
                  <Select
                    {...props}
                    required
                    disabled={busy}
                    value={providerId}
                    onChange={(event) => setProvider(event.target.value)}
                  >
                    <option value="">Select a provider</option>
                    {rows.map((row) => (
                      <option value={row.providerId} key={row.providerId}>
                        {row.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <SecretField />
              <div>
                <Button type="submit" disabled={busy || !providerId}>
                  Save credential
                </Button>
              </div>
            </>
          ) : (
            <EmptyState title="No providers for this capability." />
          )
        }
      </RemoteContent>
    </form>
  );
}

export function ConnectorsScreen(props: PlatformRouteContext) {
  const { client, path } = props;
  const list = useResource(useCallback(() => client.connectors.list(), [client]));
  const id = path.startsWith('/connectors/connector/') ? routeId(path) : undefined;
  return (
    <div className="bs-stack">
      <Card title="Connector catalogue">
        <RemoteContent resource={list} label="connector catalogue">
          {(rows) => (
            <Table
              label="Connectors"
              rows={rows}
              rowKey={(row) => row.id}
              empty="No available connectors."
              columns={[
                {
                  key: 'name',
                  title: 'Connector',
                  render: (row) => (
                    <a href={routeLink('/connectors/connector', row.id)}>{row.name}</a>
                  ),
                },
                { key: 'description', title: 'Description', render: (row) => row.description },
                {
                  key: 'auth',
                  title: 'Authorization',
                  render: (row) => (row.auth === 'oauth' ? 'OAuth' : 'None'),
                },
              ]}
            />
          )}
        </RemoteContent>
      </Card>
      {id && <ConnectorDetail {...props} id={id} />}
    </div>
  );
}

function ConnectorDetail({ client, me, notify, id }: PlatformRouteContext & { id: string }) {
  const api = client.connectors;
  const resource = useResource(useCallback(() => api.status(id), [api, id]));
  const installed = resource.state.status === 'ready' && resource.state.data.state !== 'available';
  const reconciliation = useResource(
    useCallback(
      () => (installed ? api.reconciliation(id) : Promise.resolve(null)),
      [api, id, installed],
    ),
  );
  function reload() {
    resource.reload();
    reconciliation.reload();
  }
  const action = useAction(notify);
  return (
    <Card title="Connector status">
      <RemoteContent resource={resource} label="connector status">
        {(status) => (
          <div className="bs-stack">
            <Details
              fields={[
                ['Connector', id],
                ['Status', <StatusPill status={status.state} />],
                ['Last sync', status.lastSyncAt ?? '—'],
              ]}
            />
            <div className="bs-feature-actions">
              {canOperate(me.role) && status.state === 'available' && (
                <Button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(
                      () => api.install(id),
                      () => {
                        reload();
                        notify('Connector installed.');
                      },
                    )
                  }
                >
                  Install connector
                </Button>
              )}
              {me.role === 'admin' && status.state === 'installed' && (
                <Button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(
                      async () => {
                        const { authorizeUrl } = await api.startOAuth(id);
                        const redirect = new URL(authorizeUrl, window.location.href);
                        const fixtureReturn =
                          authorizeUrl.startsWith('#/') &&
                          redirect.origin === window.location.origin;
                        const loopback =
                          redirect.protocol === 'http:' &&
                          ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname);
                        if (
                          (!fixtureReturn && !loopback && redirect.protocol !== 'https:') ||
                          redirect.username ||
                          redirect.password
                        ) {
                          throw new PlatformError('invalid_input');
                        }
                        return redirect.href;
                      },
                      (location) => {
                        reload();
                        window.location.assign(location);
                      },
                    )
                  }
                >
                  Connect with OAuth
                </Button>
              )}
              {canOperate(me.role) && status.state === 'connected' && (
                <Button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(
                      () => api.sync(id),
                      () => {
                        reload();
                        notify('Connector sync requested.');
                      },
                    )
                  }
                >
                  Trigger sync
                </Button>
              )}
              {status.state !== 'available' && (
                <Button variant="secondary" disabled={action.busy} onClick={reload}>
                  Refresh status
                </Button>
              )}
            </div>
            <h3>Reconciliation report</h3>
            <RemoteContent resource={reconciliation} label="reconciliation report">
              {(report) =>
                report ? (
                  <>
                    <Details
                      fields={[
                        ['Sync', report.syncId],
                        ['Imported', report.imported],
                        ['Unchanged', report.unchanged],
                      ]}
                    />
                    <Table
                      label="Reconciliation issues"
                      rows={report.issues}
                      rowKey={(row) => row.recordId}
                      empty="No reconciliation issues."
                      columns={[
                        { key: 'record', title: 'Record', render: (row) => row.recordId },
                        { key: 'reason', title: 'Issue', render: (row) => row.reason },
                      ]}
                    />
                  </>
                ) : (
                  <EmptyState title="No reconciliation report yet." />
                )
              }
            </RemoteContent>
          </div>
        )}
      </RemoteContent>
    </Card>
  );
}
