import { useCallback, useEffect, useRef, useState } from 'react';
import type { BotRun } from '../clients/automation.ts';
import type { Conversation, ConversationDetail, TranscriptLine } from '../clients/conversations.ts';
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  EmptyState,
  Field,
  Select,
  StatusPill,
  Table,
  Textarea,
} from '../components.tsx';
import { errorMessage, RemoteContent, useAction, useResource } from '../data.tsx';
import { canOperate, canReview, PlatformError } from '../platform-client.ts';
import { useRequestKey } from './feature-helpers.tsx';
import type { ScreenProps } from './screen-helpers.tsx';
import { VoicePanel } from './voice.tsx';

export function ConversationsScreen(props: ScreenProps) {
  const { client } = props;
  const inbox = useResource(useCallback(() => client.conversations.list(), [client]));
  const [filter, setFilter] = useState<'all' | Conversation['channel']>('all');
  const [selected, setSelected] = useState<string>();
  const detail = useResource(
    useCallback(
      () => (selected ? client.conversations.get(selected) : Promise.resolve(null)),
      [client, selected],
    ),
  );
  return (
    <div className="bs-stack">
      <Card
        title="Chat and voice inbox"
        action={
          <Button variant="secondary" onClick={inbox.reload}>
            Refresh inbox
          </Button>
        }
      >
        <Field label="Channel filter">
          {(attrs) => (
            <Select
              {...attrs}
              value={filter}
              onChange={(event) => setFilter(event.target.value as typeof filter)}
            >
              <option value="all">All channels</option>
              <option value="chat">Chat</option>
              <option value="voice">Voice</option>
            </Select>
          )}
        </Field>
        <RemoteContent resource={inbox} label="conversation inbox">
          {(sessions) => (
            <Table
              label="Conversations"
              rows={sessions.filter((session) => filter === 'all' || session.channel === filter)}
              rowKey={(row) => row.id}
              empty="No conversations match this view."
              columns={[
                {
                  key: 'customer',
                  title: 'Customer',
                  render: (row) => (
                    <Button
                      aria-pressed={selected === row.id}
                      variant="quiet"
                      onClick={() => setSelected(row.id)}
                    >
                      {row.customer}
                    </Button>
                  ),
                },
                { key: 'channel', title: 'Channel', render: (row) => row.channel },
                {
                  key: 'status',
                  title: 'Status',
                  render: (row) => <StatusPill status={row.status} />,
                },
                {
                  key: 'assigned',
                  title: 'Assigned staff',
                  render: (row) => row.assignedTo ?? 'Unassigned',
                },
                { key: 'handoff', title: 'Handoff', render: (row) => <Badge>{row.handoff}</Badge> },
              ]}
            />
          )}
        </RemoteContent>
      </Card>
      <RemoteContent resource={detail} label="conversation transcript">
        {(record) =>
          record ? (
            <ConversationPanel
              key={record.session.id}
              {...props}
              record={record}
              refreshInbox={inbox.reload}
            />
          ) : (
            <EmptyState title="Select a chat or voice conversation." />
          )
        }
      </RemoteContent>
    </div>
  );
}

const activeRun = (run: BotRun) => ['queued', 'running', 'pending_approval'].includes(run.status);

