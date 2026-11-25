import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, EmptyState, Skeleton } from './components.tsx';
import { denialMessages, PlatformError } from './platform-client.ts';
import type { PlatformDenialCode } from './platform-client.ts';

export type ResourceState<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string; code?: PlatformDenialCode }
  | { status: 'ready'; data: T };

export function errorMessage(error: unknown) {
  return error instanceof PlatformError ? error.message : denialMessages.unavailable;
}

export function useResource<T>(load: () => Promise<T>) {
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<{ load: typeof load; state: ResourceState<T> }>();
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    let current = true;
    async function read() {
      try {
        const data = await load();
        if (current) setResult({ load, state: { status: 'ready', data } });
      } catch (error) {
        if (current)
          setResult({
            load,
            state: {
              status: 'error',
              message: errorMessage(error),
              code: error instanceof PlatformError ? error.code : undefined,
            },
          });
      }
    }
    void read();
    return () => {
      current = false;
    };
  }, [load, version]);

  const state: ResourceState<T> = result?.load === load ? result.state : { status: 'loading' };
  return { state, reload };
}

export type Notice = (message: string, tone?: 'success' | 'danger') => void;
export const ActionAuthContext = createContext<(error: PlatformError) => boolean>(() => false);

export function useAction(notify: Notice) {
  const handleAuth = useContext(ActionAuthContext);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function run<T>(action: () => Promise<T>, onSuccess: (result: T) => void) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const result = await action();
      if (active.current) onSuccess(result);
    } catch (error) {
      if (active.current && !(error instanceof PlatformError && handleAuth(error))) {
        notify(errorMessage(error), 'danger');
      }
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  }
  return { busy, run };
}

export function RemoteContent<T>({
  resource,
  children,
  label,
}: {
  resource: ReturnType<typeof useResource<T>>;
  children: (data: T) => ReactNode;
  label: string;
}) {
  const { state, reload } = resource;
  if (state.status === 'loading') return <Skeleton label={'Loading ' + label} />;
  if (state.status === 'error')
    return (
      <EmptyState title={'Could not load ' + label}>
        <p role="alert">{state.message}</p>
        <Button variant="secondary" onClick={reload}>
          Retry
        </Button>
      </EmptyState>
    );
  return children(state.data);
}
