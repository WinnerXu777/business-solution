import { useI18n } from '../i18n.tsx';
import type { WorkflowValidation } from '../clients/workflow-management.ts';
import { useCallback, useEffect, useState } from 'react';
import { Background, Controls, ReactFlow } from '@xyflow/react';
import type { Connection, Edge, Node, XYPosition } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Button,
  Card,
  CodeBlock,
  Dialog,
  EmptyState,
  Field,
  Input,
  Select,
  StatusPill,
} from '../components.tsx';
import { RemoteContent, useAction, useResource } from '../data.tsx';
import { canDecideApproval, canOperate, canReview, PlatformError } from '../platform-client.ts';
import type { PlatformRouteContext } from '../platform-app.tsx';
import type { WorkflowApproval, WorkflowPreview, WorkflowRun } from '../clients/automation.ts';
import {
  isScalar,
  isValueMap,
  isWorkflowMap,
  resolveWorkflow,
  validId,
  validateWorkflow,
  workflowEdges,
} from '../clients/workflow-definition.ts';
import type {
  Scalar,
  TriggerKind,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowTarget,
  WorkflowValue,
} from '../clients/workflow-definition.ts';
import { Details, ResourceTable, routeId, routeLink, useRequestKey } from './feature-helpers.tsx';

const definitionKey = (workflow: WorkflowDefinition) => workflow.id + '@' + workflow.version;
const nodeKinds = ['trigger', 'condition', 'mapping', 'delay', 'approval', 'action'] as const;

function createNode(kind: WorkflowNode['kind'], id: string): WorkflowNode {
  switch (kind) {
    case 'trigger':
      return { id, kind, trigger: 'manual', next: '' };
    case 'condition':
      return { id, kind, left: { ref: 'eligible' }, equals: true, next: '', otherwise: null };
    case 'mapping':
      return { id, kind, values: { orderId: 'ord-001' }, next: '' };
    case 'delay':
      return { id, kind, milliseconds: 1000, next: '' };
    case 'approval':
      return { id, kind, next: '' };
    case 'action':
      return { id, kind, action: { tool: 'order.read', orderId: 'ord-001' }, next: null };
  }
}

const initialDefinition: WorkflowDefinition = {
  id: 'order-check',
  version: 1,
  nodes: [
    { id: 'manual', kind: 'trigger', trigger: 'manual', next: 'read' },
    createNode('action', 'read'),
  ],
};

