import { useEffect, useState, type FormEvent } from 'react';
import type { MessageChannel, MessagePreview, Order } from '@bs/contracts';
import { useAutomation, type ApprovalItem, type RouteKind, type WorkflowRun } from './api.ts';
import { MessageCard, Notice, Panel, useTask } from './panels.tsx';
import { channels, money, resultText } from './presentation.ts';
import { playSpeechLoop } from './speech.ts';
import { Workflow } from './workflow.tsx';

const views = [
  { id: 'desk', label: 'Service desk', icon: '▤' },
  { id: 'drafts', label: 'Drafts & previews', icon: '▱' },
  { id: 'inbox', label: 'Approval inbox', icon: '☑' },
  { id: 'workflows', label: 'Workflows', icon: '◇' },
] as const;

function OrderSummary({ order }: { order: Order }) {
  return (
    <dl className="facts">
      <div>
        <dt>Order</dt>
        <dd>{order.id}</dd>
      </div>
      <div>
        <dt>Status</dt>
        <dd className="capitalize">{order.status}</dd>
      </div>
      <div>
        <dt>Customer</dt>
        <dd>{order.customerId}</dd>
      </div>
      <div>
        <dt>Placed</dt>
        <dd>{order.placedOn}</dd>
      </div>
      <div>
        <dt>Total</dt>
        <dd>{money(order.totalCents)} CAD</dd>
      </div>
    </dl>
  );
}

function Lookup() {
  const api = useAutomation();
  const [id, setId] = useState('ord-001');
  const [order, setOrder] = useState<Order | null>(null);
  const task = useTask();
  return (
    <Panel title="Order lookup">
      <form
        className="form-row"
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(async () => {
            setOrder(null);
            const result = await api.order(id.trim());
            if (result.state === 'ok') setOrder(result.output);
            else task.setNotice(resultText(result));
          });
        }}
      >
        <label>
          Order ID
          <input value={id} onChange={(event) => setId(event.target.value)} required />
        </label>
        <button disabled={task.busy}>Look up</button>
      </form>
      <Notice>{task.notice}</Notice>
      {order && <OrderSummary order={order} />}
    </Panel>
  );
}

export function Chat({ route, onChange }: { route: RouteKind; onChange: () => void }) {
  const api = useAutomation();
  const [session] = useState(() => crypto.randomUUID());
  const [prompt, setPrompt] = useState('');
  const [turns, setTurns] = useState<{ prompt: string; response: string; order: Order | null }[]>(
    [],
  );
  const task = useTask();

  function send(event: FormEvent) {
    event.preventDefault();
    const message = prompt.trim();
    if (!message) return;
    void task.run(async () => {
      const result = await api.chat(session, message, route);
      const order = result.state === 'ok' ? result.output.order : null;
      setTurns((previous) => [
        ...previous,
        { prompt: message, response: resultText(result), order },
      ]);
      setPrompt('');
      onChange();
    });
  }

  return (
    <Panel title="Chat">
      <div className="conversation" aria-live="polite">
        {turns.length === 0 && (
          <p className="quiet">Ask about ord-001, or request a draft for pr-001 or inv-001.</p>
        )}
        {turns.map((turn, index) => (
          <div className="turn" key={index}>
            <p className="prompt">{turn.prompt}</p>
            <p>{turn.response}</p>
            {turn.order && <OrderSummary order={turn.order} />}
          </div>
        ))}
      </div>
      <form className="form-row" onSubmit={send}>
        <label className="grow">
          Message
          <input
            value={prompt}
            maxLength={500}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Can you check order ord-001?"
            required
          />
        </label>
        <button disabled={task.busy || !prompt.trim()}>Send</button>
      </form>
      <Notice>{task.notice}</Notice>
    </Panel>
  );
}

