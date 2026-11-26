import { useCallback, useState } from 'react';
import { Button, Card, Dialog } from '../components.tsx';
import {
  contactChannels,
  contactPurposes,
  privacyKinds,
  suppressionReasons,
} from '../clients/compliance.ts';
import type {
  ContactCheck,
  ContactDecision,
  PrivacyCompletion,
  PrivacyRequest,
  RetentionReport,
} from '../clients/compliance.ts';
import { useAction, useResource } from '../data.tsx';
import { useI18n } from '../i18n.tsx';
import type { PlatformRouteContext } from '../platform-app.tsx';
import { List, Form, Status, Submit, TextField, Values, field } from './round-four.tsx';

export function ConsentsScreen({ client, notify }: PlatformRouteContext) {
  const api = client.compliance;
  const { t, date } = useI18n();
  const [filter, setFilter] = useState('');
  const [channel, setChannel] = useState<'all_channels' | ContactCheck['channel']>('all_channels');
  const [withdraw, setWithdraw] = useState<string>();
  const load = useResource(
    useCallback(
      async () =>
        (await api.listConsents()).filter(
          (row) =>
            (!filter.trim() || row.contactId.includes(filter.trim())) &&
            (channel === 'all_channels' || row.channel === channel),
        ),
      [api, filter, channel],
    ),
  );
  const action = useAction(notify);
  return (
    <div className="bs-stack">
      <div className="bs-feature-fields">
        <TextField
          label="Filter by contact ID"
          name="contact"
          required={false}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <Values
          label="Channel"
          options={['all_channels', ...contactChannels]}
          value={channel}
          onChange={setChannel}
        />
      </div>
      <List
        title="Consent ledger"
        load={load}
        columns={[
          { key: 'contact', title: 'Contact ID', render: (row) => row.contactId },
          { key: 'channel', title: 'Channel', render: (row) => t(row.channel) },
          { key: 'purpose', title: 'Purpose', render: (row) => t(row.purpose) },
          { key: 'basis', title: 'Basis', render: (row) => t(row.basis) },
          { key: 'expiry', title: 'Expiry', render: (row) => date(row.expiresAt) },
          {
            key: 'evidence',
            title: 'Evidence',
            render: (row) => (
              <>
                {row.evidenceRef}
                <small className="bs-subline">{row.source}</small>
              </>
            ),
          },
          {
            key: 'withdraw',
            title: 'Action',
            render: (row) =>
              row.withdrawnAt ? (
                <>
                  {t('Withdrawn')} · {date(row.withdrawnAt)}
                </>
              ) : (
                <Button variant="secondary" onClick={() => setWithdraw(row.id)}>
                  {t('Withdraw consent')}
                </Button>
              ),
          },
        ]}
      />
      {withdraw && (
        <Dialog
          title={t('Withdraw consent')}
          busy={action.busy}
          onClose={() => setWithdraw(undefined)}
        >
          <p>{t('Confirm withdrawal for {id}.', { id: withdraw })}</p>
          <Button
            disabled={action.busy}
            onClick={() =>
              void action.run(
                () => api.withdrawConsent(withdraw),
                () => {
                  setWithdraw(undefined);
                  load.reload();
                  notify(t('Consent withdrawn.'));
                },
              )
            }
          >
            {t('Confirm withdrawal')}
          </Button>
        </Dialog>
      )}
    </div>
  );
}

