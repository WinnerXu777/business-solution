import { useCallback, useState } from 'react';
import { Button, Card, Dialog } from '../components.tsx';
import { agingBuckets, collectionChannels } from '../clients/bot-policies.ts';
import type { BotPolicyMap, CommitmentInput } from '../clients/bot-policies.ts';
import { RemoteContent, useAction, useResource } from '../data.tsx';
import { useI18n } from '../i18n.tsx';
import type { PlatformRouteContext } from '../platform-app.tsx';
import { canOperate, canReview, PlatformError } from '../platform-client.ts';
import { Form, List, Status, Submit, TextField, field } from './round-four.tsx';
import { routeId, routeLink } from './feature-helpers.tsx';
import { validId } from '../clients/workflow-definition.ts';

export function ProcurementScreen(props: PlatformRouteContext) {
  const { client, path } = props;
  const api = client.botPolicies;
  const { t, number, cad } = useI18n();
  const queue = useResource(useCallback(() => api.listExceptions(), [api]));
  const id = path.startsWith('/bots/procurement/match/') ? routeId(path) : '';
  return (
    <div className="bs-stack">
      <PolicySettings {...props} id="procurement" />
      <Card title={t('Three-way match')}>
        <Form
          onSubmit={(data) => {
            const poId = field(data, 'po');
            if (validId(poId)) window.location.hash = routeLink('/bots/procurement/match', poId);
          }}
        >
          <TextField label="Purchase order ID" name="po" />
          <Submit label="Open match" />
        </Form>
      </Card>
      {id && <PurchaseMatch key={id} id={id} api={api} format={{ number, cad }} />}
      <List
        title="Procurement exceptions"
        load={queue}
        columns={[
          {
            key: 'po',
            title: 'Purchase order ID',
            render: (row) => (
              <a href={routeLink('/bots/procurement/match', row.poId)}>{row.poId}</a>
            ),
          },
          { key: 'reason', title: 'Reason', render: (row) => t(row.reason) },
          { key: 'status', title: 'Status', render: (row) => <Status value={row.status} /> },
        ]}
      />
    </div>
  );
}

