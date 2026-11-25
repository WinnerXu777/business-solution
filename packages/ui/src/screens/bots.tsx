import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Card,
  CodeBlock,
  EmptyState,
  Field,
  Input,
  Select,
  StatusPill,
  Table,
} from '../components.tsx';
import { RemoteContent, errorMessage, useAction, useResource } from '../data.tsx';
import { canDecideApproval, canOperate, canReview, denialMessages } from '../platform-client.ts';
import type { PlatformRouteContext } from '../platform-app.tsx';
import type { BotDefinition, BotEvent, BotRun } from '../clients/automation.ts';
import { Details, useRequestKey } from './feature-helpers.tsx';

const keyFor = (bot: BotDefinition) => bot.id + ':' + bot.version;
const active = (run: BotRun) => ['queued', 'running', 'pending_approval'].includes(run.status);

function readHistory(key: string): string[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? '[]');
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === 'string').slice(0, 20)
      : [];
  } catch {
    return [];
  }
}

export function BotsScreen({ client, me, notify }: PlatformRouteContext) {
  const api = client.automation;
  const bots = useResource(useCallback(() => api.listBots(), [api]));
  const action = useAction(notify);
  const attempt = useRequestKey();
  const storageKey = 'bs-bots:' + me.tenant.id + ':' + me.actor.id;
  const [history, setHistory] = useState(() => readHistory(storageKey));
  const [selection, setSelection] = useState('');
  const [prompt, setPrompt] = useState('');
  const [route, setRoute] = useState<'native' | 'byo'>('native');
  const [runId, setRunId] = useState('');
  const [approvalLink, setApprovalLink] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [approvalRun, setApprovalRun] = useState<BotRun>();

  function view(run: BotRun) {
    const next = [run.id, ...history.filter((id) => id !== run.id)].slice(0, 20);
    setHistory(next);
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* History remains in memory. */
    }
    setRunId(run.id);
  }

  return (
    <div className="bs-stack">
      <Card title="Bot versions">
        <RemoteContent resource={bots} label="bot versions">
          {(rows) =>
            rows.length ? (
              <>
                <Table
                  label="Bot versions"
                  rows={rows}
                  rowKey={keyFor}
                  columns={[
                    { key: 'name', title: 'Bot', render: (row) => row.id },
                    { key: 'version', title: 'Version', render: (row) => row.version },
                    {
                      key: 'tools',
                      title: 'Allowed tools',
                      render: (row) => row.allowedTools.join(', '),
                    },
                    {
                      key: 'budget',
                      title: 'Run budget',
                      render: (row) => row.maxActions + ' actions / ' + row.maxSeconds + ' s',
                    },
                  ]}
                />
                {canOperate(me.role) && (
                  <form
                    className="bs-stack"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const bot = rows.find(
                        (item) => keyFor(item) === (selection || keyFor(rows[0])),
                      );
                      if (!bot || !prompt.trim()) return;
                      const input = {
                        botId: bot.id,
                        version: bot.version,
                        sessionId: 'portal-session',
                        prompt: prompt.trim(),
                        route,
                      };
                      void action.run(
                        () => api.startBot(input, attempt.key(input)),
                        (started) => {
                          attempt.clear();
                          view(started);
                          notify('Bot run started.');
                        },
                      );
                    }}
                  >
                    <div className="bs-feature-fields">
                      <Field label="Bot version">
                        {(props) => (
                          <Select
                            {...props}
                            value={selection || keyFor(rows[0])}
                            onChange={(e) => setSelection(e.target.value)}
                          >
                            {rows.map((item) => (
                              <option key={keyFor(item)} value={keyFor(item)}>
                                {item.id} v{item.version}
                              </option>
                            ))}
                          </Select>
                        )}
                      </Field>
                      <Field label="Model route">
                        {(props) => (
                          <Select
                            {...props}
                            value={route}
                            onChange={(e) => setRoute(e.target.value === 'byo' ? 'byo' : 'native')}
                          >
                            <option value="native">Native</option>
                            <option value="byo">BYO</option>
                          </Select>
                        )}
                      </Field>
                      <Field label="Run prompt">
                        {(props) => (
                          <Input
                            {...props}
                            required
                            maxLength={500}
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            placeholder="Draft PO for pr-001"
                          />
                        )}
                      </Field>
                    </div>
                    <div>
                      <Button type="submit" disabled={action.busy || !prompt.trim()}>
                        Start run
                      </Button>
                    </div>
                  </form>
                )}
              </>
            ) : (
              <EmptyState title="No registered bots." />
            )
          }
        </RemoteContent>
      </Card>
      {runId && <BotConsole key={runId} client={client} me={me} notify={notify} runId={runId} />}
      <Card title="Run history">
        {history.length ? (
          <ul className="bs-feature-list" aria-label="Bot run history">
            {history.map((id) => (
              <li key={id}>
                <Button
                  variant="secondary"
                  onClick={() => setRunId(id)}
                  aria-pressed={id === runId}
                >
                  {id}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No bot runs in this browser session." />
        )}
      </Card>
      {canReview(me.role) && (
        <Card title="Resume an assigned bot run">
          <form
            className="bs-stack"
            onSubmit={(event) => {
              event.preventDefault();
              const [id, approvalId, extra] = approvalLink.trim().split(/\s+/);
              if (!reviewed || !id || !approvalId || extra) {
                notify(denialMessages.invalid_input, 'danger');
                return;
              }
              void action.run(
                () => api.resumeBot(id, approvalId),
                (value) => {
                  setApprovalRun(value);
                  setApprovalLink('');
                  setReviewed(false);
                  notify('Approval submitted.');
                },
              );
            }}
          >
            <Field
              label="Run and approval IDs"
              hint="Enter the two IDs from the reviewed approval handoff."
            >
              {(props) => (
                <Input
                  {...props}
                  required
                  value={approvalLink}
                  onChange={(event) => setApprovalLink(event.target.value)}
                />
              )}
            </Field>
            <label className="bs-review-confirm">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(event) => setReviewed(event.target.checked)}
              />
              I reviewed the bound approval material.
            </label>
            <div>
              <Button type="submit" disabled={action.busy || !reviewed || !approvalLink.trim()}>
                Approve and resume assigned run
              </Button>
            </div>
            {approvalRun && (
              <p>
                {approvalRun.id} <StatusPill status={approvalRun.status} />
              </p>
            )}
          </form>
        </Card>
      )}
    </div>
  );
}