export function SuppressionsScreen({ client, notify }: PlatformRouteContext) {
  const api = client.compliance;
  const { t, date } = useI18n();
  const [channel, setChannel] = useState<ContactCheck['channel']>('email');
  const [reason, setReason] = useState<(typeof suppressionReasons)[number]>('do_not_contact');
  const [remove, setRemove] = useState<string>();
  const load = useResource(useCallback(() => api.listSuppressions(), [api]));
  const action = useAction(notify);
  return (
    <div className="bs-stack">
      <Card title={t('Add suppression')}>
        <Form
          onSubmit={(data) =>
            void action.run(
              () =>
                api.addSuppression({ channel, destination: field(data, 'destination'), reason }),
              () => {
                load.reload();
                notify(t('Suppression added.'));
              },
            )
          }
        >
          <Values label="Channel" options={contactChannels} value={channel} onChange={setChannel} />
          <TextField
            label="Destination"
            name="destination"
            type={channel === 'email' ? 'email' : 'tel'}
          />
          <Values label="Reason" options={suppressionReasons} value={reason} onChange={setReason} />
          <Submit label="Add suppression" busy={action.busy} />
        </Form>
      </Card>
      <List
        title="Tenant suppressions"
        load={load}
        columns={[
          { key: 'destination', title: 'Destination', render: (row) => row.destination },
          { key: 'channel', title: 'Channel', render: (row) => t(row.channel) },
          { key: 'reason', title: 'Reason', render: (row) => t(row.reason) },
          { key: 'added', title: 'Added', render: (row) => date(row.createdAt) },
          {
            key: 'remove',
            title: 'Action',
            render: (row) => (
              <Button variant="secondary" onClick={() => setRemove(row.id)}>
                {t('Remove suppression')}
              </Button>
            ),
          },
        ]}
      />
      {remove && (
        <Dialog
          title={t('Remove suppression')}
          busy={action.busy}
          onClose={() => setRemove(undefined)}
        >
          <p>{t('Remove suppression {id}?', { id: remove })}</p>
          <Button
            disabled={action.busy}
            onClick={() =>
              void action.run(
                () => api.removeSuppression(remove),
                () => {
                  setRemove(undefined);
                  load.reload();
                  notify(t('Suppression removed.'));
                },
              )
            }
          >
            {t('Confirm removal')}
          </Button>
        </Dialog>
      )}
    </div>
  );
}

