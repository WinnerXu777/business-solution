import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  loadDemoFixtures,
  type Approval,
  type CallEnvelope,
  type MessagePreview,
  type ToolCall,
  type ToolResult,
} from '@bs/contracts';
import { FakeGateway } from '@bs/core';
import { createFakeProviders } from '../../../../packages/adapters/src/fake-providers.ts';
import { BotRejection, type BotBackend, type BotCommand } from './index.ts';

const repo = new URL('../../../../', import.meta.url);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rejected = {
  state: 'denied',
  code: 'invalid_approval',
  message: 'Invalid approval.',
} as const;
const approverId = 'actor-approver';

type Send = Extract<
  ToolCall,
  { tool: 'collections.email.send' | 'collections.sms.send' | 'collections.voice.send' }
>;

function fixtureTools() {
  const fixtures = loadDemoFixtures();
  const gateway = new FakeGateway({ fixtures });
  const providers = createFakeProviders();
  const previews = new Map<string, { preview: MessagePreview; actorId: string }>();
  const approvals = new Map<string, Approval>();
  const role = (scope: CallEnvelope) =>
    fixtures.grants.find(
      (grant) =>
        grant.tenantId === scope.tenantId &&
        grant.actor.id === scope.actor.id &&
        grant.actor.kind === scope.actor.kind,
    )?.role;

  async function send(call: Send): Promise<ToolResult> {
    const { envelope, tool, input } = call;
    const stored = previews.get(input.previewId);
    if (
      !stored ||
      stored.preview.tenantId !== envelope.tenantId ||
      stored.actorId !== envelope.actor.id ||
      role(envelope) !== 'operator' ||
      tool !== 'collections.' + stored.preview.channel + '.send'
    )
      return rejected;
    const { preview } = stored;
    const approvalId = 'niche-contact-' + hash([envelope.tenantId, envelope.actor, tool, preview]);
    if (!input.approvalId) {
      const approval: Approval = {
        id: approvalId,
        tenantId: envelope.tenantId,
        requestedBy: envelope.actor.id,
        approverId,
        tool,
        subjectId: preview.id,
        materialHash: hash(preview),
        sourceVersion: preview.sourceVersion,
        policyVersion: 'fixture-niche-contact-v1',
        expiresAt: new Date(Date.parse(fixtures.asOf) + 3_600_000).toISOString(),
        state: 'pending',
      };
      const prior = approvals.get(approvalId);
      if (prior && prior.state !== 'pending') return rejected;
      if (!prior) approvals.set(approvalId, approval);
      return { state: 'pending_approval', approval: prior ?? approval };
    }
    const approval = approvals.get(approvalId);
    if (approvalId !== input.approvalId || approval?.state !== 'approved') return rejected;
    // A new governed preview rechecks suppression, source and customer versions, and entitlement.
    const current = await gateway.call({
      tool: 'message.preview',
      envelope: { ...envelope, idempotencyKey: 'dispatch-' + envelope.idempotencyKey },
      input: { invoiceId: preview.sourceId, channel: preview.channel },
    });
    if (current.state !== 'ok') return current;
    if (
      current.output.sourceVersion !== preview.sourceVersion ||
      current.output.customerVersion !== preview.customerVersion ||
      current.output.customerId !== preview.customerId ||
      current.output.recipient !== preview.recipient
    )
      return rejected;
    approval.state = 'consumed';
    const receipt = await providers.messages[preview.channel].send(
      preview,
      envelope.idempotencyKey,
    );
    return 'state' in receipt ? receipt : { state: 'ok', output: receipt };
  }

  return {
    async call(call: ToolCall, template: string | null): Promise<ToolResult> {
      switch (call.tool) {
        case 'message.preview': {
          const result = await gateway.call(call);
          if (result.state !== 'ok' || !template) return result;
          // Give each run an exact material preview. Shared v1 previews are keyed by source version.
          const preview = {
            ...result.output,
            id: 'niche-preview-' + hash([call.envelope.idempotencyKey, result.output.id, template]),
            body: result.output.channel === 'sms' ? template + ' Reply STOP to opt out.' : template,
          };
          previews.set(preview.id, { preview, actorId: call.envelope.actor.id });
          return { state: 'ok', output: preview };
        }
        case 'collections.email.send':
        case 'collections.voice.send':
        case 'collections.sms.send':
          return send(call);
        default:
          return gateway.call(call);
      }
    },
    sign(scope: CallEnvelope, id: string) {
      const approval = approvals.get(id);
      if (
        !approval ||
        approval.state !== 'pending' ||
        approval.tenantId !== scope.tenantId ||
        approval.approverId !== scope.actor.id ||
        approval.requestedBy === scope.actor.id ||
        scope.actor.kind !== 'person' ||
        role(scope) !== 'approver' ||
        Date.parse(approval.expiresAt) <= Date.parse(fixtures.asOf)
      )
        return false;
      approval.state = 'approved';
      return true;
    },
  };
}

type Message =
  | { reply: unknown }
  | { error: BotRejection['code'] }
  | { toolCall: ToolCall; template: string | null }
  | { sign: { scope: CallEnvelope; id: string } };

/** Local subprocess relay for fictional data and fake adapters. No sockets or provider credentials. */
export function createFixtureBotsBackend(python?: string): BotBackend {
  const interpreter = fileURLToPath(
    new URL(process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python', repo),
  );
  const tools = fixtureTools();
  let processSession: ReturnType<typeof start> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;

  function start() {
    const child = spawn(
      python ?? (existsSync(interpreter) ? interpreter : 'python'),
      ['-m', 'workers.bs_worker.bots'],
      { cwd: repo, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
    );
    const lines = createInterface({ input: child.stdout });
    const stop = () => {
      lines.close();
      child.kill();
    };
    child.on('error', stop);
    child.stdin.on('error', stop);
    return { child, reader: lines[Symbol.asyncIterator](), stop };
  }

  async function invoke(input: BotCommand): Promise<unknown> {
    if (closed) throw new BotRejection('unavailable');
    const { child, reader, stop } = (processSession ??= start());
    const timeout = setTimeout(stop, 15_000);
    const write = (response: unknown) => child.stdin.write(JSON.stringify(response) + '\n');
    try {
      write(input);
      for (;;) {
        const line = await reader.next();
        if (line.done) throw new BotRejection('unavailable');
        const response = JSON.parse(line.value) as Message;
        if ('reply' in response) return response.reply;
        if ('error' in response) throw new BotRejection(response.error);
        if ('toolCall' in response) write(await tools.call(response.toolCall, response.template));
        if ('sign' in response)
          write({ signed: tools.sign(response.sign.scope, response.sign.id) });
      }
    } catch (error) {
      if (!(error instanceof BotRejection) || error.code === 'unavailable') {
        closed = true;
        stop();
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    invoke(input) {
      const work = queue.then(() => invoke(input));
      queue = work.catch(() => undefined);
      return work;
    },
    close() {
      closed = true;
      processSession?.stop();
    },
  };
}
