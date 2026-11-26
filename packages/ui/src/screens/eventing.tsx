import { useCallback, useState } from 'react';
import { Button, Card, Dialog } from '../components.tsx';
import { webhookEvents } from '../clients/eventing.ts';
import type { WebhookDelivery } from '../clients/eventing.ts';
import { RemoteContent, useAction, useResource } from '../data.tsx';
import type { Notice } from '../data.tsx';
import { useI18n } from '../i18n.tsx';
import type { PlatformRouteContext } from '../platform-app.tsx';
import type { PlatformClient } from '../platform-client.ts';
import { Form, List, Status, Submit, TextField, field } from './round-four.tsx';

export function WebhooksScreen({ client, notify }: PlatformRouteContext) {
  const api = client.eventing;
  const { t, date } = useI18n();
  const [selected, setSelected] = useState('');
  const [secret, setSecret] = useState<string>();
  const load = useResource(useCallback(() => api.listWebhooks(), [api]));
  const action = useAction(notify);
  return (
    <div className="bs-stack">
      <Card title={t('Create webhook endpoint')}>
        <Form
          onSubmit={(data) => {
            const events = webhookEvents.filter((event) => data.getAll('events').includes(event));
            if (!events.length) {
              notify(t('Select at least one event.'), 'danger');
              return;
            }
            void action.run(
              () => api.createWebhook({ url: field(data, 'url'), events }),
              (hook) => {
                setSecret(hook.signingSecret);
                setSelected(hook.id);
                load.reload();
              },
            );
          }}
        >
          <TextField
            label="Endpoint URL"
            name="url"
            type="url"
            placeholder="https://receipts.rivetquay.example/events"
          />
          <fieldset className="bs-choice-list">
            <legend>{t('Event filters')}</legend>
            {webhookEvents.map((event) => (
              <label key={event}>
                <input type="checkbox" name="events" value={event} /> {t(event)}
              </label>
            ))}
          </fieldset>
          <Submit label="Create endpoint" busy={action.busy} />
        </Form>
      </Card>
      <List
        title="Webhook endpoints"
        load={load}
        columns={[
          { key: 'url', title: 'Endpoint URL', render: (row) => <code>{row.url}</code> },
          {
            key: 'events',
            title: 'Event filters',
            render: (row) => row.events.map((event) => t(event)).join(', '),
          },
          { key: 'created', title: 'Added', render: (row) => date(row.createdAt) },
          {
            key: 'actions',
            title: 'Action',
            render: (row) => (
              <Button
                variant="secondary"
                aria-pressed={selected === row.id}
                onClick={() => setSelected(row.id)}
              >
                {t('View deliveries')}
              </Button>
            ),
          },
        ]}
      />
      {selected && <Deliveries key={selected} id={selected} client={client} notify={notify} />}
      {secret && (
        <Dialog title={t('Webhook signing secret')} onClose={() => setSecret(undefined)}>
          <p>{t('Save this signing secret now. It is shown once.')}</p>
          <pre className="bs-code">{secret}</pre>
          <Button onClick={() => setSecret(undefined)}>{t('Done')}</Button>
        </Dialog>
      )}
    </div>
  );
}

