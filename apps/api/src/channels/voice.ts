import { randomUUID } from 'node:crypto';
import type {
  SpeechToTextAdapter,
  TextToSpeechAdapter,
  Transcript,
} from '../../../../packages/adapters/src/speech/index.ts';
import type {
  IceCandidate,
  VoicePeer,
  VoicePeerFactory,
} from '../../../../packages/adapters/src/voice/peer.ts';
import {
  ConversationError,
  type Conversations,
  type Participant,
  type Scope,
} from '../../../../packages/core/src/conversations/index.ts';
import type { ChannelBot } from './bot.ts';

export type VoiceOptions = {
  peer: VoicePeerFactory;
  stt: SpeechToTextAdapter;
  tts: TextToSpeechAdapter;
  voiceId: string;
  maxCallMs?: number;
};
export type SignalEvent = (
  | { type: 'answer'; sdp: string }
  | { type: 'ice'; candidate: IceCandidate | null }
  | { type: 'transcript'; transcript: Transcript }
  | { type: 'dtmf'; digit: string }
  | { type: 'transfer' }
  | { type: 'playback_cancelled' }
  | { type: 'error'; code: 'media_failed' | 'turn_failed' }
  | { type: 'ended' }
) & { cursor: number };
type Signal = SignalEvent extends infer E
  ? E extends SignalEvent
    ? Omit<E, 'cursor'>
    : never
  : never;
type SignalListener = (event: SignalEvent) => void;
type CallPhase = 'new' | 'negotiating' | 'active' | 'ended';
type CallRecord = Scope & {
  callId: string;
  startedAt: number;
  answeredAt?: number;
  endedAt?: number;
  transfers: { queueId: string; at: number }[];
  digits: { digit: string; at: number }[];
};

export class VoiceCall {
  readonly record: CallRecord;
  private readonly options: VoiceOptions;
  private readonly conversations: Conversations;
  private readonly bot: ChannelBot;
  private readonly customer: Participant;
  private readonly queueId: string;
  private readonly now: () => number;
  private readonly peer: VoicePeer;
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<SignalListener>();
  private readonly events: SignalEvent[] = [];
  private readonly earlyIce: (IceCandidate | null)[] = [];
  private readonly timeout: ReturnType<typeof setTimeout>;
  private readonly unsubscribe: () => void;
  private phase: CallPhase = 'new';
  private cursor = 0;
  private responding?: AbortController;
  private lastFinal = -1;
  private playbackPending = false;

  constructor(
    scope: Scope,
    customer: Participant,
    queueId: string,
    options: VoiceOptions,
    conversations: Conversations,
    bot: ChannelBot,
    now: () => number,
  ) {
    this.record = {
      tenantId: scope.tenantId,
      conversationId: scope.conversationId,
      callId: randomUUID(),
      startedAt: now(),
      transfers: [],
      digits: [],
    };
    this.options = options;
    this.customer = customer;
    this.queueId = queueId;
    this.conversations = conversations;
    this.bot = bot;
    this.now = now;
    this.peer = options.peer({
      signal: this.lifetime.signal,
      onIce: (candidate) => {
        if (this.phase === 'active') this.emit({ type: 'ice', candidate });
        else if (this.phase !== 'ended' && this.earlyIce.length < 128)
          this.earlyIce.push(candidate);
      },
      onDtmf: (digit) => {
        if (this.phase !== 'active') return;
        try {
          this.dtmf(digit);
        } catch {
          this.emit({ type: 'error', code: 'media_failed' });
        }
      },
      onSpeechStart: () => {
        if (this.phase === 'active') this.interrupt();
      },
      onClose: () => queueMicrotask(() => this.end()),
    });
    this.unsubscribe = conversations.subscribe(scope, (event) => {
      if (event.type !== 'state') return;
      if (event.state === 'resolved') this.end();
      if (event.state === 'queued' && event.queueId) {
        this.record.transfers.push({ queueId: event.queueId, at: event.at });
        this.interrupt();
        this.emit({ type: 'transfer' });
      }
    });
    this.timeout = setTimeout(() => this.end(), options.maxCallMs ?? 20 * 60_000).unref();
  }