export function WorkflowsScreen({ client, me, notify }: PlatformRouteContext) {
  const api = client.automation;
  const definitions = useResource(useCallback(() => api.listDefinitions(), [api]));
  const [selected, setSelected] = useState<string>();
  const [newDefinition, setNewDefinition] = useState(false);
  return (
    <div className="bs-stack">
      <div className="bs-feature-actions">
        <a href="#/workflows/runs">Workflow runs</a>
        <a href="#/workflows/dead-letters">Dead letters</a>
      </div>
      <RemoteContent resource={definitions} label="workflow definitions">
        {(rows) => {
          const published = newDefinition
            ? undefined
            : (rows.find((row) => definitionKey(row) === selected) ?? rows[0]);
          const nextVersion = published
            ? Math.max(...rows.filter((row) => row.id === published.id).map((row) => row.version)) +
              1
            : 1;
          return (
            <>
              <Card title="Published definitions">
                {rows.length ? (
                  <Field label="Definition and version">
                    {(props) => (
                      <Select
                        {...props}
                        value={published ? definitionKey(published) : ''}
                        onChange={(event) => {
                          setSelected(event.target.value);
                          setNewDefinition(false);
                        }}
                      >
                        {newDefinition && <option value="">New draft</option>}
                        {rows.map((row) => (
                          <option key={definitionKey(row)} value={definitionKey(row)}>
                            {row.id} · v{row.version}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                ) : (
                  <EmptyState title="No published definitions." />
                )}
                {canOperate(me.role) && (
                  <div className="bs-feature-actions">
                    <Button
                      variant="secondary"
                      disabled={newDefinition}
                      onClick={() => setNewDefinition(true)}
                    >
                      New workflow
                    </Button>
                  </div>
                )}
              </Card>
              {(published || canOperate(me.role)) && (
                <WorkflowEditor
                  key={published ? definitionKey(published) : 'new'}
                  client={client}
                  me={me}
                  notify={notify}
                  published={published}
                  nextVersion={nextVersion}
                  onPublished={(value) => {
                    setSelected(definitionKey(value));
                    setNewDefinition(false);
                    definitions.reload();
                  }}
                />
              )}
            </>
          );
        }}
      </RemoteContent>
      {canReview(me.role) && <WorkflowApprovalInbox client={client} me={me} notify={notify} />}
    </div>
  );
}

function WorkflowApprovalInbox({
  client,
  me,
  notify,
}: Pick<PlatformRouteContext, 'client' | 'me' | 'notify'>) {
  const api = client.automation;
  const resource = useResource(useCallback(() => api.listWorkflowApprovals(), [api]));
  const [selected, setSelected] = useState<WorkflowApproval>();
  const action = useAction(notify);
  return (
    <>
      <ResourceTable
        label="Assigned workflow approvals"
        resource={resource}
        rowKey={(row) => row.approval.id}
        columns={[
          {
            key: 'subject',
            title: 'Subject',
            render: (row) => (
              <Button variant="quiet" onClick={() => setSelected(row)}>
                {row.approval.subjectId}
              </Button>
            ),
          },
          { key: 'requester', title: 'Requester', render: (row) => row.approval.requestedBy },
          {
            key: 'status',
            title: 'Status',
            render: (row) => <StatusPill status={row.result?.state ?? row.approval.state} />,
          },
        ]}
      />
      {selected && (
        <Dialog
          title="Review workflow approval"
          onClose={() => setSelected(undefined)}
          busy={action.busy}
        >
          <div className="bs-stack">
            <Details
              fields={[
                ['Subject', selected.approval.subjectId],
                ['Requester', selected.approval.requestedBy],
                ['Expires', selected.approval.expiresAt],
                ['Material SHA-256', selected.approval.materialHash],
              ]}
            />
            {selected.previews?.length ? (
              <CodeBlock label="Bound message previews">
                {JSON.stringify(selected.previews, null, 2)}
              </CodeBlock>
            ) : (
              <EmptyState title="No message material attached." />
            )}
            {!selected.result && canDecideApproval(me, selected.approval) && (
              <div>
                <Button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(
                      () => api.approveWorkflow(selected.approval.id),
                      () => {
                        setSelected(undefined);
                        resource.reload();
                        notify('Workflow approval submitted.');
                      },
                    )
                  }
                >
                  Approve workflow
                </Button>
              </div>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}

export function WorkflowDraftScreen(props: PlatformRouteContext) {
  const { client, path } = props;
  const { t } = useI18n();
  const id = routeId(path);
  const load = useResource(useCallback(() => client.workflowManagement.getDraft(id), [client, id]));
  return (
    <RemoteContent resource={load} label={t('Workflow draft')}>
      {({ definition }) => (
        <WorkflowEditor
          {...props}
          installedDraft={definition}
          nextVersion={definition.version}
          onPublished={() => {
            window.location.hash = '#/workflows';
          }}
        />
      )}
    </RemoteContent>
  );
}

function WorkflowEditor({
  client,
  me,
  notify,
  published,
  installedDraft,
  nextVersion,
  onPublished,
}: Pick<PlatformRouteContext, 'client' | 'me' | 'notify'> & {
  published?: WorkflowDefinition;
  installedDraft?: WorkflowDefinition;
  nextVersion: number;
  onPublished: (value: WorkflowDefinition) => void;
}) {
  const editable = canOperate(me.role);
  const { t } = useI18n();
  const initial = installedDraft ?? published ?? initialDefinition;
  const [draft, setDraft] = useState<WorkflowDefinition>({ ...initial, version: nextVersion });
  const [selection, setSelection] = useState(initial.nodes[0].id);
  const [kind, setKind] = useState<WorkflowNode['kind']>('mapping');
  const [positions, setPositions] = useState<Record<string, XYPosition>>({});
  const [invalidFields, setInvalidFields] = useState<Record<string, string>>({});
  const [inputText, setInputText] = useState('{}');
  const [receipt, setReceipt] = useState('');
  const [preview, setPreview] = useState<WorkflowPreview>();
  const action = useAction(notify);
  const attempt = useRequestKey();

  const display = editable ? draft : initial;
  const activeNode = display.nodes.find((node) => node.id === selection);
  const validation =
    Object.keys(invalidFields).length > 0
      ? 'Correct the node configuration.'
      : validateWorkflow(draft);
  const [serverValidation, setServerValidation] = useState<{
    definition: WorkflowDefinition;
    result: WorkflowValidation;
  }>();
  const issues =
    serverValidation?.definition === display ? serverValidation.result.issues : undefined;
  const affectedNodes = new Set(issues?.map((issue) => issue.nodeId));
  const flowNodes: Node[] = display.nodes.map((node, index) => ({
    id: node.id,
    data: {
      label:
        node.id +
        ' · ' +
        t(node.kind) +
        (affectedNodes.has(node.id) ? ' · ' + t('Invalid node') : ''),
    },
    className: affectedNodes.has(node.id) ? 'bs-flow-node-error' : undefined,
    selected: node.id === selection,
    position: positions[node.id] ?? {
      x: 36 + (index % 3) * 220,
      y: 32 + Math.floor(index / 3) * 105,
    },
  }));
  const edges: Edge[] = display.nodes.flatMap((node) =>
    workflowEdges(node).map(({ slot, target }) => ({
      id: node.id + ':' + slot,
      source: node.id,
      target,
      label: slot === 'otherwise' ? 'Otherwise' : undefined,
      animated: false,
    })),
  );

  function update(node: WorkflowNode) {
    setDraft((value) => ({
      ...value,
      nodes: value.nodes.map((entry) => (entry.id === node.id ? node : entry)),
    }));
    setPreview(undefined);
  }

  function markField(field: string, invalid: string | undefined) {
    const key = selection + ':' + field;
    setInvalidFields((value) => {
      const next = { ...value };
      if (invalid === undefined) delete next[key];
      else next[key] = invalid;
      return next;
    });
    if (invalid !== undefined) setPreview(undefined);
  }

  function connect({ source, target }: Connection) {
    const node = draft.nodes.find((item) => item.id === source);
    if (node && target && target !== source) update({ ...node, next: target });
  }

  function addNode() {
    let index = 1;
    while (draft.nodes.some((item) => item.id === kind + '-' + index)) index += 1;
    const node = createNode(kind, kind + '-' + index);
    setDraft((value) => ({ ...value, nodes: [...value.nodes, node] }));
    setSelection(node.id);
    setPreview(undefined);
  }

  function removeNode(id: string) {
    setDraft((value) => ({
      ...value,
      nodes: value.nodes
        .filter((node) => node.id !== id)
        .map(
          (node) =>
            ({
              ...node,
              ...(node.next === id && { next: node.kind === 'action' ? null : '' }),
              ...(node.kind === 'condition' && node.otherwise === id && { otherwise: null }),
            }) as WorkflowNode,
        ),
    }));
    setInvalidFields((value) =>
      Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith(id + ':'))),
    );
    setSelection(draft.nodes[0].id);
    setPreview(undefined);
  }

  function targetFor(definition: WorkflowDefinition, launching = false): WorkflowTarget {
    const values: unknown = parseJson(inputText);
    if (!isValueMap(values, isScalar)) throw new PlatformError('invalid_input');
    const trigger = definition.nodes[0];
    if (trigger.kind !== 'trigger') throw new PlatformError('invalid_input');
    const receiptKey = receipt.trim();
    if (trigger.trigger !== 'manual' && launching && !validId(receiptKey))
      throw new PlatformError('invalid_input');
    return {
      definitionId: definition.id,
      version: definition.version,
      input: {
        trigger:
          trigger.trigger === 'manual'
            ? { kind: 'manual' }
            : {
                kind: trigger.trigger,
                name: trigger.name ?? undefined,
                key: receiptKey || 'preview-receipt',
              },
        values,
      },
    };
  }

  return (
    <>
      <Card title="Workflow editor">
        <div className="bs-stack">
          {editable && (
            <div className="bs-feature-fields">
              <Field label="Definition ID">
                {(props) => (
                  <Input
                    {...props}
                    value={draft.id}
                    onChange={(event) => {
                      setDraft({ ...draft, id: event.target.value });
                      setPreview(undefined);
                    }}
                  />
                )}
              </Field>
              <Field label="Version to publish">
                {(props) => (
                  <Input
                    {...props}
                    type="number"
                    min={1}
                    value={draft.version || ''}
                    onChange={(event) => {
                      setDraft({ ...draft, version: Number(event.target.value) });
                      setPreview(undefined);
                    }}
                  />
                )}
              </Field>
              <Field label="Node type">
                {(props) => (
                  <Select
                    {...props}
                    value={kind}
                    onChange={(event) => {
                      const next = nodeKinds.find((item) => item === event.target.value);
                      if (next) setKind(next);
                    }}
                  >
                    {nodeKinds
                      .filter((item) => item !== 'trigger')
                      .map((item) => (
                        <option key={item}>{item}</option>
                      ))}
                  </Select>
                )}
              </Field>
              <Button variant="secondary" disabled={draft.nodes.length >= 40} onClick={addNode}>
                Add node
              </Button>
            </div>
          )}
          <div className="bs-inline">
            <Button
              variant="secondary"
              disabled={action.busy}
              onClick={() => {
                setServerValidation(undefined);
                void action.run(
                  () => client.workflowManagement.validate(display),
                  (result) => setServerValidation({ definition: display, result }),
                );
              }}
            >
              {t('Validate workflow')}
            </Button>
            <a href={'#/workflows/diff/' + encodeURIComponent(display.id)}>
              {t('Compare versions')}
            </a>
          </div>
          {issues &&
            (issues.length ? (
              <ul role="alert">
                {issues.map((issue, index) => (
                  <li key={index}>
                    {issue.nodeId && (
                      <button
                        className="bs-link-button"
                        type="button"
                        onClick={() => setSelection(issue.nodeId!)}
                      >
                        {issue.nodeId}
                      </button>
                    )}{' '}
                    {t(issue.message)}
                  </li>
                ))}
              </ul>
            ) : (
              <p role="status">{t('Workflow validation passed.')}</p>
            ))}
          <div className="bs-flow" aria-label={t('Workflow canvas')}>
            <ReactFlow
              nodes={flowNodes}
              edges={edges}
              onNodeClick={(_, node) => setSelection(node.id)}
              onNodeDragStop={(_, node) =>
                setPositions((value) => ({ ...value, [node.id]: node.position }))
              }
              onConnect={editable ? connect : undefined}
              nodesDraggable={editable}
              nodesConnectable={editable}
              deleteKeyCode={null}
              fitView
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
          <Field label="Inspect node">
            {(props) => (
              <Select
                {...props}
                value={selection}
                onChange={(event) => setSelection(event.target.value)}
              >
                {display.nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.id} · {node.kind}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {activeNode &&
            (editable ? (
              <NodeConfiguration
                key={activeNode.id}
                node={activeNode}
                nodes={draft.nodes}
                update={update}
                invalidFields={invalidFields}
                markField={markField}
                remove={removeNode}
              />
            ) : (
              <CodeBlock label="Node configuration">
                {JSON.stringify(activeNode, null, 2)}
              </CodeBlock>
            ))}
          {editable && (
            <>
              {validation && (
                <p className="bs-text-danger" role="status">
                  {validation}
                </p>
              )}
              <div>
                <Button
                  disabled={action.busy || !!validation}
                  onClick={() =>
                    void action.run(
                      () => client.automation.publish(draft),
                      (value) => {
                        onPublished(value);
                        notify('Workflow version published.');
                      },
                    )
                  }
                >
                  Publish version
                </Button>
              </div>
            </>
          )}
        </div>
      </Card>
      <Card title="Preview and run">
        <form className="bs-stack" onSubmit={(event) => event.preventDefault()}>
          <Field label="Input values" hint="Enter a JSON object with scalar values.">
            {(props) => (
              <textarea
                className="bs-input"
                {...props}
                value={inputText}
                onChange={(event) => {
                  setInputText(event.target.value);
                  setPreview(undefined);
                }}
              />
            )}
          </Field>
          {published?.nodes[0].kind === 'trigger' && published.nodes[0].trigger !== 'manual' && (
            <Field label="Trigger receipt key">
              {(props) => (
                <Input
                  {...props}
                  value={receipt}
                  onChange={(event) => {
                    setReceipt(event.target.value);
                    setPreview(undefined);
                  }}
                />
              )}
            </Field>
          )}
          <div className="bs-feature-actions">
            {editable && (
              <Button
                variant="secondary"
                disabled={action.busy || !!validation}
                onClick={() =>
                  void action.run(async () => {
                    const steps = resolveWorkflow(draft, targetFor(draft).input);
                    const messages = steps.some((entry) => entry.tool === 'workflow.template.run')
                      ? await client.automation.previewMessages()
                      : [];
                    return { steps, messages };
                  }, setPreview)
                }
              >
                Preview draft
              </Button>
            )}
            {published && (
              <>
                <Button
                  variant="secondary"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(
                      async () => client.automation.preview(targetFor(published)),
                      setPreview,
                    )
                  }
                >
                  Preview published v{published.version}
                </Button>
                {editable && (
                  <Button
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(
                        async () => {
                          const target = targetFor(published, true);
                          return client.automation.startWorkflow(target, attempt.key(target));
                        },
                        (run) => {
                          attempt.clear();
                          window.location.hash = routeLink('/workflows/run', run.id);
                        },
                      )
                    }
                  >
                    Run published v{published.version}
                  </Button>
                )}
              </>
            )}
          </div>
          {preview && (
            <section aria-label="Workflow preview" className="bs-stack">
              <p>No messages sent.</p>
              <ol className="bs-timeline">
                {preview.steps.map((step) => (
                  <li key={step.nodeId}>
                    <strong>{step.nodeId}</strong> · {step.tool ?? step.kind}{' '}
                    {step.milliseconds && '(' + step.milliseconds + ' ms)'}
                    {step.input !== undefined && (
                      <CodeBlock label={step.nodeId + ' inputs'}>
                        {JSON.stringify(step.input, null, 2)}
                      </CodeBlock>
                    )}
                  </li>
                ))}
              </ol>
              {preview.messages.length ? (
                preview.messages.map((message) => (
                  <section key={message.id} className="bs-inset">
                    <h3>{message.subject ?? message.channel}</h3>
                    <p>
                      {message.customerId} · {message.recipient}
                    </p>
                    <p>{message.body}</p>
                  </section>
                ))
              ) : (
                <EmptyState title="No would-be messages." />
              )}
            </section>
          )}
        </form>
      </Card>
    </>
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function JsonNodeField<T>({
  label,
  initial,
  parse,
  commit,
  markField,
  invalidText,
}: {
  label: string;
  initial: T;
  parse: (value: unknown) => value is T;
  commit: (value: T) => void;
  invalidText?: string;
  markField: (field: string, invalid: string | undefined) => void;
}) {
  const initialText = JSON.stringify(initial);
  return (
    <Field
      label={label}
      hint="Use JSON values. Use a ref object to reference a run field."
      error={invalidText !== undefined ? 'Enter a valid value.' : undefined}
    >
      {(props) => (
        <Input
          {...props}
          value={invalidText ?? initialText}
          onChange={(event) => {
            const text = event.target.value;
            const value = parseJson(text);
            if (parse(value)) {
              commit(value);
              markField(label, undefined);
            } else {
              markField(label, text);
            }
          }}
        />
      )}
    </Field>
  );
}

const isOrderInput = (value: unknown): value is string | { ref: string } =>
  validId(value) ||
  (!!value &&
    typeof value === 'object' &&
    Object.keys(value).length === 1 &&
    'ref' in value &&
    validId(value.ref));
const isInput = (value: unknown): value is WorkflowValue => isScalar(value) || isOrderInput(value);

function NodeConfiguration({
  node,
  nodes,
  update,
  markField,
  invalidFields,
  remove,
}: {
  node: WorkflowNode;
  nodes: WorkflowNode[];
  update: (node: WorkflowNode) => void;
  invalidFields: Record<string, string>;
  markField: (field: string, invalid: string | undefined) => void;
  remove: (id: string) => void;
}) {
  const destinations = nodes.filter((item) => item.id !== node.id && item.kind !== 'trigger');
  return (
    <section className="bs-inset bs-stack" aria-label="Node configuration">
      <div className="bs-feature-fields">
        {node.kind === 'trigger' && (
          <>
            <Field label="Trigger kind">
              {(props) => (
                <Select
                  {...props}
                  value={node.trigger}
                  onChange={(event) =>
                    update({ ...node, trigger: event.target.value as TriggerKind, name: null })
                  }
                >
                  <option value="manual">Manual</option>
                  <option value="schedule">Schedule</option>
                  <option value="event">Event</option>
                </Select>
              )}
            </Field>
            {node.trigger !== 'manual' && (
              <Field label="Trigger name">
                {(props) => (
                  <Input
                    {...props}
                    value={node.name ?? ''}
                    onChange={(event) => update({ ...node, name: event.target.value })}
                  />
                )}
              </Field>
            )}
          </>
        )}
        {node.kind === 'condition' && (
          <>
            <JsonNodeField
              label="Compare value"
              invalidText={invalidFields[node.id + ':Compare value']}
              initial={node.left}
              parse={isInput}
              commit={(left) => update({ ...node, left })}
              markField={markField}
            />
            <JsonNodeField<Scalar>
              label="Equals"
              invalidText={invalidFields[node.id + ':Equals']}
              initial={node.equals}
              parse={isScalar}
              commit={(equals) => update({ ...node, equals })}
              markField={markField}
            />
          </>
        )}
        {node.kind === 'mapping' && (
          <JsonNodeField
            label="Field mappings"
            invalidText={invalidFields[node.id + ':Field mappings']}
            initial={node.values}
            parse={isWorkflowMap}
            commit={(values) => update({ ...node, values })}
            markField={markField}
          />
        )}
        {node.kind === 'delay' && (
          <Field label="Delay (ms)">
            {(props) => (
              <Input
                {...props}
                type="number"
                min={1}
                max={604800000}
                value={node.milliseconds || ''}
                onChange={(event) => update({ ...node, milliseconds: Number(event.target.value) })}
              />
            )}
          </Field>
        )}
        {node.kind === 'action' && (
          <>
            <Field label="Typed action">
              {(props) => (
                <Select
                  {...props}
                  value={node.action.tool}
                  onChange={(event) => {
                    markField('Order ID or reference', undefined);
                    update({
                      ...node,
                      action:
                        event.target.value === 'order.read'
                          ? { tool: 'order.read', orderId: 'ord-001' }
                          : { tool: 'workflow.template.run', templateId: 'win-back-v1' },
                    });
                  }}
                >
                  <option value="order.read">Read order</option>
                  <option value="workflow.template.run">Win-back dispatch</option>
                </Select>
              )}
            </Field>
            {node.action.tool === 'order.read' && (
              <JsonNodeField
                label="Order ID or reference"
                invalidText={invalidFields[node.id + ':Order ID or reference']}
                initial={node.action.orderId}
                parse={isOrderInput}
                commit={(orderId) => update({ ...node, action: { tool: 'order.read', orderId } })}
                markField={markField}
              />
            )}
            <Field label="Maximum attempts">
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  min={1}
                  max={5}
                  value={node.maxAttempts ?? 3}
                  onChange={(event) => update({ ...node, maxAttempts: Number(event.target.value) })}
                />
              )}
            </Field>
            <Field label="Initial backoff (ms)">
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  min={1}
                  max={60000}
                  value={node.backoffMs ?? 1000}
                  onChange={(event) => update({ ...node, backoffMs: Number(event.target.value) })}
                />
              )}
            </Field>
          </>
        )}
        <Field label={node.kind === 'condition' ? 'When equal' : 'Next node'}>
          {(props) => (
            <Select
              {...props}
              value={node.next ?? ''}
              onChange={(event) =>
                update({
                  ...node,
                  next: event.target.value || (node.kind === 'action' ? null : ''),
                } as WorkflowNode)
              }
            >
              <option value="">{node.kind === 'action' ? 'End' : 'Select node'}</option>
              {destinations.map((item) => (
                <option key={item.id}>{item.id}</option>
              ))}
            </Select>
          )}
        </Field>
        {node.kind === 'condition' && (
          <Field label="Otherwise">
            {(props) => (
              <Select
                {...props}
                value={node.otherwise ?? ''}
                onChange={(event) => update({ ...node, otherwise: event.target.value || null })}
              >
                <option value="">End</option>
                {destinations.map((item) => (
                  <option key={item.id}>{item.id}</option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </div>
      {node.kind !== 'trigger' && (
        <div>
          <Button variant="quiet" onClick={() => remove(node.id)}>
            Remove node
          </Button>
        </div>
      )}
    </section>
  );
}

export function WorkflowRunsScreen({ client, me, notify, path }: PlatformRouteContext) {
  const dead = path.endsWith('dead-letters');
  const list = useResource(
    useCallback(
      () => (dead ? client.automation.listDeadLetters() : client.automation.listWorkflowRuns()),
      [client, dead],
    ),
  );
  const action = useAction(notify);
  return (
    <div className="bs-stack">
      <div className="bs-feature-actions">
        <a href="#/workflows">Workflow definitions</a>
        <a href={dead ? '#/workflows/runs' : '#/workflows/dead-letters'}>
          {dead ? 'Workflow runs' : 'Dead letters'}
        </a>
      </div>
      <ResourceTable<WorkflowRun>
        label={dead ? 'Dead letters' : 'Workflow runs'}
        resource={list}
        rowKey={(row) => row.id}
        columns={[
          {
            key: 'run',
            title: 'Run',
            render: (row) => <a href={routeLink('/workflows/run', row.id)}>{row.id}</a>,
          },
          {
            key: 'definition',
            title: 'Definition',
            render: (row) => row.definitionId + ' v' + row.version,
          },
          { key: 'status', title: 'Status', render: (row) => <StatusPill status={row.status} /> },
          ...(dead && canOperate(me.role)
            ? [
                {
                  key: 'replay',
                  title: 'Recovery',
                  render: (row: WorkflowRun) =>
                    row.replayable && row.status !== 'unknown' ? (
                      <Button
                        variant="secondary"
                        disabled={action.busy}
                        onClick={() =>
                          void action.run(
                            () => client.automation.replayWorkflow(row.id),
                            () => {
                              list.reload();
                              notify('Workflow replay started.');
                            },
                          )
                        }
                      >
                        Replay {row.id}
                      </Button>
                    ) : (
                      'Reconciliation required'
                    ),
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}

export function WorkflowHistoryScreen({ client, path }: PlatformRouteContext) {
  const id = routeId(path);
  const resource = useResource(
    useCallback(() => client.automation.getWorkflowHistory(id), [client, id]),
  );
  const ready = resource.state.status === 'ready' ? resource.state.data : undefined;
  useEffect(() => {
    if (!ready || !['delayed', 'retrying', 'running', 'pending_approval'].includes(ready.status))
      return;
    const timer = setTimeout(
      resource.reload,
      ready.dueAt === null ? 3000 : Math.max(1000, Math.min(30_000, ready.dueAt - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [ready, resource.reload]);

  return (
    <div className="bs-stack">
      <a href="#/workflows/runs">Back to workflow runs</a>
      <Card title="Run history">
        <RemoteContent resource={resource} label="workflow history">
          {(run) => (
            <>
              <Details
                fields={[
                  ['Run', run.id],
                  ['Definition', run.definitionId + ' v' + run.version],
                  ['Status', <StatusPill status={run.status} />],
                  ['Current node', run.nodeId ?? '—'],
                  ...(run.approval
                    ? ([
                        ['Approval ID', run.approval.id],
                        ['Assigned approver', run.approval.approverId],
                      ] as [string, string][])
                    : []),
                ]}
              />
              {run.history.length ? (
                <ol className="bs-timeline" aria-label="Workflow history">
                  {run.history.map((item) => (
                    <li key={item.id}>
                      <time dateTime={new Date(item.at).toISOString()}>
                        {new Date(item.at).toISOString().slice(11, 19)} UTC
                      </time>{' '}
                      <strong>{item.kind.replaceAll('_', ' ')}</strong> {item.nodeId}{' '}
                      {item.state ?? item.status}
                    </li>
                  ))}
                </ol>
              ) : (
                <EmptyState title="No workflow events." />
              )}
              {run.result && (
                <CodeBlock label="Workflow result">{JSON.stringify(run.result, null, 2)}</CodeBlock>
              )}
            </>
          )}
        </RemoteContent>
      </Card>
    </div>
  );
}
