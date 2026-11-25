import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatRequest, LlmKey, LlmModel, TokenUsage } from '../clients/llm.ts';
import {
  Button,
  Card,
  CodeBlock,
  Dialog,
  EmptyState,
  Field,
  Input,
  Select,
  Table,
  Textarea,
} from '../components.tsx';
import { errorMessage, RemoteContent, useAction, useResource } from '../data.tsx';
import { canOperate } from '../platform-client.ts';
import { ConfirmChange } from './access.tsx';
import { Details } from './feature-helpers.tsx';
import type { ScreenProps } from './screen-helpers.tsx';

const toolSchema = JSON.stringify(
  {
    type: 'object',
    properties: { order_id: { type: 'string' } },
    required: ['order_id'],
    additionalProperties: false,
  },
  null,
  2,
);
const responseSchema = JSON.stringify(
  {
    type: 'object',
    properties: { status: { type: 'string' } },
    required: ['status'],
    additionalProperties: false,
  },
  null,
  2,
);

type Mode = 'text' | 'tool' | 'schema';

export function LlmPlayground(props: ScreenProps) {
  const { client } = props;
  const resource = useResource(useCallback(() => client.llm.models(), [client]));
  return (
    <RemoteContent resource={resource} label="LLM models">
      {(models) =>
        models.length ? (
          <PlaygroundForm {...props} models={models} />
        ) : (
          <EmptyState title="No LLM models are available." />
        )
      }
    </RemoteContent>
  );
}

