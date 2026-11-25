import { useCallback, useState } from 'react';
import type { RunForecastInput, RunForecastOutput } from '@bs/contracts';
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
import { canReview } from '../platform-client.ts';
import type { PlatformRouteContext } from '../platform-app.tsx';
import type { FraudDecision, FraudReview, ProfileDecision } from '../clients/records.ts';
import { validId } from '../clients/workflow-definition.ts';
import {
  cad,
  Details,
  RecordLookup,
  ResourceTable,
  routeId,
  routeLink,
  useRequestKey,
} from './feature-helpers.tsx';

const percent = (score: number) => (score * 100).toFixed(0) + '%';

export function InsightsScreen(props: PlatformRouteContext) {
  return (
    <div className="bs-stack">
      <nav className="bs-feature-actions bs-subnav" aria-label="Insights sections">
        <a
          href="#/insights"
          aria-current={
            props.path === '/insights' || props.path.startsWith('/insights/fraud/')
              ? 'page'
              : undefined
          }
        >
          Fraud review
        </a>
        <a
          href="#/insights/forecast"
          aria-current={props.path.endsWith('/forecast') ? 'page' : undefined}
        >
          Forecast
        </a>
        <a
          href="#/insights/profile"
          aria-current={props.path.startsWith('/insights/profile') ? 'page' : undefined}
        >
          Customer profile
        </a>
      </nav>
      {props.path === '/insights' ? (
        <FraudQueue {...props} />
      ) : props.path.startsWith('/insights/fraud/') ? (
        <FraudScore {...props} />
      ) : props.path.endsWith('/forecast') ? (
        <Forecast {...props} />
      ) : (
        <Profile {...props} />
      )}
    </div>
  );
}

function FraudQueue({ client, me, notify }: PlatformRouteContext) {
  const list = useResource(useCallback(() => client.insights.listFraudQueue(), [client]));
  const [selected, setSelected] = useState<FraudReview>();
  const action = useAction(notify);
  const attempt = useRequestKey();
  function decide(row: FraudReview, decision: FraudDecision) {
    void action.run(
      () =>
        client.insights.reviewFraud(row.orderId, decision, attempt.key([row.orderId, decision])),
      () => {
        attempt.clear();
        list.reload();
        setSelected(undefined);
        notify('Fraud review recorded.');
      },
    );
  }
  return (
    <>
      <RecordLookup label="Order" path="/insights/fraud" />
      <ResourceTable
        label="Fraud review queue"
        resource={list}
        rowKey={(row) => row.orderId}
        columns={[
          {
            key: 'order',
            title: 'Order',
            render: (row) => <a href={routeLink('/erp/order', row.orderId)}>{row.orderId}</a>,
          },
          { key: 'rule', title: 'Rule score', render: (row) => percent(row.rule.score) },
          { key: 'model', title: 'Model score', render: (row) => percent(row.model.score) },
          {
            key: 'reasons',
            title: 'Rule reasons',
            render: (row) => row.rule.reasons.join(', ') || 'None',
          },
          {
            key: 'decision',
            title: 'Decision',
            render: (row) => <StatusPill status={row.decision ?? 'pending'} />,
          },
          ...(canReview(me.role)
            ? [
                {
                  key: 'review',
                  title: 'Review',
                  render: (row: FraudReview) =>
                    !row.decision && (
                      <Button variant="secondary" onClick={() => setSelected(row)}>
                        Review {row.orderId}
                      </Button>
                    ),
                },
              ]
            : []),
        ]}
      />
      {selected && (
        <Dialog
          title={'Review ' + selected.orderId}
          busy={action.busy}
          onClose={() => setSelected(undefined)}
        >
          <div className="bs-stack">
            <Details
              fields={[
                ['Rule score', percent(selected.rule.score) + ' · ' + selected.rule.version],
                ['Model score', percent(selected.model.score) + ' · ' + selected.model.artifactId],
                ['Rule reasons', selected.rule.reasons.join(', ') || 'None'],
              ]}
            />
            <div className="bs-feature-actions">
              <Button
                variant="secondary"
                disabled={action.busy}
                onClick={() => decide(selected, 'clear')}
              >
                Clear order
              </Button>
              <Button disabled={action.busy} onClick={() => decide(selected, 'escalate')}>
                Escalate order
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}

function FraudScore({ client, path }: PlatformRouteContext) {
  const id = routeId(path);
  const resource = useResource(useCallback(() => client.insights.scoreFraud(id), [client, id]));
  return (
    <Card title={'Scores for ' + id}>
      <RemoteContent resource={resource} label="fraud score">
        {(row) => (
          <Details
            fields={[
              ['Rule score', percent(row.rule.score) + ' · ' + row.rule.version],
              ['Model score', percent(row.model.score) + ' · ' + row.model.artifactId],
              ['Rule reasons', row.rule.reasons.join(', ') || 'None'],
              ['Suggested disposition', <StatusPill status={row.disposition} />],
            ]}
          />
        )}
      </RemoteContent>
    </Card>
  );
}

function Forecast({ client }: PlatformRouteContext) {
  const [series, setSeries] = useState<RunForecastInput['series']>('sku_demand');
  const [skuId, setSku] = useState('sku-001');
  const [horizon, setHorizon] = useState('4');
  const [query, setQuery] = useState<RunForecastInput>();
  const valid =
    Number.isInteger(Number(horizon)) &&
    Number(horizon) >= 1 &&
    Number(horizon) <= 12 &&
    (series === 'weekly_sales' || validId(skuId.trim()));
  return (
    <div className="bs-stack">
      <Card title="Forecast inputs">
        <form
          className="bs-feature-fields"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid)
              setQuery({
                series,
                skuId: series === 'sku_demand' ? skuId.trim() : null,
                horizonWeeks: Number(horizon),
              });
          }}
        >
          <Field label="Series">
            {(props) => (
              <Select
                {...props}
                value={series}
                onChange={(event) =>
                  setSeries(event.target.value === 'weekly_sales' ? 'weekly_sales' : 'sku_demand')
                }
              >
                <option value="sku_demand">SKU demand</option>
                <option value="weekly_sales">Weekly sales</option>
              </Select>
            )}
          </Field>
          {series === 'sku_demand' && (
            <Field label="SKU ID">
              {(props) => (
                <Input
                  {...props}
                  value={skuId}
                  required
                  onChange={(event) => setSku(event.target.value)}
                />
              )}
            </Field>
          )}
          <Field label="Weeks ahead">
            {(props) => (
              <Input
                {...props}
                type="number"
                min={1}
                max={12}
                required
                value={horizon}
                onChange={(event) => setHorizon(event.target.value)}
              />
            )}
          </Field>
          <Button type="submit" disabled={!valid}>
            Load forecast
          </Button>
        </form>
      </Card>
      {query ? (
        <ForecastResult client={client} query={query} />
      ) : (
        <EmptyState title="Choose a series to view its forecast." />
      )}
    </div>
  );
}

