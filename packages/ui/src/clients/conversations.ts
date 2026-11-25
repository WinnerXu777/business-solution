import type { RequestJson } from '../platform-client.ts';
import { PlatformError } from '../platform-client.ts';
import type { BotStart } from './automation.ts';
import { sseData } from './sse.ts';
import type { OpenStream } from './sse.ts';

export type Conversation = {
  id: string;
  customer: string;
  channel: 'chat' | 'voice';
  status: 'open' | 'waiting' | 'closed';
  assignedTo: string | null;
  handoff: 'bot' | 'requested' | 'human';
  bot: Pick<BotStart, 'botId' | 'version' | 'route'>;
};
export interface TranscriptLine {
  id: string;
  speaker: 'customer' | 'bot' | 'staff';
  text: string;
}
export interface ConversationDetail {
  session: Conversation;
  transcript: TranscriptLine[];
  activeRunId?: string;
}
export type VoiceEvent =
  | { kind: 'partial'; text: string }
  | { kind: 'transcript'; line: TranscriptLine }
  | { kind: 'audio'; mimeType: 'audio/mpeg' | 'audio/wav' | 'audio/ogg'; base64: string }
  | { kind: 'settled' };

export interface ConversationsClient {
  list(): Promise<Conversation[]>;
  get(id: string): Promise<ConversationDetail>;
  handoff(id: string, direction: 'takeover' | 'handback'): Promise<Conversation>;
  sendStaffMessage(id: string, text: string, key: string): Promise<TranscriptLine>;
  voiceTurn(id: string, audio: Blob, key: string, signal: AbortSignal): AsyncIterable<VoiceEvent>;
}

const root = '/platform/v1/conversations';
const sessionPath = (id: string) => root + '/' + encodeURIComponent(id);

export class HttpConversationsClient implements ConversationsClient {
  private readonly request: RequestJson;
  private readonly open: OpenStream;

  constructor(request: RequestJson, open: OpenStream) {
    this.request = request;
    this.open = open;
  }
  list() {
    return this.request<Conversation[]>(root);
  }
  get(id: string) {
    return this.request<ConversationDetail>(sessionPath(id));
  }
  handoff(id: string, direction: 'takeover' | 'handback') {
    return this.request<Conversation>(sessionPath(id) + '/handoff', 'POST', { direction });
  }
  sendStaffMessage(id: string, text: string, key: string) {
    return this.request<TranscriptLine>(
      sessionPath(id) + '/messages',
      'POST',
      { text },
      { 'Idempotency-Key': key },
    );
  }
  async *voiceTurn(id: string, audio: Blob, key: string, signal: AbortSignal) {
    const body = new FormData();
    body.append('audio', audio, 'turn');
    const response = await this.open(sessionPath(id) + '/voice', {
      method: 'POST',
      body,
      signal,
      headers: { Accept: 'text/event-stream', 'Idempotency-Key': key },
    });
    for await (const data of sseData(response, signal)) {
      const event = JSON.parse(data) as VoiceEvent;
      yield event;
      if (event.kind === 'settled') return;
    }
    if (!signal.aborted) throw new PlatformError('provider_error');
  }
}