function PurchaseMatch({
  id,
  api,
  format,
}: {
  id: string;
  api: PlatformRouteContext['client']['botPolicies'];
  format: Pick<ReturnType<typeof useI18n>, 'number' | 'cad'>;
}) {
  const { t } = useI18n();
  const load = useResource(useCallback(() => api.getMatch(id), [api, id]));
  return (
    <Card title={t('Match for {id}', { id })}>
      <RemoteContent resource={load} label={t('Three-way match')}>
        {(row) => (
          <>
            <p>
              {t('Receipt')} · {row.receiptId ?? '—'} | {t('Invoice')} · {row.invoiceId ?? '—'}
            </p>
            {row.lines.length ? (
              <ul>
                {row.lines.map((line, i) => (
                  <li key={i}>
                    <strong>{line.skuId}</strong> · {t('Ordered')} {format.number(line.ordered)} ·{' '}
                    {t('Received')} {format.number(line.received)} · {t('Invoiced')}{' '}
                    {format.number(line.invoiced)} · {format.cad(line.unitPriceCents)} /{' '}
                    {format.cad(line.invoiceUnitPriceCents)}
                    {(line.ordered !== line.received ||
                      line.received !== line.invoiced ||
                      line.unitPriceCents !== line.invoiceUnitPriceCents) && (
                      <>
                        {' '}
                        · <Status value="Mismatch" danger />
                      </>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p>{t('No entries.')}</p>
            )}
          </>
        )}
      </RemoteContent>
    </Card>
  );
}

export function CollectionsScreen(props: PlatformRouteContext) {
  const { client, path, me, notify } = props;
  const api = client.botPolicies;
  const { t, date, cad, number } = useI18n();
  const [approve, setApprove] = useState<string>();
  const promises = useResource(useCallback(() => api.listPromises(), [api]));
  const plans = useResource(useCallback(() => api.listPaymentPlans(), [api]));
  const [timelineRevision, setTimelineRevision] = useState(0);
  const action = useAction(notify);
  const id = path.startsWith('/bots/collections/account/') ? routeId(path) : '';
  return (
    <div className="bs-stack">
      <PolicySettings {...props} id="collections" />
      <Card title={t('Account timeline')}>
        <Form
          onSubmit={(data) => {
            const customer = field(data, 'customer');
            if (validId(customer))
              window.location.hash = routeLink('/bots/collections/account', customer);
          }}
        >
          <TextField label="Customer ID" name="customer" />
          <Submit label="Open timeline" />
        </Form>
      </Card>
      {id && <AccountTimeline key={id + ':' + timelineRevision} id={id} api={api} />}
      {canOperate(me.role) && (
        <>
          <Card title={t('Record a promise to pay')}>
            <CommitmentForm
              customerId={id}
              busy={action.busy}
              onSubmit={(row) =>
                void action.run(
                  () => api.createPromise(row),
                  () => {
                    promises.reload();
                    setTimelineRevision((value) => value + 1);
                    notify(t('Promise recorded.'));
                  },
                )
              }
            />
          </Card>
          <Card title={t('Request a payment plan')}>
            <CommitmentForm
              customerId={id}
              plan
              busy={action.busy}
              onSubmit={(row, installments) =>
                void action.run(
                  () => api.createPaymentPlan({ ...row, installments }),
                  () => {
                    plans.reload();
                    setTimelineRevision((value) => value + 1);
                    notify(t('Payment plan requested.'));
                  },
                )
              }
            />
          </Card>
        </>
      )}
      <List
        title="Promises to pay"
        load={promises}
        columns={[
          {
            key: 'customer',
            title: 'Customer ID',
            render: (row) => (
              <a href={routeLink('/bots/collections/account', row.customerId)}>{row.customerId}</a>
            ),
          },
          { key: 'amount', title: 'Amount', render: (row) => cad(row.amountCents) },
          { key: 'due', title: 'Due date', render: (row) => date(row.dueOn) },
          { key: 'status', title: 'Status', render: (row) => <Status value={row.status} /> },
        ]}
      />
      <List
        title="Payment plans"
        load={plans}
        columns={[
          { key: 'id', title: 'Plan ID', render: (row) => row.id },
          {
            key: 'customer',
            title: 'Customer ID',
            render: (row) => (
              <a href={routeLink('/bots/collections/account', row.customerId)}>{row.customerId}</a>
            ),
          },
          { key: 'amount', title: 'Amount', render: (row) => cad(row.amountCents) },
          { key: 'due', title: 'Due date', render: (row) => date(row.dueOn) },
          { key: 'installments', title: 'Installments', render: (row) => number(row.installments) },
          { key: 'status', title: 'Status', render: (row) => <Status value={row.status} /> },
          ...(canReview(me.role)
            ? [
                {
                  key: 'action',
                  title: 'Action',
                  render: (row: Awaited<ReturnType<typeof api.listPaymentPlans>>[number]) =>
                    row.status === 'pending_approval' &&
                    row.requestedBy !== me.actor.id && (
                      <Button variant="secondary" onClick={() => setApprove(row.id)}>
                        {t('Approve payment plan')}
                      </Button>
                    ),
                },
              ]
            : []),
        ]}
      />
      {approve && (
        <Dialog
          title={t('Approve payment plan')}
          busy={action.busy}
          onClose={() => setApprove(undefined)}
        >
          <p>{t('Approve payment plan {id}?', { id: approve })}</p>
          <Button
            disabled={action.busy}
            onClick={() =>
              void action.run(
                () => api.approvePaymentPlan(approve),
                () => {
                  setApprove(undefined);
                  plans.reload();
                  notify(t('Payment plan approved.'));
                },
              )
            }
          >
            {t('Confirm approval')}
          </Button>
        </Dialog>
      )}
    </div>
  );
}

function AccountTimeline({
  id,
  api,
}: {
  id: string;
  api: PlatformRouteContext['client']['botPolicies'];
}) {
  const { t, date, cad } = useI18n();
  const load = useResource(useCallback(() => api.accountTimeline(id), [api, id]));
  return (
    <List
      title="Timeline entries"
      load={load}
      columns={[
        { key: 'at', title: 'Date', render: (row) => date(row.at, true) },
        { key: 'kind', title: 'Type', render: (row) => t(row.kind) },
        { key: 'reference', title: 'Reference', render: (row) => row.referenceId },
        {
          key: 'amount',
          title: 'Amount',
          render: (row) => (row.amountCents === undefined ? '—' : cad(row.amountCents)),
        },
      ]}
    />
  );
}

function CommitmentForm({
  customerId,
  plan,
  busy,
  onSubmit,
}: {
  customerId: string;
  plan?: boolean;
  busy: boolean;
  onSubmit: (input: CommitmentInput, installments: number) => void;
}) {
  return (
    <Form
      onSubmit={(data) =>
        onSubmit(
          {
            customerId: field(data, 'customer'),
            amountCents: Math.round(Number(field(data, 'amount')) * 100),
            dueOn: field(data, 'due'),
          },
          Number(field(data, 'installments')),
        )
      }
    >
      <TextField
        label="Customer ID"
        name="customer"
        defaultValue={customerId}
        pattern="[a-zA-Z0-9][a-zA-Z0-9._:\\-]{0,127}"
      />
      <TextField
        label="Amount (CAD)"
        name="amount"
        type="number"
        min="0.01"
        step="0.01"
        max="999999999"
      />
      <TextField label="Due date" name="due" type="date" />
      {plan && (
        <TextField
          label="Installments"
          name="installments"
          type="number"
          min={2}
          max={120}
          defaultValue={2}
        />
      )}
      <Submit label={plan ? 'Request payment plan' : 'Record promise'} busy={busy} />
    </Form>
  );
}

function PolicySettings({
  client,
  me,
  notify,
  id,
}: PlatformRouteContext & { id: keyof BotPolicyMap }) {
  const api = client.botPolicies;
  const { t, cad, number } = useI18n();
  const procurement = useResource(
    useCallback(
      () => (id === 'procurement' ? api.getPolicy('procurement') : Promise.resolve(null)),
      [api, id],
    ),
  );
  const collections = useResource(
    useCallback(
      () => (id === 'collections' ? api.getPolicy('collections') : Promise.resolve(null)),
      [api, id],
    ),
  );
  const [revision, setRevision] = useState(0);
  const action = useAction(notify);
  const edit = me.role === 'admin';
  function saved(reload: () => void) {
    reload();
    setRevision((value) => value + 1);
    notify(t('Bot policy saved.'));
  }
  return (
    <Card title={t(id === 'procurement' ? 'Procurement settings' : 'Collections settings')}>
      {id === 'procurement' ? (
        <RemoteContent resource={procurement} label={t('Procurement settings')}>
          {(row) =>
            row &&
            (edit ? (
              <Form
                key={revision + ':' + JSON.stringify(row)}
                onSubmit={(data) =>
                  void action.run(
                    async () => {
                      const authorityLimitCents = Math.round(
                        Number(field(data, 'authority')) * 100,
                      );
                      const approvalThresholdCents = Math.round(
                        Number(field(data, 'threshold')) * 100,
                      );
                      const preferredVendorIds = [
                        ...new Set(
                          field(data, 'vendors')
                            .split(/[,\s]+/)
                            .filter(Boolean),
                        ),
                      ];
                      if (
                        approvalThresholdCents > authorityLimitCents ||
                        !preferredVendorIds.every(validId)
                      )
                        throw new PlatformError('invalid_input');
                      return api.savePolicy('procurement', {
                        authorityLimitCents,
                        approvalThresholdCents,
                        preferredVendorIds,
                      });
                    },
                    () => saved(procurement.reload),
                  )
                }
              >
                <TextField
                  label="Authority limit (CAD)"
                  name="authority"
                  type="number"
                  min={0}
                  step="0.01"
                  max="999999999"
                  defaultValue={row.authorityLimitCents / 100}
                />
                <TextField
                  label="Approval threshold (CAD)"
                  name="threshold"
                  type="number"
                  min={0}
                  step="0.01"
                  max="999999999"
                  defaultValue={row.approvalThresholdCents / 100}
                />
                <TextField
                  label="Preferred vendor IDs"
                  name="vendors"
                  required={false}
                  defaultValue={row.preferredVendorIds.join(', ')}
                />
                <Submit busy={action.busy} label="Save policy" />
              </Form>
            ) : (
              <ul>
                <li>
                  {t('Authority limit (CAD)')} · {cad(row.authorityLimitCents)}
                </li>
                <li>
                  {t('Approval threshold (CAD)')} · {cad(row.approvalThresholdCents)}
                </li>
                <li>
                  {t('Preferred vendor IDs')} · {row.preferredVendorIds.join(', ') || '—'}
                </li>
              </ul>
            ))
          }
        </RemoteContent>
      ) : (
        <RemoteContent resource={collections} label={t('Collections settings')}>
          {(row) =>
            row &&
            (edit ? (
              <Form
                key={revision + ':' + JSON.stringify(row)}
                onSubmit={(data) =>
                  void action.run(
                    async () => {
                      const channels = collectionChannels.filter((channel) =>
                        data.getAll('channels').includes(channel),
                      );
                      const contactWindow = {
                        start: field(data, 'start'),
                        end: field(data, 'end'),
                        timeZone: field(data, 'zone'),
                      };
                      try {
                        new Intl.DateTimeFormat('en-CA', { timeZone: contactWindow.timeZone });
                      } catch {
                        throw new PlatformError('invalid_input');
                      }
                      if (!channels.length || contactWindow.start >= contactWindow.end)
                        throw new PlatformError('invalid_input');
                      const cadenceDays = { ...row.cadenceDays };
                      for (const bucket of agingBuckets)
                        cadenceDays[bucket] = Number(field(data, bucket));
                      return api.savePolicy('collections', {
                        cadenceDays,
                        channels,
                        contactWindow,
                      });
                    },
                    () => saved(collections.reload),
                  )
                }
              >
                {agingBuckets.map((bucket) => (
                  <TextField
                    key={bucket}
                    label={t('Cadence for {bucket} days', { bucket })}
                    name={bucket}
                    type="number"
                    min={1}
                    max={365}
                    defaultValue={row.cadenceDays[bucket]}
                  />
                ))}
                <fieldset className="bs-choice-list">
                  <legend>{t('Channel mix')}</legend>
                  {collectionChannels.map((channel) => (
                    <label key={channel}>
                      <input
                        type="checkbox"
                        name="channels"
                        value={channel}
                        defaultChecked={row.channels.includes(channel)}
                      />{' '}
                      {t(channel)}
                    </label>
                  ))}
                </fieldset>
                <TextField
                  label="Contact window start"
                  name="start"
                  type="time"
                  defaultValue={row.contactWindow.start}
                />
                <TextField
                  label="Contact window end"
                  name="end"
                  type="time"
                  defaultValue={row.contactWindow.end}
                />
                <TextField
                  label="Time zone"
                  name="zone"
                  defaultValue={row.contactWindow.timeZone}
                />
                <Submit busy={action.busy} label="Save policy" />
              </Form>
            ) : (
              <ul>
                {agingBuckets.map((bucket) => (
                  <li key={bucket}>
                    {t('Cadence for {bucket} days', { bucket })} · {number(row.cadenceDays[bucket])}
                  </li>
                ))}
                <li>
                  {t('Channel mix')} · {row.channels.map((channel) => t(channel)).join(', ')}
                </li>
                <li>
                  {t('Contact window')} · {row.contactWindow.start}–{row.contactWindow.end} ·{' '}
                  {row.contactWindow.timeZone}
                </li>
              </ul>
            ))
          }
        </RemoteContent>
      )}
    </Card>
  );
}