function ForecastResult({
  client,
  query,
}: Pick<PlatformRouteContext, 'client'> & { query: RunForecastInput }) {
  const resource = useResource(useCallback(() => client.insights.forecast(query), [client, query]));
  return (
    <Card title={query.skuId ? 'Demand for ' + query.skuId : 'Weekly sales'}>
      <RemoteContent resource={resource} label="forecast">
        {(forecast) =>
          forecast.status === 'insufficient_history' ? (
            <EmptyState title="Insufficient history to forecast." />
          ) : forecast.points.length ? (
            <ForecastChart forecast={forecast} />
          ) : (
            <EmptyState title="No forecast points." />
          )
        }
      </RemoteContent>
    </Card>
  );
}

function ForecastChart({ forecast }: { forecast: RunForecastOutput }) {
  const { points, unit } = forecast;
  const format = unit === 'cents' ? cad : (value: number) => value.toLocaleString('en-CA');
  const min = Math.min(...points.map((point) => point.lower));
  const max = Math.max(...points.map((point) => point.upper), min + 1);
  const xy = (value: number, index: number) => [
    points.length === 1 ? 320 : 110 + (index * 490) / (points.length - 1),
    168 - ((value - min) * 138) / (max - min),
  ];
  const plot = (key: 'lower' | 'upper' | 'estimate') =>
    points.map((point, index) => xy(point[key], index).join(','));
  return (
    <div className="bs-stack">
      <figure className="bs-forecast">
        <svg
          viewBox="0 0 640 214"
          role="img"
          aria-label="Forecast estimate with upper and lower bounds"
        >
          <line x1="106" y1="168" x2="610" y2="168" className="bs-axis" />
          <line x1="106" y1="30" x2="610" y2="30" className="bs-axis" />
          <text x="98" y="35" textAnchor="end">
            {format(max)}
          </text>
          <text x="98" y="172" textAnchor="end">
            {format(min)}
          </text>
          <polygon
            points={[...plot('upper'), ...plot('lower').reverse()].join(' ')}
            className="bs-range"
          />
          <polyline points={plot('estimate').join(' ')} className="bs-trend" />
          {points.map((point, index) => {
            const [cx, cy] = xy(point.estimate, index);
            return <circle key={point.weekOf} cx={cx} cy={cy} r="3" className="bs-point" />;
          })}
          {points.length === 1 && (
            <line
              x1="320"
              x2="320"
              y1={xy(points[0].upper, 0)[1]}
              y2={xy(points[0].lower, 0)[1]}
              className="bs-axis"
            />
          )}
          <text
            x={points.length > 1 ? 110 : 320}
            y="196"
            textAnchor={points.length > 1 ? 'start' : 'middle'}
          >
            {points[0].weekOf}
          </text>
          {points.length > 1 && (
            <text x="600" y="196" textAnchor="end">
              {points.at(-1)?.weekOf}
            </text>
          )}
        </svg>
        <figcaption>
          {unit === 'cents' ? 'CAD' : 'Items'} · Shaded area shows forecast bounds ·{' '}
          {forecast.artifactId}
        </figcaption>
      </figure>
      <Table
        label="Forecast values"
        rows={points}
        rowKey={(row) => row.weekOf}
        pageSize={12}
        columns={[
          { key: 'week', title: 'Week of', render: (row) => row.weekOf },
          { key: 'estimate', title: 'Estimate', render: (row) => format(row.estimate) },
          { key: 'lower', title: 'Lower', render: (row) => format(row.lower) },
          { key: 'upper', title: 'Upper', render: (row) => format(row.upper) },
        ]}
      />
    </div>
  );
}