export function BrowserVoice({ route }: { route: RouteKind }) {
  const api = useAutomation();
  const [session] = useState(() => crypto.randomUUID());
  const [transcript, setTranscript] = useState('');
  const [reply, setReply] = useState('');
  const [order, setOrder] = useState<Order | null>(null);
  const task = useTask();
  useEffect(() => {
    window.speechSynthesis?.getVoices();
    return () => window.speechSynthesis?.cancel();
  }, []);

  async function play(input: string, output: string) {
    const played = await playSpeechLoop(input, output, task.setNotice);
    task.setNotice(
      played
        ? 'Playback complete.'
        : 'Local speech is unavailable. Read the transcript and reply below.',
    );
  }

  return (
    <Panel title="Browser voice" aside={<span className="pill">Simulated STT / TTS</span>}>
      <p className="quiet">Run audio-order-001 through the same order tools as chat.</p>
      <div className="actions">
        <button
          disabled={task.busy}
          onClick={() =>
            void task.run(async () => {
              setTranscript('');
              setReply('');
              setOrder(null);
              const response = await api.voice(session, route);
              const message = resultText(response.result);
              setTranscript(response.transcript ?? '');
              setReply(message);
              if (response.result.state === 'ok') setOrder(response.result.output.order);
              if (response.transcript) await play(response.transcript, message);
            })
          }
        >
          Play order fixture
        </button>
        {transcript && (
          <button
            className="secondary"
            disabled={task.busy}
            onClick={() => void task.run(() => play(transcript, reply))}
          >
            Replay audio
          </button>
        )}
      </div>
      <Notice>{task.notice}</Notice>
      {transcript && (
        <dl className="transcript">
          <dt>Simulated transcript</dt>
          <dd>{transcript}</dd>
          <dt>Reply</dt>
          <dd>{reply}</dd>
        </dl>
      )}
      {order && <OrderSummary order={order} />}
    </Panel>
  );
}

function Drafts({ onChange }: { onChange: () => void }) {
  const api = useAutomation();
  const [pr, setPr] = useState('pr-001');
  const [invoice, setInvoice] = useState('inv-001');
  const [selected, setSelected] = useState<MessageChannel>('email');
  const [preview, setPreview] = useState<MessagePreview | null>(null);
  const po = useTask();
  const message = useTask();
  return (
    <div className="grid">
      <Panel title="Purchase order draft">
        <form
          className="form-row"
          onSubmit={(event) => {
            event.preventDefault();
            void po.run(async () => {
              po.setNotice(resultText(await api.draftPo(pr.trim())));
              onChange();
            });
          }}
        >
          <label>
            Purchase request
            <input value={pr} onChange={(event) => setPr(event.target.value)} required />
          </label>
          <button disabled={po.busy}>Draft PO</button>
        </form>
        <Notice>{po.notice}</Notice>
      </Panel>
      <Panel title="Collections message">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void message.run(async () => {
              setPreview(null);
              const result = await api.preview(invoice.trim(), selected);
              if (result.state === 'ok' && 'recipient' in result.output) setPreview(result.output);
              else message.setNotice(resultText(result));
            });
          }}
        >
          <div className="form-row">
            <label>
              Invoice ID
              <input
                disabled={message.busy}
                value={invoice}
                onChange={(event) => {
                  setInvoice(event.target.value);
                  setPreview(null);
                }}
                required
              />
            </label>
            <label>
              Channel
              <select
                disabled={message.busy}
                value={selected}
                onChange={(event) => {
                  setSelected(event.target.value as MessageChannel);
                  setPreview(null);
                }}
              >
                {channels.map(({ id, name }) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <button disabled={message.busy}>Preview</button>
          </div>
        </form>
        {preview && (
          <>
            <MessageCard preview={preview} />
            <button
              className="secondary"
              disabled={message.busy}
              onClick={() =>
                void message.run(async () => {
                  message.setNotice(
                    resultText(await api.requestMessage(preview.sourceId, preview.channel)),
                  );
                  onChange();
                })
              }
            >
              Request approval
            </button>
          </>
        )}
        <Notice>{message.notice}</Notice>
      </Panel>
    </div>
  );
}