function BotConsole({
  client,
  me,
  notify,
  runId,
}: Pick<PlatformRouteContext, 'client' | 'me' | 'notify'> & { runId: string }) {
  const api = client.automation;
  const [revision, refresh] = useState(0);
  const [events, setEvents] = useState<BotEvent[]>([]);
  const [run, setRun] = useState<BotRun>();
  const [failure, setFailure] = useState('');
  const [streaming, setStreaming] = useState(true);
  const cursor = useRef(0);
  const action = useAction(notify);
  useEffect(() => {
    const controller = new AbortController();
    async function follow() {
      try {
        setFailure('');
        setStreaming(true);
        const snapshot = await api.getBotRun(runId);
        if (controller.signal.aborted) return;
        setRun(snapshot);
        // Even settled runs have a finite backlog for history views.
        for await (const event of api.streamBot(runId, cursor.current, controller.signal)) {
          if (controller.signal.aborted) return;
          cursor.current = event.id;
          setEvents((prior) => [...prior, event]);
        }
        if (controller.signal.aborted) return;
        const current = await api.getBotRun(runId);
        if (controller.signal.aborted) return;
        setRun(current);
        if (current.status === 'queued' || current.status === 'running')
          setFailure('The event stream closed. Reconnect to continue.');
      } catch (error) {
        if (!controller.signal.aborted) setFailure(errorMessage(error));
      } finally {
        if (!controller.signal.aborted) setStreaming(false);
      }
    }
    void follow();
    return () => controller.abort();
  }, [api, revision, runId]);

  const waiting = run?.status === 'pending_approval' && !streaming && !failure;
  useEffect(() => {
    if (!waiting) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function checkApproval() {
      try {
        const snapshot = await api.getBotRun(runId);
        if (!current) return;
        if (snapshot.status === 'pending_approval') {
          timer = setTimeout(checkApproval, 2500);
        } else {
          setRun(snapshot);
          refresh((index) => index + 1);
        }
      } catch (error) {
        if (current) setFailure(errorMessage(error));
      }
    }
    timer = setTimeout(checkApproval, 2500);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, runId, waiting]);

  function update(value: BotRun) {
    setRun(value);
    refresh((index) => index + 1);
  }
  const pending = run?.pending;
  return (
    <Card title="Run console">
      <div className="bs-stack">
        <div className="bs-feature-actions">
          <strong>{runId}</strong> {run && <StatusPill status={run.status} />}
          {run && active(run) && canOperate(me.role) && (
            <Button
              variant="danger"
              disabled={action.busy}
              onClick={() => void action.run(() => api.cancelBot(runId), update)}
            >
              Cancel run
            </Button>
          )}
        </div>
        {streaming && <p role="status">Reading run events…</p>}
        {failure && (
          <div>
            <p role="alert">{failure}</p>
            <Button variant="secondary" onClick={() => refresh((index) => index + 1)}>
              Reconnect
            </Button>
          </div>
        )}
        {events.length ? (
          <ol className="bs-timeline" aria-label="Bot events">
            {events.map((event) => (
              <li key={event.id}>
                <strong>{event.kind.replaceAll('_', ' ')}</strong> {event.tool ?? event.stepId}{' '}
                {event.state ?? event.status}
              </li>
            ))}
          </ol>
        ) : (
          !streaming && <EmptyState title="No run events." />
        )}
        {pending && (
          <section className="bs-stack" aria-label="Approval interrupt">
            <h3>Approval required</h3>
            <Details
              fields={[
                ['Requested action', pending.approval.tool],
                ['Assigned approver', pending.approval.approverId],
                ['Expires', pending.approval.expiresAt],
                ['Material SHA-256', pending.approval.materialHash],
              ]}
            />
            <p className="bs-muted">
              Share the bound material and these IDs with the assigned approver.
            </p>
            <CodeBlock label="Approval handoff IDs">{runId + ' ' + pending.approval.id}</CodeBlock>
            {(pending.materialPreview ?? pending.previews ?? pending.draft) != null && (
              <CodeBlock label="Bot approval material">
                {JSON.stringify(
                  pending.materialPreview ?? pending.previews ?? pending.draft,
                  null,
                  2,
                )}
              </CodeBlock>
            )}
            {canDecideApproval(me, pending.approval) && (
              <div>
                <Button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(() => api.resumeBot(runId, pending.approval.id), update)
                  }
                >
                  Approve and resume
                </Button>
              </div>
            )}
          </section>
        )}
        {run?.result && (
          <CodeBlock label="Run result">{JSON.stringify(run.result, null, 2)}</CodeBlock>
        )}
      </div>
    </Card>
  );
}
