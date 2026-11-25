import { canOperate, PlatformError } from '../platform-client.ts';
import type { PlatformIdentity } from '../platform-client.ts';
import type {
  ConversationDetail,
  ConversationsClient,
  TranscriptLine,
  VoiceEvent,
} from './conversations.ts';
import type { ChatChunk, LlmClient, LlmKey } from './llm.ts';
import type { BotRun, BotStart } from './automation.ts';

export function createMockConversations(
  me: PlatformIdentity,
  cancelRun: (id: string) => Promise<BotRun>,
): ConversationsClient & { updateBot: (input: BotStart, run: BotRun) => void } {
  const sessions: ConversationDetail[] =
    me.tenant.id === 'tenant-rivetquay'
      ? [
          {
            session: {
              id: 'conversation-chat-001',
              customer: 'Marlspoke Fabrication',
              channel: 'chat',
              status: 'open',
              assignedTo: null,
              handoff: 'bot',
              bot: { botId: 'fixture-chat', version: 1, route: 'native' },
            },
            transcript: [
              { id: 'seed-chat', speaker: 'customer', text: 'Can you check order ord-001?' },
            ],
          },
          {
            session: {
              id: 'conversation-voice-001',
              customer: 'Quayline Machine Works',
              channel: 'voice',
              status: 'waiting',
              assignedTo: null,
              handoff: 'requested',
              bot: { botId: 'fixture-chat', version: 1, route: 'native' },
            },
            transcript: [
              { id: 'seed-voice', speaker: 'customer', text: 'I need an update on a delivery.' },
            ],
          },
        ]
      : [];
  let sequence = 0;
  const staffMessages = new Map<string, { input: string; line: TranscriptLine }>();
  const voiceMessages = new Map<string, TranscriptLine[]>();
  function lookup(id: string) {
    const result = sessions.find(({ session }) => session.id === id);
    if (!result) throw new PlatformError('not_found');
    return result;
  }
  function operate(id: string) {
    if (!canOperate(me.role)) throw new PlatformError('forbidden');
    const detail = lookup(id);
    if (detail.session.status === 'closed') throw new PlatformError('forbidden');
    return detail;
  }
  return {
    updateBot(input, run) {
      const detail = sessions.find(({ session }) => session.id === input.sessionId);
      if (!detail) return;
      const lineId = run.id + ':customer';
      if (!detail.transcript.some(({ id }) => id === lineId)) {
        detail.transcript.push({ id: lineId, speaker: 'customer', text: input.prompt });
      }
      detail.activeRunId = ['queued', 'running', 'pending_approval'].includes(run.status)
        ? run.id
        : undefined;
      const output = run.result?.state === 'ok' ? run.result.output : null;
      if (
        output &&
        typeof output === 'object' &&
        'reply' in output &&
        typeof output.reply === 'string'
      ) {
        detail.transcript.push({ id: run.id + ':bot', speaker: 'bot', text: output.reply });
      }
    },
    async list() {
      return sessions.map(({ session }) => structuredClone(session));
    },
    async get(id) {
      return structuredClone(lookup(id));
    },
    async handoff(id, direction) {
      const detail = operate(id);
      const { session } = detail;
      if (
        session.handoff === 'human' &&
        session.assignedTo !== me.actor.id &&
        me.role !== 'admin'
      ) {
        throw new PlatformError('forbidden');
      }
      if (direction === 'takeover' && detail.activeRunId) await cancelRun(detail.activeRunId);
      session.handoff = direction === 'takeover' ? 'human' : 'bot';
      session.assignedTo = direction === 'takeover' ? me.actor.id : null;
      session.status = 'open';
      return structuredClone(session);
    },
    async sendStaffMessage(id, text, key) {
      const detail = operate(id);
      if (detail.session.handoff !== 'human' || detail.session.assignedTo !== me.actor.id) {
        throw new PlatformError('forbidden');
      }
      const input = JSON.stringify({ id, text });
      const previous = staffMessages.get(key);
      if (previous) {
        if (previous.input !== input) throw new PlatformError('idempotency_conflict');
        return structuredClone(previous.line);
      }
      const line: TranscriptLine = { id: 'staff-' + ++sequence, speaker: 'staff', text };
      detail.transcript.push(line);
      staffMessages.set(key, { input, line });
      return structuredClone(line);
    },
    async *voiceTurn(id, audio, key, signal): AsyncIterable<VoiceEvent> {
      const detail = operate(id);
      if (detail.session.channel !== 'voice' || detail.session.handoff === 'human')
        throw new PlatformError('forbidden');
      if (!audio.size) throw new PlatformError('invalid_input');
      yield { kind: 'partial', text: 'Check order…' };
      if (signal.aborted) return;
      const replayKey = id + ':' + key;
      let lines = voiceMessages.get(replayKey);
      if (!lines) {
        lines = [
          { id: 'voice-' + ++sequence, speaker: 'customer', text: 'Check order ord-001.' },
          {
            id: 'voice-' + ++sequence,
            speaker: 'bot',
            text: 'The fictional order ord-001 is confirmed.',
          },
        ];
        detail.transcript.push(...lines);
        voiceMessages.set(replayKey, lines);
      }
      for (const line of lines) yield { kind: 'transcript', line: structuredClone(line) };
      yield {
        kind: 'audio',
        mimeType: 'audio/wav',
        base64: 'UklGRiUAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQEAAACA',
      };
      yield { kind: 'settled' };
    },
  };
}

