import { useCallback } from 'react';
import { Button, Card } from '../components.tsx';
import type { ServiceCheck } from '../clients/ops.ts';
import { RemoteContent, useResource } from '../data.tsx';
import { useI18n } from '../i18n.tsx';
import type { PlatformRouteContext } from '../platform-app.tsx';
import { List, Status } from './round-four.tsx';

export function OpsScreen({ client }: PlatformRouteContext) {
  const api = client.ops;
  const { t, number, date } = useI18n();
  const health = useResource(useCallback(() => api.health(), [api]));
  const ready = useResource(useCallback(() => api.readiness(), [api]));
  const metrics = useResource(useCallback(() => api.metrics(), [api]));
  const alerts = useResource(useCallback(() => api.alerts(), [api]));
  return (
    <div className="bs-stack">
      <div>
        <Button
          variant="secondary"
          onClick={() => {
            health.reload();
            ready.reload();
            metrics.reload();
            alerts.reload();
          }}
        >
          {t('Refresh operations')}
        </Button>
      </div>
      <div className="bs-grid">
        <Card title={t('Service health')}>
          <RemoteContent resource={health} label={t('Service health')}>
            {(data) => (
              <>
                <Status value={data.status} danger={data.status !== 'ok'} />
                <Checks checks={data.checks} />
              </>
            )}
          </RemoteContent>
        </Card>
        <Card title={t('Service readiness')}>
          <RemoteContent resource={ready} label={t('Service readiness')}>
            {(data) => (
              <>
                <Status value={data.ready ? 'Ready' : 'Not ready'} danger={!data.ready} />
                <Checks checks={data.checks} />
              </>
            )}
          </RemoteContent>
        </Card>
      </div>
      <Card title={t('SLO burn rates')}>
        <RemoteContent resource={metrics} label={t('SLO burn rates')}>
          {({ slos }) =>
            slos.length ? (
              <ul>
                {slos.map((slo) => (
                  <li key={slo.name + slo.window}>
                    {t(slo.name)} · {t(slo.window)} ·{' '}
                    {number(slo.burnRate, { maximumFractionDigits: 2 })}× · {t('Target')}{' '}
                    {number(slo.target, { style: 'percent', maximumFractionDigits: 2 })}
                  </li>
                ))}
              </ul>
            ) : (
              <p>{t('No entries.')}</p>
            )
          }
        </RemoteContent>
      </Card>
      <List
        title="Active alerts"
        load={alerts}
        columns={[
          { key: 'service', title: 'Service', render: (row) => row.service },
          {
            key: 'severity',
            title: 'Severity',
            render: (row) => <Status value={row.severity} danger={row.severity === 'critical'} />,
          },
          { key: 'summary', title: 'Summary', render: (row) => t(row.summary) },
          { key: 'start', title: 'Started', render: (row) => date(row.startedAt, true) },
        ]}
      />
    </div>
  );
}

function Checks({ checks }: { checks: ServiceCheck[] }) {
  const { t } = useI18n();
  return checks.length ? (
    <ul>
      {checks.map((check) => (
        <li key={check.service}>
          {check.service} · <Status value={check.status} danger={check.status !== 'ok'} />{' '}
          {check.detail && t(check.detail)}
        </li>
      ))}
    </ul>
  ) : (
    <p>{t('No entries.')}</p>
  );
}
