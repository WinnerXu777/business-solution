import { useEffect, useRef, useState } from 'react';
import type { ConversationsClient, TranscriptLine } from '../clients/conversations.ts';
import { Button } from '../components.tsx';
import { errorMessage } from '../data.tsx';
import type { Notice } from '../data.tsx';

interface Recording {
  recorder: MediaRecorder;
  stream: MediaStream;
}

export function VoicePanel({
  client,
  id,
  append,
  notify,
}: {
  client: ConversationsClient;
  id: string;
  append: (line: TranscriptLine) => void;
  notify: Notice;
}) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'transcribing'>('idle');
  const [partial, setPartial] = useState('');
  const [playback, setPlayback] = useState(false);
  const recording = useRef<Recording>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const capture = useRef<AbortController>(null);
  const turn = useRef<AbortController>(null);
  const muteTurn = useRef(false);
  const limit = useRef<number>(undefined);

  function stopPlayback() {
    if (audio.current) {
      audio.current.pause();
      audio.current.removeAttribute('src');
      audio.current = null;
    }
    setPlayback(false);
  }

  useEffect(
    () => () => {
      capture.current?.abort();
      turn.current?.abort();
      if (recording.current) {
        const { recorder, stream } = recording.current;
        if (recorder.state !== 'inactive') recorder.stop();
        stream.getTracks().forEach((track) => track.stop());
      }
      if (audio.current) {
        audio.current.pause();
        audio.current.removeAttribute('src');
      }
      window.clearTimeout(limit.current);
    },
    [],
  );

  async function streamTurn(blob: Blob) {
    if (!blob.size) {
      setPhase('idle');
      return;
    }
    const controller = new AbortController();
    turn.current = controller;
    setPhase('transcribing');
    setPartial('');
    const key = crypto.randomUUID();
    try {
      for await (const event of client.voiceTurn(id, blob, key, controller.signal)) {
        if (controller.signal.aborted) break;
        if (event.kind === 'partial') setPartial(event.text);
        if (event.kind === 'transcript') {
          setPartial('');
          append(event.line);
        }
        if (event.kind === 'audio' && !muteTurn.current && !audio.current) {
          const player = new Audio('data:' + event.mimeType + ';base64,' + event.base64);
          audio.current = player;
          player.onended = () => {
            if (audio.current === player) stopPlayback();
          };
          setPlayback(true);
          void player.play().catch(() => {
            if (audio.current === player) {
              stopPlayback();
              notify('Voice playback is unavailable.', 'danger');
            }
          });
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) notify(errorMessage(error), 'danger');
    } finally {
      if (turn.current === controller) {
        turn.current = null;
        if (!controller.signal.aborted) {
          setPhase('idle');
          setPartial('');
        }
      }
    }
  }

  function finish() {
    window.clearTimeout(limit.current);
    if (recording.current) {
      const { recorder, stream } = recording.current;
      recording.current = null;
      setPhase('transcribing');
      if (recorder.state !== 'inactive') recorder.stop();
      stream.getTracks().forEach((track) => track.stop());
    } else if (phase === 'starting') {
      capture.current?.abort();
      capture.current = null;
      setPhase('idle');
    }
  }

  async function start() {
    if (capture.current || turn.current || recording.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      notify('Microphone recording is unavailable in this browser.', 'danger');
      return;
    }
    stopPlayback();
    muteTurn.current = false;
    const controller = new AbortController();
    capture.current = controller;
    setPhase('starting');
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (controller.signal.aborted) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = ({ data }) => {
        if (data.size) chunks.push(data);
      };
      recorder.onstop = () => {
        if (controller.signal.aborted) return;
        capture.current = null;
        void streamTurn(new Blob(chunks, { type: recorder.mimeType }));
      };
      recorder.onerror = () => {
        recorder.onstop = null;
        finish();
        capture.current = null;
        setPhase('idle');
        notify('The microphone could not finish recording.', 'danger');
      };
      recording.current = { recorder, stream };
      recorder.start();
      setPhase('recording');
      limit.current = window.setTimeout(finish, 30_000);
    } catch {
      stream?.getTracks().forEach((track) => track.stop());
      if (!controller.signal.aborted) {
        capture.current = null;
        recording.current = null;
        setPhase('idle');
        notify('The microphone could not be opened.', 'danger');
      }
    }
  }

  const pressed = phase === 'starting' || phase === 'recording';
  return (
    <section className="bs-stack bs-voice" aria-label="Browser voice">
      <h3>Browser voice</h3>
      <p role="status">
        {
          {
            idle: 'Hold to record. Press Enter to start or stop with the keyboard.',
            starting: 'Opening microphone…',
            recording: 'Recording…',
            transcribing: 'Listening for transcript…',
          }[phase]
        }
      </p>
      <div className="bs-actions">
        <Button
          disabled={phase === 'transcribing'}
          aria-pressed={pressed}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture?.(event.pointerId);
            void start();
          }}
          onPointerUp={() => {
            if (capture.current) finish();
          }}
          onLostPointerCapture={() => {
            if (capture.current) finish();
          }}
          onPointerCancel={() => {
            if (capture.current) finish();
          }}
          onClick={(event) => {
            if (event.detail !== 0) return;
            if (pressed) finish();
            else void start();
          }}
        >
          Push to talk
        </Button>
        {(playback || phase === 'transcribing') && (
          <Button
            variant="secondary"
            onClick={() => {
              muteTurn.current = true;
              stopPlayback();
            }}
          >
            Interrupt voice reply
          </Button>
        )}
      </div>
      {partial && (
        <p role="status">
          <strong>Live transcript</strong> {partial}
        </p>
      )}
    </section>
  );
}