  private emit(data: Signal) {
    if (this.phase === 'ended' && data.type !== 'ended') return;
    const event = { ...data, cursor: ++this.cursor };
    this.events.push(event);
    if (this.events.length > 512) this.events.shift();
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // The media and call record remain valid when a stream disconnects.
      }
    }
  }

  history(after: number) {
    return this.events.filter((event) => event.cursor > after);
  }

  subscribe(listener: SignalListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async offer(sdp: string) {
    if (this.phase !== 'new') throw new ConversationError('conflict');
    this.phase = 'negotiating';
    try {
      const answer = await this.peer.acceptOffer(sdp);
      if (this.lifetime.signal.aborted) throw new ConversationError('conflict');
      this.record.answeredAt = this.now();
      this.emit({ type: 'answer', sdp: answer });
      this.phase = 'active';
      for (const candidate of this.earlyIce.splice(0)) this.emit({ type: 'ice', candidate });
      void this.ingest();
    } catch (error) {
      this.end();
      throw error;
    }
  }

  async ice(candidate: IceCandidate | null) {
    if (this.phase !== 'negotiating' && this.phase !== 'active')
      throw new ConversationError('conflict');
    await this.peer.addIce(candidate);
  }

  dtmf(digit: string) {
    this.requireActive();
    if (!/^[0-9*#A-D]$/.test(digit)) throw new ConversationError('invalid_input');
    if (this.record.digits.length >= 256) throw new ConversationError('conflict');
    this.record.digits.push({ digit, at: this.now() });
    this.emit({ type: 'dtmf', digit });
    if (digit === '0' && this.conversations.get(this.record).state === 'bot') this.transfer();
  }

  transfer() {
    this.requireActive();
    this.conversations.handoff(this.record, this.queueId);
  }

  private requireActive() {
    if (this.phase !== 'active') throw new ConversationError('conflict');
  }

  private interrupt() {
    if (!this.responding && !this.playbackPending) return;
    this.responding?.abort();
    this.responding = undefined;
    if (this.playbackPending) {
      this.playbackPending = false;
      try {
        this.peer.stopPlayback();
      } catch {
        this.emit({ type: 'error', code: 'media_failed' });
        this.end();
        return;
      }
      this.emit({ type: 'playback_cancelled' });
    }
  }

  private async ingest() {
    const signal = this.lifetime.signal;
    try {
      for await (const transcript of this.options.stt.transcribe({
        audio: this.peer.audio,
        sampleRateHz: 16000,
        signal,
      })) {
        if (signal.aborted) return;
        if (transcript.segment <= this.lastFinal || !transcript.text.trim()) continue;
        this.interrupt();
        if (signal.aborted) return;
        this.emit({ type: 'transcript', transcript });
        if (transcript.type === 'partial') continue;
        this.lastFinal = transcript.segment;
        const turn = new AbortController();
        this.responding = turn;
        void this.respond(transcript, turn);
      }
    } catch {
      if (!signal.aborted) {
        this.emit({ type: 'error', code: 'media_failed' });
        this.end();
      }
    }
  }

  private async respond(transcript: Transcript, turn: AbortController) {
    const { signal } = turn;
    const metadata = {
      channel: 'voice',
      callId: this.record.callId,
      segment: transcript.segment,
    } as const;
    try {
      const { reply } = await this.bot.turn(
        this.record,
        this.customer,
        transcript.text,
        metadata,
        signal,
      );
      if (!reply || signal.aborted) return;
      this.playbackPending = true;
      for await (const chunk of this.options.tts.synthesize({
        text: reply.text,
        voiceId: this.options.voiceId,
        format: 'pcm_s16le_16000',
        signal,
      })) {
        if (signal.aborted) return;
        await this.peer.play(chunk, signal);
      }
    } catch {
      if (!signal.aborted) this.emit({ type: 'error', code: 'turn_failed' });
    } finally {
      if (this.responding === turn) {
        this.responding = undefined;
        this.playbackPending = false;
      }
    }
  }

  end() {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.record.endedAt = this.now();
    clearTimeout(this.timeout);
    this.unsubscribe();
    this.lifetime.abort();
    this.interrupt();
    try {
      this.peer.close();
    } catch {
      // The ended state and record must outlive transport teardown.
    }
    this.emit({ type: 'ended' });
  }

  get ended() {
    return this.phase === 'ended';
  }
}
