import type { AuditEntry, ModuleId } from '@bs/contracts';
import { formatDate, type ScreenProps } from './screen-helpers.tsx';
import { useCallback, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Select,
  StatusPill,
  Switch,
  Table,
} from '../components.tsx';
import type { TableColumn } from '../components.tsx';
import { RemoteContent, useAction, useResource } from '../data.tsx';
import type { AuditQuery, UsageQuery } from '../platform-client.ts';

const timestamp = new Intl.DateTimeFormat('en-CA', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'America/Toronto',
});

export function formatTime(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? timestamp.format(time) : value;
}

const count = new Intl.NumberFormat('en-CA');

function Allowance({ name, used, allowance }: { name: string; used: number; allowance: number }) {
  return (
    <div className="bs-allowance">
      <span>
        {count.format(used)} / {count.format(allowance)}
      </span>
      <meter
        aria-label={name + ' allowance'}
        min={0}
        max={Math.max(allowance, 1)}
        value={Math.min(used, Math.max(allowance, 1))}
        optimum={0}
        high={Math.max(allowance, 1) * 0.8}
      />
    </div>
  );
}

const auditColumns: TableColumn<AuditEntry>[] = [
  { key: 'when', title: 'Time (Toronto)', render: (row) => formatTime(row.occurredAt) },
  { key: 'tool', title: 'Tool', render: (row) => row.tool },
  { key: 'actor', title: 'Actor', render: (row) => row.actor.id },
  { key: 'source', title: 'Source', render: (row) => row.source },
  { key: 'state', title: 'State', render: (row) => <StatusPill status={row.state} /> },
];

export function OverviewScreen({ client }: ScreenProps) {
  const resource = useResource(
    useCallback(async () => {
      const [modules, pending, audit] = await Promise.all([
        client.getModules(),
        client.getApprovals('pending'),
        client.getAudit({ limit: 5 }),
      ]);
      return { modules, pending, audit };
    }, [client]),
  );
  return (
    <RemoteContent label="workspace overview" resource={resource}>
      {({ modules, pending, audit }) => (
        <>
          <div className="bs-overview-grid">
            <Card title="Modules enabled">
              <div className="bs-kpi">
                {modules.filter((item) => item.enabled).length} <small>/ {modules.length}</small>
              </div>
              <a href="#/modules">Manage modules</a>
            </Card>
            <Card title="Pending approvals">
              <div className="bs-kpi">{pending.length}</div>
              <a href="#/approvals">Open approvals inbox</a>
            </Card>
            <Card title="Tracked usage">
              <div className="bs-kpi">
                {modules.filter((item) => item.used > 0).length} <small>modules</small>
              </div>
              <a href="#/usage">View usage ledger</a>
            </Card>
          </div>
          <div className="bs-stack">
            <Card title="Module allowances">
              <Table
                label="Module allowances"
                rows={modules}
                rowKey={(row) => row.moduleId}
                columns={[
                  { key: 'module', title: 'Module', render: (row) => row.name },
                  {
                    key: 'status',
                    title: 'Status',
                    render: (row) => <StatusPill status={row.enabled ? 'enabled' : 'disabled'} />,
                  },
                  {
                    key: 'allowance',
                    title: 'Used / allowance',
                    render: (row) => (
                      <Allowance name={row.name} used={row.used} allowance={row.allowance} />
                    ),
                  },
                ]}
                empty="No modules are assigned to this workspace."
              />
            </Card>
            <Card title="Recent audit activity" action={<a href="#/audit">View audit log</a>}>
              <Table
                label="Recent audit activity"
                rows={audit.items}
                rowKey={(row) => row.id}
                columns={auditColumns}
                empty="No audit activity yet."
              />
            </Card>
          </div>
        </>
      )}
    </RemoteContent>
  );
}

export function ModulesScreen({ client, me, notify }: ScreenProps) {
  const resource = useResource(useCallback(() => client.getModules(), [client]));
  const { busy, run } = useAction(notify);
  return (
    <Card title="Module access and allowances">
      <RemoteContent resource={resource} label="modules">
        {(modules) => (
          <Table
            label="Modules and billing"
            rows={modules}
            rowKey={(row) => row.moduleId}
            empty="No modules are assigned to this workspace."
            columns={[
              {
                key: 'module',
                title: 'Module',
                sortValue: (row) => row.name,
                render: (row) => (
                  <>
                    <strong>{row.name}</strong>
                    <small className="bs-subline">{row.description}</small>
                  </>
                ),
              },
              {
                key: 'window',
                title: 'Allowance window (UTC)',
                render: (row) => (
                  <>
                    {formatDate(row.windowStart)} → {formatDate(row.windowEnd)}
                  </>
                ),
              },
              {
                key: 'allowance',
                title: 'Used / allowance',
                render: (row) => (
                  <Allowance name={row.name} used={row.used} allowance={row.allowance} />
                ),
              },
              {
                key: 'access',
                title: 'Access',
                render: (row) =>
                  me.role === 'admin' ? (
                    <Switch
                      label={'Enable ' + row.name}
                      checked={row.enabled}
                      disabled={busy}
                      onChange={(enabled) => {
                        void run(
                          () => client.updateModule(row.moduleId, enabled),
                          () => {
                            notify(row.name + (enabled ? ' enabled.' : ' disabled.'));
                            resource.reload();
                          },
                        );
                      }}
                    />
                  ) : (
                    <StatusPill status={row.enabled ? 'enabled' : 'disabled'} />
                  ),
              },
            ]}
          />
        )}
      </RemoteContent>
    </Card>
  );
}