function ConversationPanel({
  record,
  client,
  me,
  notify,
  refreshInbox,
}: ScreenProps & {
  record: ConversationDetail;
  refreshInbox: () => void;
}) {
  const [session, setSession] = useState(record.session);
  const [transcript, setTranscript] = useState(record.transcript);
  const [prompt, setPrompt] = useState('');
  const [runId, setRunId] = useState(record.activeRunId);
  const [view, setView] = useState<BotRun>();
  const [answer, setAnswer] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const connection = useRef<AbortController>(null);
  const cursor = useRef(0);
  const focus = useRef<HTMLHeadingElement>(null);
  const action = useAction(notify);
  const attempt = useRequestKey();
  const human = session.handoff === 'human';
  const owned = session.assignedTo === me.actor.id;
  const open = session.status !== 'closed';
  const canWork = open && canOperate(me.role);
  const canSend = canWork && (human ? owned : session.handoff === 'bot');
  const pending = view?.pending;
  const eligibleApprover =
    pending &&
    canReview(me.role) &&
    pending.approval.approverId === me.actor.id &&
    pending.approval.requestedBy !== me.actor.id &&
    pending.approval.tenantId === me.tenant.id;

  const append = useCallback(
    (line: TranscriptLine) =>
      setTranscript((lines) => (lines.some(({ id }) => id === line.id) ? lines : [...lines, line])),
    [],
  );

  const watch = useCallback(
    async (id: string) => {
      connection.current?.abort();
      const controller = new AbortController();
      connection.current = controller;
      const { signal } = controller;
      setStreaming(true);
      setInterrupted(false);
      try {
        for await (const event of client.automation.streamBot(id, cursor.current, signal)) {
          if (signal.aborted) return;
          cursor.current = event.id;
          if (event.kind === 'reply_delta' && event.delta)
            setAnswer((current) => current + event.delta);
        }
        if (signal.aborted) return;
        const run = await client.automation.getBotRun(id);
        if (signal.aborted) return;
        setView(run);
        if (run.status === 'queued' || run.status === 'running') {
          setInterrupted(true);
          return;
        }
        if (run.status !== 'pending_approval') {
          const output = run.result?.state === 'ok' ? run.result.output : undefined;
          if (
            output &&
            typeof output === 'object' &&
            'reply' in output &&
            typeof output.reply === 'string'
          ) {
            append({ id: id + ':bot', speaker: 'bot', text: output.reply });
            setAnswer('');
          }
          if (run.status === 'denied' || run.status === 'failed' || run.status === 'unknown') {
            const code = run.result && 'code' in run.result ? run.result.code : 'provider_error';
            notify(errorMessage(new PlatformError(code)), 'danger');
          }
        }
      } catch (error) {
        if (!signal.aborted) {
          setInterrupted(true);
          notify(errorMessage(error), 'danger');
        }
      } finally {
        if (connection.current === controller && !signal.aborted) setStreaming(false);
      }
    },
    [append, client, notify],
  );

  useEffect(() => {
    focus.current?.focus();
    if (record.activeRunId) void watch(record.activeRunId);
    return () => connection.current?.abort();
  }, [record.activeRunId, watch]);

  useEffect(() => {
    if (!runId || view?.status !== 'pending_approval' || streaming) return;
    let active = true;
    let timer: number;
    async function check(id: string) {
      try {
        const run = await client.automation.getBotRun(id);
        if (!active) return;
        if (run.status !== 'pending_approval') {
          void watch(id);
          return;
        }
      } catch {
        // Keep the inline review visible during a transient status read failure.
      }
      if (active) timer = window.setTimeout(() => void check(id), 2500);
    }
    timer = window.setTimeout(() => void check(runId), 2500);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [client, runId, view?.status, streaming, watch]);

  const busy = action.busy || streaming;
  return (
    <Card title={session.customer}>
      <div className="bs-stack">
        <h3 ref={focus} tabIndex={-1}>
          Conversation transcript
        </h3>
        <div className="bs-actions">
          <StatusPill status={session.status} />
          <Badge>
            {human
              ? 'Human controlled'
              : session.handoff === 'requested'
                ? 'Handoff requested'
                : 'Bot controlled'}
          </Badge>
          {canWork && (!human || owned || me.role === 'admin') && (
            <Button
              disabled={action.busy}
              variant="secondary"
              onClick={() => {
                void action.run(
                  () => client.conversations.handoff(session.id, human ? 'handback' : 'takeover'),
                  (updated) => {
                    connection.current?.abort();
                    setStreaming(false);
                    setInterrupted(false);
                    setAnswer('');
                    setRunId(undefined);
                    setView(undefined);
                    setSession(updated);
                    refreshInbox();
                    notify(
                      human
                        ? 'Conversation handed back to the bot.'
                        : 'You have taken over the conversation.',
                    );
                  },
                );
              }}
            >
              {human ? 'Hand back to bot' : 'Take over'}
            </Button>
          )}
        </div>
        <Transcript lines={transcript} />
        {session.channel === 'voice' && canSend && !human && (
          <VoicePanel
            client={client.conversations}
            id={session.id}
            append={append}
            notify={notify}
          />
        )}
        {answer && (
          <p className="bs-transcript-delta">
            <strong>Bot</strong> {answer}
          </p>
        )}
        {streaming && <p role="status">Streaming bot reply…</p>}
        {interrupted && runId && (
          <Button variant="secondary" onClick={() => void watch(runId)}>
            Reconnect bot stream
          </Button>
        )}
        {view && <StatusPill status={view.status} />}
        {pending && runId && (
          <section className="bs-stack bs-approval-interrupt" aria-label="Bot approval required">
            <h3>Approval required</h3>
            <p>
              {pending.approval.tool} for {pending.approval.subjectId}
            </p>
            <p>Assigned approver {pending.approval.approverId}</p>
            <CodeBlock label="Approval handoff IDs">{runId + ' ' + pending.approval.id}</CodeBlock>
            {pending.materialPreview !== undefined && (
              <CodeBlock label="Approval review material">
                {JSON.stringify(pending.materialPreview, null, 2)}
              </CodeBlock>
            )}
            {pending.draft && (
              <CodeBlock label="Purchase order draft">
                {JSON.stringify(pending.draft, null, 2)}
              </CodeBlock>
            )}
            {pending.previews?.length ? (
              <CodeBlock label="Message previews">
                {JSON.stringify(pending.previews, null, 2)}
              </CodeBlock>
            ) : null}
            <div className="bs-actions">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void action.run(
                    () => client.automation.getBotRun(runId),
                    (run) => {
                      if (run.status !== 'pending_approval') void watch(runId);
                      else setView(run);
                    },
                  )
                }
              >
                Check approval status
              </Button>
              {eligibleApprover && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void action.run(
                      () => client.automation.resumeBot(runId, pending.approval.id),
                      () => void watch(runId),
                    )
                  }
                >
                  Approve and resume
                </Button>
              )}
            </div>
          </section>
        )}
        {canSend && (session.channel === 'chat' || human) && (
          <form
            className="bs-form"
            onSubmit={(event) => {
              event.preventDefault();
              const text = prompt.trim();
              if (!text || busy || interrupted || (view && activeRun(view))) return;
              if (human)
                void action.run(
                  () =>
                    client.conversations.sendStaffMessage(
                      session.id,
                      text,
                      attempt.key({ text, mode: 'staff' }),
                    ),
                  (line) => {
                    append(line);
                    setPrompt('');
                    attempt.clear();
                  },
                );
              else {
                const input = { ...session.bot, sessionId: session.id, prompt: text };
                void action.run(
                  () => client.automation.startBot(input, attempt.key(input)),
                  (run) => {
                    attempt.clear();
                    append({ id: run.id + ':customer', speaker: 'customer', text });
                    setPrompt('');
                    setRunId(run.id);
                    cursor.current = 0;
                    setAnswer('');
                    setView(run);
                    void watch(run.id);
                  },
                );
              }
            }}
          >
            <Field label={human ? 'Staff reply' : 'Customer message'}>
              {(attrs) => (
                <Textarea
                  {...attrs}
                  value={prompt}
                  rows={3}
                  required
                  maxLength={500}
                  disabled={busy || interrupted || Boolean(view && activeRun(view))}
                  onChange={(event) => setPrompt(event.target.value)}
                />
              )}
            </Field>
            <Button
              type="submit"
              disabled={!prompt.trim() || busy || interrupted || Boolean(view && activeRun(view))}
            >
              {human ? 'Send staff reply' : 'Send to bot'}
            </Button>
          </form>
        )}
      </div>
    </Card>
  );
}

function Transcript({ lines }: { lines: TranscriptLine[] }) {
  if (!lines.length) return <EmptyState title="There is no transcript yet." />;
  return (
    <ol
      className="bs-transcript"
      aria-label="Conversation messages"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {lines.map(({ id, speaker, text }) => (
        <li key={id}>
          <strong>{speaker}</strong>
          <p>{text}</p>
        </li>
      ))}
    </ol>
  );
}
