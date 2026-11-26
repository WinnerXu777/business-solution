import { useCallback, useState } from 'react';
import { Button, Card, EmptyState } from '../components.tsx';
import type {
  TemplatePreview,
  TemplateValues,
  WorkflowDiff,
  WorkflowTemplate,
} from '../clients/workflow-management.ts';
import { validId } from '../clients/workflow-definition.ts';
import { RemoteContent, useAction, useResource } from '../data.tsx';
import { useI18n } from '../i18n.tsx';
import type { PlatformRouteContext } from '../platform-app.tsx';
import { canOperate, PlatformError } from '../platform-client.ts';
import { Form, List, Status, Submit, TextField, field } from './round-four.tsx';
import { routeId, routeLink } from './feature-helpers.tsx';

export function TemplatesScreen(props: PlatformRouteContext) {
  const api = props.client.workflowManagement;
  const { t } = useI18n();
  const load = useResource(useCallback(() => api.listTemplates(), [api]));
  return (
    <RemoteContent resource={load} label={t('Workflow templates')}>
      {(templates) =>
        templates.length ? (
          <div className="bs-stack">
            {templates.map((template) => (
              <TemplateCard key={template.id} {...props} template={template} />
            ))}
          </div>
        ) : (
          <EmptyState title={t('No workflow templates.')} />
        )
      }
    </RemoteContent>
  );
}

function TemplateCard({
  template,
  client,
  me,
  notify,
}: PlatformRouteContext & { template: WorkflowTemplate }) {
  const api = client.workflowManagement;
  const { t } = useI18n();
  const [preview, setPreview] = useState<{ input: TemplateValues; value: TemplatePreview }>();
  const [installed, setInstalled] = useState<string>();
  const action = useAction(notify);
  return (
    <Card title={t(template.name)}>
      <p>{t(template.description)}</p>
      <Form
        onSubmit={(data) => {
          const input = Object.fromEntries(
            template.parameters.map(({ key }) => [key, field(data, key)]),
          );
          setPreview(undefined);
          setInstalled(undefined);
          void action.run(
            () => api.previewTemplate(template.id, input),
            (value) => setPreview({ input, value }),
          );
        }}
      >
        {template.parameters.map((parameter) => (
          <TextField
            key={parameter.key}
            name={parameter.key}
            label={parameter.label}
            required={parameter.required}
            defaultValue={parameter.defaultValue}
            onChange={() => {
              setPreview(undefined);
              setInstalled(undefined);
            }}
          />
        ))}
        <Submit busy={action.busy} label="Preview template" />
      </Form>
      {preview && (
        <div className="bs-stack">
          <p>
            {t('Draft preview')} · {preview.value.definition.id}
          </p>
          {preview.value.definition.nodes.length ? (
            <ol>
              {preview.value.definition.nodes.map((node) => (
                <li key={node.id}>
                  <code>{node.id}</code> · {t(node.kind)}
                  {node.kind === 'action' && (
                    <>
                      {' '}
                      ·{' '}
                      <code>
                        {node.action.tool}
                        {node.action.tool === 'order.read' &&
                        typeof node.action.orderId === 'string'
                          ? ' · ' + node.action.orderId
                          : ''}
                      </code>
                    </>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p>{t('No entries.')}</p>
          )}
          {canOperate(me.role) && !installed && (
            <div>
              <Button
                disabled={action.busy}
                onClick={() =>
                  void action.run(
                    () => api.installTemplate(template.id, preview.input),
                    ({ definition }) => {
                      setInstalled(definition.id);
                      notify(t('Workflow draft installed.'));
                    },
                  )
                }
              >
                {t('Install as draft')}
              </Button>
            </div>
          )}
        </div>
      )}
      {installed && (
        <a href={routeLink('/workflows/draft', installed)}>
          {t('Open draft')} · {installed}
        </a>
      )}
    </Card>
  );
}

export function TriggersScreen({ client, me, notify }: PlatformRouteContext) {
  const api = client.workflowManagement;
  const { t } = useI18n();
  const action = useAction(notify);
  const load = useResource(useCallback(() => api.listTriggers(), [api]));
  return (
    <List
      title="Workflow triggers"
      load={load}
      columns={[
        { key: 'workflow', title: 'Workflow ID', render: (row) => row.workflowId },
        { key: 'type', title: 'Type', render: (row) => t(row.kind) },
        {
          key: 'schedule',
          title: 'Trigger configuration',
          render: (row) => (
            <code>
              {row.kind === 'cron'
                ? row.cron + ' · ' + row.timeZone
                : row.kind === 'event'
                  ? row.event
                  : row.webhookId}
            </code>
          ),
        },
        {
          key: 'status',
          title: 'Status',
          render: (row) => <Status value={row.paused ? 'Paused' : 'Active'} />,
        },
        ...(canOperate(me.role)
          ? [
              {
                key: 'action',
                title: 'Action',
                render: (row: Awaited<ReturnType<typeof api.listTriggers>>[number]) => (
                  <Button
                    variant="secondary"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(
                        () => api.setTriggerPaused(row.id, !row.paused),
                        () => {
                          load.reload();
                          notify(t(row.paused ? 'Trigger resumed.' : 'Trigger paused.'));
                        },
                      )
                    }
                  >
                    {t(row.paused ? 'Resume trigger' : 'Pause trigger')}
                  </Button>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}

export function WorkflowDiffScreen({ client, path, notify }: PlatformRouteContext) {
  const { t, number } = useI18n();
  const initialId = path.startsWith('/workflows/diff/') ? routeId(path) : '';
  const [diff, setDiff] = useState<WorkflowDiff>();
  const action = useAction(notify);
  return (
    <Card title={t('Compare workflow versions')}>
      <Form
        onSubmit={(data) => {
          setDiff(undefined);
          void action.run(async () => {
            const id = field(data, 'id');
            if (!validId(id)) throw new PlatformError('invalid_input');
            return client.workflowManagement.diff(
              id,
              Number(field(data, 'from')),
              Number(field(data, 'to')),
            );
          }, setDiff);
        }}
      >
        <TextField label="Workflow ID" name="id" defaultValue={initialId} />
        <TextField
          label="From version"
          name="from"
          type="number"
          min={1}
          step={1}
          defaultValue={1}
        />
        <TextField label="To version" name="to" type="number" min={1} step={1} defaultValue={2} />
        <Submit busy={action.busy} label="Compare versions" />
      </Form>
      {action.busy && <p role="status">{t('Comparing versions…')}</p>}
      {diff && (
        <div>
          <p>
            {diff.workflowId} · {number(diff.fromVersion)} → {number(diff.toVersion)}
          </p>
          {diff.changes.length ? (
            diff.changes.map((change) => (
              <details key={change.nodeId} open>
                <summary>
                  {change.nodeId} ·{' '}
                  {t(!change.before ? 'Added' : !change.after ? 'Removed' : 'Changed')}
                </summary>
                <dl className="bs-details">
                  <dt>{t('Before')}</dt>
                  <dd>
                    <pre className="bs-code">
                      {change.before ? JSON.stringify(change.before, null, 2) : '—'}
                    </pre>
                  </dd>
                  <dt>{t('After')}</dt>
                  <dd>
                    <pre className="bs-code">
                      {change.after ? JSON.stringify(change.after, null, 2) : '—'}
                    </pre>
                  </dd>
                </dl>
              </details>
            ))
          ) : (
            <p>{t('No version changes.')}</p>
          )}
        </div>
      )}
    </Card>
  );
}