export function ContactCheckScreen({ client, notify }: PlatformRouteContext) {
  const { t } = useI18n();
  const [channel, setChannel] = useState<ContactCheck['channel']>('email');
  const [purpose, setPurpose] = useState<ContactCheck['purpose']>('marketing');
  const [result, setResult] = useState<{ input: ContactCheck; decision: ContactDecision }>();
  const action = useAction(notify);
  return (
    <Card title={t('Evaluate outreach')}>
      <Form
        onSubmit={(data) => {
          const input = { contactId: field(data, 'contact'), channel, purpose };
          setResult(undefined);
          void action.run(
            () => client.compliance.checkContact(input),
            (decision) => setResult({ input, decision }),
          );
        }}
      >
        <TextField label="Contact ID" name="contact" />
        <Values label="Channel" options={contactChannels} value={channel} onChange={setChannel} />
        <Values label="Purpose" options={contactPurposes} value={purpose} onChange={setPurpose} />
        <Submit label="Check contact" busy={action.busy} />
      </Form>
      {result && (
        <div role="status">
          <p>
            {result.input.contactId} · {t(result.input.channel)} · {t(result.input.purpose)}
          </p>
          <Status
            value={result.decision.allow ? 'Allowed' : 'Denied'}
            danger={!result.decision.allow}
          />
          {result.decision.consentId && (
            <p>
              {t('Matching consent')} · {result.decision.consentId}
            </p>
          )}
          {!!result.decision.reasons.length && (
            <ul>
              {result.decision.reasons.map((reason) => (
                <li key={reason}>{t(reason)}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

export function PrivacyScreen({ client, notify }: PlatformRouteContext) {
  const api = client.compliance;
  const { t, date, number } = useI18n();
  const [kind, setKind] = useState<PrivacyRequest['kind']>('access');
  const [active, setActive] = useState<PrivacyRequest>();
  const [bundle, setBundle] = useState<PrivacyCompletion['bundle']>();
  const load = useResource(useCallback(() => api.listPrivacyRequests(), [api]));
  const action = useAction(notify);
  function updated(row: PrivacyRequest) {
    setActive(row);
    load.reload();
  }
  return (
    <div className="bs-stack">
      <Card title={t('New privacy request')}>
        <Form
          onSubmit={(data) =>
            void action.run(
              () => api.createPrivacyRequest({ subjectId: field(data, 'subject'), kind }),
              (row) => {
                updated(row);
                notify(t('Privacy request created.'));
              },
            )
          }
        >
          <TextField label="Subject ID" name="subject" />
          <Values label="Request type" options={privacyKinds} value={kind} onChange={setKind} />
          <Submit busy={action.busy} label="Create request" />
        </Form>
      </Card>
      <List
        title="Privacy request ledger"
        load={load}
        columns={[
          { key: 'id', title: 'Request ID', render: (row) => row.id },
          { key: 'subject', title: 'Subject ID', render: (row) => row.subjectId },
          { key: 'kind', title: 'Request type', render: (row) => t(row.kind) },
          { key: 'due', title: 'Due date', render: (row) => date(row.dueAt) },
          {
            key: 'status',
            title: 'Status',
            render: (row) => (
              <Status value={row.status} danger={row.status === 'retention_blocked'} />
            ),
          },
          {
            key: 'action',
            title: 'Action',
            render: (row) => (
              <Button variant="secondary" onClick={() => setActive(row)}>
                {t('View request')}
              </Button>
            ),
          },
        ]}
      />
      {active && (
        <Dialog
          title={t('Privacy request {id}', { id: active.id })}
          busy={action.busy}
          onClose={() => {
            setActive(undefined);
            setBundle(undefined);
          }}
        >
          <div className="bs-stack">
            <p>
              {t('Due date')} · {date(active.dueAt)} · {t(active.status)}
            </p>
            <ul aria-label={t('Status history')}>
              {active.history.map((entry, i) => (
                <li key={i}>
                  {date(entry.at, true)} · {t(entry.status)} · {entry.actorId}
                </li>
              ))}
            </ul>
            {!!active.deletion?.blocked.length && (
              <ul aria-label={t('Retention blocks')}>
                {active.deletion.blocked.map((row) => (
                  <li key={row.recordType + '/' + row.id}>
                    {row.id} · {row.reasons.map((reason) => t(reason)).join(', ')}
                  </li>
                ))}
              </ul>
            )}
            {active.status === 'pending_verification' ? (
              <Form
                onSubmit={(data) =>
                  void action.run(
                    () => api.verifyPrivacyRequest(active.id, field(data, 'proof')),
                    (row) => {
                      updated(row);
                      notify(t('Identity verified.'));
                    },
                  )
                }
              >
                <TextField
                  label="Proof reference"
                  name="proof"
                  type="password"
                  autoComplete="off"
                />
                <Submit busy={action.busy} label="Verify identity" />
              </Form>
            ) : (
              (active.status !== 'completed' || active.kind !== 'deletion') && (
                <Button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(
                      () => api.completePrivacyRequest(active.id),
                      (value) => {
                        updated(value.request);
                        setBundle(value.bundle);
                        if (value.request.status === 'completed')
                          notify(t('Privacy request completed.'));
                      },
                    )
                  }
                >
                  {t(active.status === 'completed' ? 'Retrieve bundle' : 'Complete request')}
                </Button>
              )
            )}
            {active.deletion && (
              <p>
                {t('Records deleted')}: {number(active.deletion.deleted)}
              </p>
            )}
            {bundle && (
              <details>
                <summary>
                  {t('Access or export bundle')} · {number(bundle.records.length)}
                </summary>
                <pre className="bs-code">{JSON.stringify(bundle, null, 2)}</pre>
              </details>
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
}

export function RetentionScreen({ client, notify }: PlatformRouteContext) {
  const api = client.compliance;
  const { t, date, number } = useI18n();
  const load = useResource(
    useCallback(
      () =>
        api.retentionPolicies().then((rows) => rows.map((row) => ({ id: row.dataClass, ...row }))),
      [api],
    ),
  );
  const [report, setReport] = useState<RetentionReport>();
  const action = useAction(notify);
  return (
    <div className="bs-stack">
      <List
        title="Retention policies"
        load={load}
        columns={[
          { key: 'class', title: 'Data class', render: (row) => t(row.dataClass) },
          { key: 'purge', title: 'Purge age (days)', render: (row) => number(row.purgeAfterDays) },
          {
            key: 'min',
            title: 'Minimum retention (days)',
            render: (row) => number(row.minimumRetentionDays),
          },
        ]}
      />
      <Card title={t('Purge dry run')}>
        <Form
          onSubmit={(data) => {
            const value = field(data, 'asOf');
            setReport(undefined);
            void action.run(
              () =>
                api.purgeDryRun(value ? new Date(value + 'T12:00:00Z').toISOString() : undefined),
              setReport,
            );
          }}
        >
          <TextField label="As of (optional)" name="asOf" type="date" required={false} />
          <Submit label="Run purge preview" busy={action.busy} />
        </Form>
        {report && (
          <div role="status">
            <p>
              {t('Purge report')} · {date(report.asOf, true)}
            </p>
            {report.items.length ? (
              <ul>
                {report.items.map((row) => (
                  <li key={row.recordType + '/' + row.id}>
                    {row.id} · {t(row.status)} · {date(row.purgeAt)}
                    {row.holdIds.length > 0 && (
                      <>
                        {' '}
                        · {t('Retention holds')} · {row.holdIds.join(', ')}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p>{t('No entries.')}</p>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