function Inbox({ items, onChange }: { items: ApprovalItem[]; onChange: () => void }) {
  const api = useAutomation();
  const task = useTask();
  return (
    <Panel title="Approval inbox" aside={<span className="pill">actor-approver</span>}>
      {items.length === 0 && (
        <p className="quiet">Draft a purchase order, message, or workflow run to start a review.</p>
      )}
      <div className="inbox">
        {items.map(({ approval, draft, previews, result }) => (
          <article className="inbox-item" key={approval.id}>
            <div className="record-heading">
              <h3>
                {draft
                  ? 'Purchase order · ' + draft.requestId
                  : approval.tool === 'workflow.template.run'
                    ? 'Win-back workflow'
                    : 'Collections message'}
              </h3>
              <span className="pill">{result ? result.state : 'Pending'}</span>
            </div>
            <p className="quiet">
              Requested by {approval.requestedBy} · Source version {approval.sourceVersion}
            </p>
            {draft && (
              <div className="draft-detail">
                <p>
                  Vendor {draft.vendorId} · Cost centre {draft.costCentre}
                </p>
                <ul>
                  {draft.lines.map((line, index) => (
                    <li key={index}>
                      {line.quantity} × {line.skuId} at {money(line.unitCostCents)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {previews?.map((preview) => (
              <MessageCard key={preview.id} preview={preview} />
            ))}
            {result ? (
              <p>{resultText(result)}</p>
            ) : (
              <button
                disabled={task.busy}
                onClick={() =>
                  void task.run(async () => {
                    task.setNotice(resultText(await api.approve(approval.id)));
                    onChange();
                  })
                }
              >
                Approve
              </button>
            )}
          </article>
        ))}
      </div>
      <Notice>{task.notice}</Notice>
    </Panel>
  );
}

export function Portal({ role }: { role: string }) {
  const api = useAutomation();
  const [view, setView] = useState<(typeof views)[number]['id']>('desk');
  const [route, setRoute] = useState<RouteKind>('native');
  const [inbox, setInbox] = useState<ApprovalItem[]>([]);
  const [history, setHistory] = useState<WorkflowRun[]>([]);
  const [revision, setRevision] = useState(0);
  const [syncError, setSyncError] = useState('');
  const refresh = () => setRevision((value) => value + 1);
  useEffect(() => {
    let current = true;
    void Promise.all([role === 'approver' ? api.approvals() : Promise.resolve([]), api.history()])
      .then(([approvals, runs]) => {
        if (!current) return;
        setInbox(approvals);
        setHistory(runs);
        setSyncError('');
      })
      .catch(() => {
        if (current) setSyncError('Approval and workflow records are unavailable.');
      });
    return () => {
      current = false;
    };
  }, [api, revision, role]);
  const pending = inbox.filter((item) => !item.result).length;
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="mark" aria-hidden="true">
            R
          </div>
          <div>
            <strong>Rivetquay</strong>
            <span>Industrial Supply</span>
          </div>
        </div>
        <nav aria-label="Portal">
          {views.map(({ id, label, icon }) => (
            <button
              key={id}
              aria-current={view === id ? 'page' : undefined}
              onClick={() => setView(id)}
            >
              <span aria-hidden="true">{icon}</span>
              {label}
              {id === 'inbox' && pending > 0 && <small>{pending}</small>}
            </button>
          ))}
        </nav>
        <p className="workspace">
          <span className="dot" /> Fixture workspace
        </p>
      </aside>
      <section className="legacy-content">
        <header className="page-header">
          <div>
            <p className="quiet">Rivetquay Industrial Supply</p>
            <h1>{views.find(({ id }) => id === view)?.label}</h1>
          </div>
          {view === 'desk' && (
            <label className="route">
              LLM route
              <select value={route} onChange={(event) => setRoute(event.target.value as RouteKind)}>
                <option value="native">fixture-native</option>
                <option value="byo">fixture-byo</option>
              </select>
            </label>
          )}
        </header>
        {syncError && <Notice>{syncError}</Notice>}
        <div hidden={view !== 'desk'} className="grid">
          <div className="stack">
            <Lookup />
            <BrowserVoice route={route} />
          </div>
          <Chat route={route} onChange={refresh} />
        </div>
        {view === 'drafts' && <Drafts onChange={refresh} />}
        {view === 'inbox' && <Inbox items={inbox} onChange={refresh} />}
        {view === 'workflows' && <Workflow history={history} onChange={refresh} />}
      </section>
    </div>
  );
}