function Deliveries({
  id,
  client,
  notify,
}: {
  id: string;
  client: PlatformClient;
  notify: Notice;
}) {
  const api = client.eventing;
  const { t, date, number } = useI18n();
  const [attempt, setAttempt] = useState<WebhookDelivery>();
  const load = useResource(useCallback(() => api.listDeliveries(id), [api, id]));
  const action = useAction(notify);
  return (
    <div className="bs-stack">
      <div className="bs-inline">
        <code>{id}</code>
        <Button
          disabled={action.busy}
          onClick={() =>
            void action.run(
              () => api.testWebhook(id),
              () => {
                load.reload();
                notify(t('Webhook test queued.'));
              },
            )
          }
        >
          {t('Test endpoint')}
        </Button>
        <Button variant="secondary" onClick={load.reload}>
          {t('Refresh deliveries')}
        </Button>
      </div>
      <List
        title="Webhook deliveries"
        load={load}
        columns={[
          {
            key: 'id',
            title: 'Delivery ID',
            render: (row) => (
              <>
                {row.id}
                <small className="bs-subline">{row.eventId}</small>
              </>
            ),
          },
          {
            key: 'status',
            title: 'Status',
            render: (row) => <Status value={row.status} danger={row.status === 'dead'} />,
          },
          { key: 'retry', title: 'Next attempt', render: (row) => date(row.nextAttemptAt, true) },
          {
            key: 'replay',
            title: 'Replay link',
            render: (row) => row.replayOf ?? row.replayId ?? '—',
          },
          {
            key: 'actions',
            title: 'Action',
            render: (row) => (
              <div className="bs-inline">
                <Button variant="secondary" onClick={() => setAttempt(row)}>
                  {t('Attempt history')}
                </Button>
                {row.status === 'dead' && !row.replayId && (
                  <Button
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(
                        () => api.replayDelivery(row.id),
                        () => {
                          load.reload();
                          notify(t('Webhook replay queued.'));
                        },
                      )
                    }
                  >
                    {t('Replay dead letter')}
                  </Button>
                )}
              </div>
            ),
          },
        ]}
      />
      {attempt && (
        <Dialog title={t('Attempt history')} onClose={() => setAttempt(undefined)}>
          {attempt.attempts.length ? (
            <ul>
              {attempt.attempts.map((entry) => (
                <li key={entry.number}>
                  {number(entry.number)} · {date(entry.at, true)} · {t(entry.outcome)}
                  {entry.statusCode && <> · HTTP {entry.statusCode}</>}
                </li>
              ))}
            </ul>
          ) : (
            <p>{t('No entries.')}</p>
          )}
        </Dialog>
      )}
    </div>
  );
}

export function NotificationCenter({ client, notify }: { client: PlatformClient; notify: Notice }) {
  const { t, date, number } = useI18n();
  const api = client.eventing;
  const [open, setOpen] = useState(false);
  const load = useResource(useCallback(() => api.listNotifications(), [api]));
  const action = useAction(notify);
  const count =
    load.state.status === 'ready' ? load.state.data.filter((row) => !row.readAt).length : 0;
  return (
    <>
      <Button
        variant="quiet"
        aria-haspopup="dialog"
        onClick={() => {
          load.reload();
          setOpen(true);
        }}
      >
        {t('Notifications')}
        {count > 0 && ' (' + number(count) + ')'}
      </Button>
      {open && (
        <Dialog title={t('Notifications')} busy={action.busy} onClose={() => setOpen(false)}>
          <RemoteContent resource={load} label={t('Notifications')}>
            {(rows) =>
              rows.length ? (
                <ul className="bs-notification-list">
                  {[...rows]
                    .sort((a, b) => b.event.occurredAt.localeCompare(a.event.occurredAt))
                    .map((row) => (
                      <li key={row.id}>
                        <strong>{t(row.event.type)}</strong>
                        <small className="bs-subline">{date(row.event.occurredAt, true)}</small>
                        <small className="bs-subline">
                          {Object.entries(row.event.data)
                            .filter(([key]) => key.endsWith('Id'))
                            .map(([, value]) => value)
                            .join(' · ')}
                        </small>
                        {row.readAt ? (
                          <span>{t('Read')}</span>
                        ) : (
                          <Button
                            variant="secondary"
                            disabled={action.busy}
                            onClick={() => void action.run(() => api.markRead(row.id), load.reload)}
                          >
                            {t('Mark read')}
                          </Button>
                        )}
                      </li>
                    ))}
                </ul>
              ) : (
                <p>{t('No notifications.')}</p>
              )
            }
          </RemoteContent>
        </Dialog>
      )}
    </>
  );
}