function PlaygroundForm({ models, client, me, notify }: ScreenProps & { models: LlmModel[] }) {
  const [model, setModel] = useState(models[0].id);
  const [mode, setMode] = useState<Mode>('text');
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('lookup_order');
  const [schema, setSchema] = useState(toolSchema);
  const [schemaError, setSchemaError] = useState('');
  const [streamState, setStreamState] = useState<
    'idle' | 'streaming' | 'stopped' | 'complete' | 'error'
  >('idle');
  const [reply, setReply] = useState('');
  const [tools, setTools] = useState<{ index: number; id?: string; name: string; args: string }[]>(
    [],
  );
  const [usage, setUsage] = useState<TokenUsage>();
  const [route, setRoute] = useState<string>();
  const [binding, setBinding] = useState<number>();
  const cancel = useRef<AbortController>(null);
  useEffect(() => () => cancel.current?.abort(), []);
  const ready = canOperate(me.role) && streamState !== 'streaming';

  async function submit() {
    if (!ready || cancel.current || !prompt.trim()) return;
    const body: ChatRequest = { model, messages: [{ role: 'user', content: prompt.trim() }] };
    if (mode !== 'text') {
      try {
        const parsed: unknown = JSON.parse(schema);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
          throw new Error();
        if (mode === 'tool')
          body.tools = [{ type: 'function', function: { name, parameters: parsed } }];
        else
          body.response_format = {
            type: 'json_schema',
            json_schema: { name, schema: parsed, strict: true },
          };
      } catch {
        setSchemaError('Enter a JSON object for the schema.');
        return;
      }
    }
    setSchemaError('');
    setReply('');
    setTools([]);
    setRoute(undefined);
    setBinding(undefined);
    setUsage(undefined);
    setStreamState('streaming');
    const controller = new AbortController();
    cancel.current = controller;
    try {
      for await (const chunk of client.llm.chat(body, controller.signal)) {
        if (controller.signal.aborted) return;
        if (chunk.provider_route) setRoute(chunk.provider_route);
        if (chunk.binding_version !== undefined) setBinding(chunk.binding_version);
        if (chunk.usage) setUsage(chunk.usage);
        const delta = chunk.choices.find((choice) => choice.index === 0)?.delta;
        if (delta?.content) setReply((text) => text + delta.content);
        if (delta?.tool_calls)
          setTools((previous) => {
            const calls = [...previous];
            for (const part of delta.tool_calls ?? []) {
              const position = calls.findIndex((call) => call.index === part.index);
              const current = calls[position];
              const next = {
                index: part.index,
                id: part.id ?? current?.id,
                name: (current?.name ?? '') + (part.function?.name ?? ''),
                args: (current?.args ?? '') + (part.function?.arguments ?? ''),
              };
              if (position === -1) calls.push(next);
              else calls[position] = next;
            }
            return calls;
          });
      }
      if (!controller.signal.aborted) setStreamState('complete');
    } catch (error) {
      if (!controller.signal.aborted) {
        setStreamState('error');
        notify(errorMessage(error), 'danger');
      }
    } finally {
      if (cancel.current === controller) cancel.current = null;
    }
  }

  return (
    <div className="bs-live-grid">
      <Card title="Completion request">
        <form
          className="bs-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field label="Model">
            {(attrs) => (
              <Select
                {...attrs}
                value={model}
                disabled={!ready}
                onChange={(event) => setModel(event.target.value)}
              >
                {models.map(({ id }) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Response mode">
            {(attrs) => (
              <Select
                {...attrs}
                value={mode}
                disabled={!ready}
                onChange={(event) => {
                  const value = event.target.value as Mode;
                  setMode(value);
                  setName(value === 'schema' ? 'order_status' : 'lookup_order');
                  setSchema(value === 'schema' ? responseSchema : toolSchema);
                  setSchemaError('');
                }}
              >
                <option value="text">Chat</option>
                <option value="tool">Tool call</option>
                <option value="schema">JSON schema</option>
              </Select>
            )}
          </Field>
          <Field label="Prompt">
            {(attrs) => (
              <Textarea
                {...attrs}
                required
                rows={4}
                maxLength={16000}
                disabled={!ready}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            )}
          </Field>
          {mode !== 'text' && (
            <>
              <Field label={mode === 'tool' ? 'Tool name' : 'Schema name'}>
                {(attrs) => (
                  <Input
                    {...attrs}
                    required
                    value={name}
                    disabled={!ready}
                    pattern="[A-Za-z0-9_\-]{1,64}"
                    onChange={(event) => setName(event.target.value)}
                  />
                )}
              </Field>
              <Field
                label={mode === 'tool' ? 'Tool parameters' : 'Response schema'}
                error={schemaError || undefined}
              >
                {(attrs) => (
                  <Textarea
                    {...attrs}
                    required
                    rows={8}
                    value={schema}
                    maxLength={16000}
                    disabled={!ready}
                    onChange={(event) => {
                      setSchema(event.target.value);
                      setSchemaError('');
                    }}
                  />
                )}
              </Field>
            </>
          )}
          {!canOperate(me.role) && <p>Operator access is required to run completions.</p>}
          <div className="bs-actions">
            <Button type="submit" disabled={!ready || !prompt.trim()}>
              Run completion
            </Button>
            {streamState === 'streaming' && (
              <Button
                variant="secondary"
                onClick={() => {
                  cancel.current?.abort();
                  cancel.current = null;
                  setStreamState('stopped');
                }}
              >
                Stop generation
              </Button>
            )}
          </div>
        </form>
      </Card>
      <Card title="Completion response">
        <div className="bs-stack">
          <p role="status">
            {
              {
                idle: 'Submit a prompt to see a response.',
                streaming: 'Streaming response…',
                stopped: 'Generation stopped.',
                complete:
                  reply || tools.length ? 'Response complete.' : 'The model returned no content.',
                error: 'The stream ended with an error.',
              }[streamState]
            }
          </p>
          {reply && <CodeBlock label="Model response">{reply}</CodeBlock>}
          {tools.map((tool) => (
            <section key={tool.index}>
              <h3>{tool.name || 'Tool call'}</h3>
              <CodeBlock label={'Tool arguments ' + (tool.index + 1)}>{tool.args}</CodeBlock>
            </section>
          ))}
          {streamState !== 'idle' && (
            <Details
              fields={[
                ['Provider route', route ?? 'Unavailable'],
                ['Binding version', binding ?? 'Unavailable'],
                ['Prompt tokens', usage?.prompt_tokens ?? 'Unavailable'],
                ['Completion tokens', usage?.completion_tokens ?? 'Unavailable'],
                ['Total tokens', usage?.total_tokens ?? 'Unavailable'],
              ]}
            />
          )}
        </div>
      </Card>
    </div>
  );
}

export function LlmKeys(props: ScreenProps) {
  if (props.me.role !== 'admin') return null;
  return <KeysAdmin {...props} />;
}

function KeysAdmin(props: ScreenProps) {
  const { client, notify } = props;
  const resource = useResource(useCallback(() => client.llm.listKeys(), [client]));
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<LlmKey>();
  return (
    <Card
      title="LLM API keys"
      action={<Button onClick={() => setCreating(true)}>New LLM API key</Button>}
    >
      <RemoteContent resource={resource} label="LLM API keys">
        {(keys) => (
          <Table
            rows={keys}
            rowKey={(key) => key.id}
            label="LLM API keys"
            empty="No LLM API keys have been created."
            columns={[
              { key: 'name', title: 'Name', render: (row) => row.name },
              { key: 'prefix', title: 'Key prefix', render: (row) => row.prefix },
              {
                key: 'createdAt',
                title: 'Created',
                render: (row) => new Date(row.createdAt).toLocaleDateString(),
              },
              {
                key: 'action',
                title: 'Manage',
                render: (row) => (
                  <Button
                    variant="secondary"
                    aria-label={'Revoke LLM key ' + row.name}
                    onClick={() => setRevoking(row)}
                  >
                    Revoke
                  </Button>
                ),
              },
            ]}
          />
        )}
      </RemoteContent>
      {creating && <KeyForm {...props} reload={resource.reload} close={() => setCreating(false)} />}
      {revoking && (
        <ConfirmChange
          {...props}
          title="Revoke LLM key"
          text={revoking.name + ' will lose access to the LLM API.'}
          danger
          actionLabel="Confirm key revocation"
          close={() => setRevoking(undefined)}
          action={() => client.llm.revokeKey(revoking.id)}
          done={() => {
            setRevoking(undefined);
            resource.reload();
            notify('LLM key revoked.');
          }}
        />
      )}
    </Card>
  );
}

function KeyForm({
  reload,
  close,
  ...props
}: ScreenProps & { reload: () => void; close: () => void }) {
  const [name, setName] = useState('');
  const [secret, setSecret] = useState<string>();
  const { busy, run } = useAction(props.notify);
  return (
    <Dialog
      title={secret ? 'LLM API key secret' : 'Create LLM API key'}
      onClose={close}
      busy={busy}
    >
      {secret ? (
        <div className="bs-stack">
          <p>Copy this key now. It is shown only once.</p>
          <CodeBlock label="LLM API key">{secret}</CodeBlock>
          <Button onClick={close}>Done</Button>
        </div>
      ) : (
        <form
          className="bs-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim())
              void run(
                () => props.client.llm.createKey(name.trim()),
                ({ secret }) => {
                  setSecret(secret);
                  reload();
                },
              );
          }}
        >
          <Field label="Key name">
            {(attrs) => (
              <Input
                {...attrs}
                value={name}
                required
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <div className="bs-actions">
            <Button variant="secondary" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              Create LLM key
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