const auditStates = ['ok', 'pending_approval', 'denied', 'failed', 'unknown'] as const;

export function AuditScreen({ client }: ScreenProps) {
  const [filters, setFilters] = useState<AuditQuery>({});
  const [query, setQuery] = useState<AuditQuery>({});
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const resource = useResource(
    useCallback(() => client.getAudit({ ...query, cursor, limit: 10 }), [client, cursor, query]),
  );

  function apply(next: AuditQuery) {
    setCursors([]);
    setQuery(next);
  }

  return (
    <Card title="Audit events">
      <form
        className="bs-filters"
        onSubmit={(event) => {
          event.preventDefault();
          apply({
            ...filters,
            tool: filters.tool?.trim(),
            actorId: filters.actorId?.trim(),
            from: filters.from && filters.from + 'T00:00:00.000Z',
            to: filters.to && filters.to + 'T23:59:59.999Z',
          });
        }}
      >
        <Field label="Tool">
          {(props) => (
            <Input
              {...props}
              value={filters.tool ?? ''}
              onChange={(event) => setFilters({ ...filters, tool: event.target.value })}
            />
          )}
        </Field>
        <Field label="Actor ID">
          {(props) => (
            <Input
              {...props}
              value={filters.actorId ?? ''}
              onChange={(event) => setFilters({ ...filters, actorId: event.target.value })}
            />
          )}
        </Field>
        <Field label="State">
          {(props) => (
            <Select
              {...props}
              value={filters.state ?? ''}
              onChange={(event) =>
                setFilters({
                  ...filters,
                  state: (event.target.value || undefined) as AuditQuery['state'],
                })
              }
            >
              <option value="">All states</option>
              {auditStates.map((state) => (
                <option key={state} value={state}>
                  {state.replaceAll('_', ' ')}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="From (UTC)">
          {(props) => (
            <Input
              {...props}
              type="date"
              max={filters.to}
              value={filters.from ?? ''}
              onChange={(event) => setFilters({ ...filters, from: event.target.value })}
            />
          )}
        </Field>
        <Field label="To (UTC)">
          {(props) => (
            <Input
              {...props}
              type="date"
              min={filters.from}
              value={filters.to ?? ''}
              onChange={(event) => setFilters({ ...filters, to: event.target.value })}
            />
          )}
        </Field>
        <div className="bs-actions">
          <Button type="submit">Apply filters</Button>
          <Button
            variant="quiet"
            onClick={() => {
              setFilters({});
              apply({});
            }}
          >
            Clear
          </Button>
        </div>
      </form>
      <RemoteContent label="audit log" resource={resource}>
        {({ items, nextCursor }) => (
          <>
            <Table
              label="Audit events"
              rows={items}
              rowKey={(row) => row.id}
              columns={auditColumns}
              empty="No audit events match these filters."
            />
            {(cursors.length > 0 || nextCursor) && (
              <div className="bs-pagination">
                <span role="status">Page {cursors.length + 1}</span>
                <Button
                  variant="secondary"
                  disabled={!cursors.length}
                  onClick={() => setCursors(cursors.slice(0, -1))}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={!nextCursor}
                  onClick={() => {
                    if (nextCursor) setCursors([...cursors, nextCursor]);
                  }}
                >
                  Next
                </Button>
              </div>
            )}
          </>
        )}
      </RemoteContent>
    </Card>
  );
}

export function UsageScreen({ client }: ScreenProps) {
  const [query, setQuery] = useState<UsageQuery>({});
  const resource = useResource(useCallback(() => client.getUsage(query), [client, query]));
  const modules = useResource(useCallback(() => client.getModules(), [client]));
  return (
    <div className="bs-stack">
      <Card title="Per-module totals">
        <RemoteContent label="module filters" resource={modules}>
          {(items) => (
            <div className="bs-filters">
              <Field label="Module">
                {(props) => (
                  <Select
                    {...props}
                    value={query.module ?? ''}
                    onChange={(event) =>
                      setQuery({
                        module: (event.target.value || undefined) as ModuleId | undefined,
                      })
                    }
                  >
                    <option value="">All modules</option>
                    {items.map((module) => (
                      <option key={module.moduleId} value={module.moduleId}>
                        {module.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
          )}
        </RemoteContent>
        <RemoteContent label="usage" resource={resource}>
          {({ totals }) =>
            totals.length ? (
              <div className="bs-usage-grid">
                {totals.map((row) => (
                  <div className="bs-usage-tile" key={row.module}>
                    <Badge tone="accent">{row.module}</Badge>
                    <Allowance name={row.module} used={row.used} allowance={row.allowance} />
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState title="No totals are available." />
            )
          }
        </RemoteContent>
      </Card>
      {resource.state.status === 'ready' && (
        <Card title="Usage events">
          <Table
            label="Usage events"
            rows={resource.state.data.items}
            rowKey={(row) => row.id}
            empty="No usage events for this selection."
            columns={[
              {
                key: 'date',
                title: 'Time (Toronto)',
                render: (row) => formatTime(row.occurredAt),
                sortValue: (row) => Date.parse(row.occurredAt),
              },
              {
                key: 'module',
                title: 'Module',
                render: (row) => row.module,
                sortValue: (row) => row.module,
              },
              { key: 'outcome', title: 'Outcome', render: (row) => row.outcomeId },
              {
                key: 'quantity',
                title: 'Quantity',
                render: (row) => count.format(row.quantity),
                sortValue: (row) => row.quantity,
              },
              { key: 'unit', title: 'Unit', render: (row) => row.unit.replaceAll('_', ' ') },
            ]}
          />
        </Card>
      )}
    </div>
  );
}