function Profile(props: PlatformRouteContext) {
  const id = props.path.startsWith('/insights/profile/') ? routeId(props.path) : '';
  const [input, setInput] = useState(id || 'cust-008');
  return (
    <div className="bs-stack">
      <Card title="Find a customer profile">
        <form
          className="bs-feature-fields"
          onSubmit={(event) => {
            event.preventDefault();
            if (validId(input.trim()))
              window.location.hash = routeLink('/insights/profile', input.trim());
          }}
        >
          <Field label="Customer ID">
            {(attributes) => (
              <Input
                {...attributes}
                required
                value={input}
                onChange={(event) => setInput(event.target.value)}
              />
            )}
          </Field>
          <Button type="submit" disabled={!validId(input.trim())}>
            View profile
          </Button>
        </form>
      </Card>
      {id ? (
        <ProfileResult {...props} id={id} />
      ) : (
        <EmptyState title="Choose a customer to view their profile." />
      )}
    </div>
  );
}

function ProfileResult({ client, me, notify, id }: PlatformRouteContext & { id: string }) {
  const profile = useResource(useCallback(() => client.insights.profile(id), [client, id]));
  const action = useAction(notify);
  const attempt = useRequestKey();
  function decide(decision: ProfileDecision) {
    void action.run(
      () => client.insights.reviewProfile(id, decision, attempt.key([id, decision])),
      () => {
        attempt.clear();
        profile.reload();
        notify('Profile review recorded.');
      },
    );
  }
  return (
    <Card title={'Profile for ' + id}>
      <RemoteContent resource={profile} label="profile">
        {(row) => (
          <div className="bs-stack">
            <Details
              fields={[
                ['Segment', <StatusPill status={row.segment} />],
                ['Review status', <StatusPill status={row.reviewStatus} />],
                ['Artifact', row.artifactId],
              ]}
            />
            <h3>Evidence citations</h3>
            {row.evidenceIds.length ? (
              <ul className="bs-feature-list">
                {row.evidenceIds.map((evidence) => (
                  <li key={evidence}>
                    {evidence.startsWith('ord-') ? (
                      <a href={routeLink('/erp/order', evidence)}>{evidence}</a>
                    ) : evidence.startsWith('cust-') ? (
                      <a href={routeLink('/crm/customer', evidence)}>{evidence}</a>
                    ) : (
                      evidence
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No evidence citations." />
            )}
            {canReview(me.role) && row.reviewStatus === 'pending' && (
              <div className="bs-feature-actions">
                <Button variant="secondary" disabled={action.busy} onClick={() => decide('reject')}>
                  Reject profile
                </Button>
                <Button disabled={action.busy} onClick={() => decide('accept')}>
                  Accept profile
                </Button>
              </div>
            )}
          </div>
        )}
      </RemoteContent>
    </Card>
  );
}
