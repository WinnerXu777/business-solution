import { useState, type ReactNode } from 'react';
import type { MessagePreview } from '@bs/contracts';
import { channels } from './presentation.ts';

export function Panel({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>{title}</h2>
        {aside}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function useTask() {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setNotice('');
    try {
      await task();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }
  return { busy, notice, setNotice, run };
}

export function Notice({ children }: { children: string }) {
  return (
    <p className="notice" role="status">
      {children}
    </p>
  );
}

export function MessageCard({ preview }: { preview: MessagePreview }) {
  return (
    <article className="message-card">
      <div className="message-meta">
        <span className="pill">{channels.find(({ id }) => id === preview.channel)?.name}</span>
        <span>{preview.recipient}</span>
      </div>
      {preview.subject && <h3>{preview.subject}</h3>}
      <p>{preview.body}</p>
    </article>
  );
}
