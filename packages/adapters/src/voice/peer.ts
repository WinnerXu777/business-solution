import type { AudioChunk } from '../speech/index.ts';

export type IceCandidate = {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
};

export type PeerInput = {
  onIce(candidate: IceCandidate | null): void;
  onDtmf(digit: string): void;
  onSpeechStart(): void;
  onClose(): void;
  signal: AbortSignal;
};

/** Media bridge for one inbound WebRTC leg. Audio frames are 16 kHz PCM16. */
export interface VoicePeer {
  audio: AsyncIterable<Uint8Array>;
  acceptOffer(sdp: string): Promise<string>;
  addIce(candidate: IceCandidate | null): Promise<void>;
  play(chunk: AudioChunk, signal: AbortSignal): Promise<void>;
  /** Drop queued audio and interrupt the currently playing chunk. */
  stopPlayback(): void;
  close(): void;
}

export type VoicePeerFactory = (input: PeerInput) => VoicePeer;