export function createMockLlm(
  me: PlatformIdentity,
  now: string,
  available: () => boolean,
  requiresStepUp: () => boolean,
  binding: () => { providerId: string; version: number } | undefined,
): LlmClient {
  const keys: LlmKey[] = [];
  let sequence = 0;
  function manage(sensitive = false) {
    if (me.role !== 'admin') throw new PlatformError('forbidden');
    if (sensitive && requiresStepUp()) throw new PlatformError('step_up_required');
  }
  function inference(model: string) {
    if (!canOperate(me.role)) throw new PlatformError('forbidden');
    if (!available()) throw new PlatformError('module_disabled');
    if (!['rivetquay-chat', 'rivetquay-embeddings'].includes(model))
      throw new PlatformError('not_found');
  }
  return {
    async models() {
      return available() ? [{ id: 'rivetquay-chat', owned_by: 'rivetquay' }] : [];
    },
    async *chat(input, signal): AsyncIterable<ChatChunk> {
      inference(input.model);
      if (input.model !== 'rivetquay-chat') throw new PlatformError('invalid_input');
      if (signal.aborted) return;
      const selected = binding();
      yield {
        choices: [],
        provider_route: selected?.providerId,
        binding_version: selected?.version,
      };
      const deltas: ChatChunk['choices'][number]['delta'][] = input.tools?.length
        ? [
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'fixture-call',
                  function: { name: input.tools[0].function.name, arguments: '{"order_id":' },
                },
              ],
            },
            { tool_calls: [{ index: 0, function: { arguments: '"ord-001"}' } }] },
          ]
        : input.response_format
          ? [{ content: '{"status":' }, { content: '"confirmed"}' }]
          : [{ content: 'Rivetquay fixture ' }, { content: 'response for order ord-001.' }];
      for (const delta of deltas) {
        if (signal.aborted) return;
        yield { choices: [{ index: 0, delta }] };
      }
      if (!signal.aborted)
        yield { choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } };
    },
    async embeddings(model, input) {
      inference(model);
      if (model !== 'rivetquay-embeddings') throw new PlatformError('invalid_input');
      return {
        data: (Array.isArray(input) ? input : [input]).map((_, index) => ({
          index,
          embedding: [0.25, 0.5, 0.75],
        })),
      };
    },
    async listKeys() {
      manage();
      return structuredClone(keys);
    },
    async createKey(name) {
      manage(true);
      if (!name.trim()) throw new PlatformError('invalid_input');
      const id = 'llm-key-' + ++sequence;
      keys.push({ id, name, prefix: 'rq-fixture-' + sequence, createdAt: now });
      return { secret: 'rq-fixture-' + sequence + '-display-once' };
    },
    async revokeKey(id) {
      manage(true);
      const index = keys.findIndex((key) => key.id === id);
      if (index < 0) throw new PlatformError('not_found');
      keys.splice(index, 1);
    },
  };
}
