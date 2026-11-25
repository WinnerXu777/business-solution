import { useEffect, useRef, useState } from 'react';
import { Button, Card, Dialog, Skeleton, Toast } from './components.tsx';
import { followAuthorization } from './clients/access.ts';
import type { AuthClient, Session } from './clients/access.ts';
import { errorMessage, useAction } from './data.tsx';
import type { Notice } from './data.tsx';
import { PlatformError } from './platform-client.ts';
import { PlatformApp } from './platform-app.tsx';
import type { PlatformAppProps } from './platform-app.tsx';

type Navigate = (url: string) => void;

function returnTo() {
  return window.location.pathname + window.location.hash;
}

export function StepUpDialog({
  auth,
  notify,
  navigate = followAuthorization,
  close,
}: {
  auth: AuthClient;
  notify: Notice;
  navigate?: Navigate;
  close: () => void;
}) {
  const redirect = useAction(notify);
  return (
    <Dialog title="Verify your identity" busy={redirect.busy} onClose={close}>
      <p>This action requires a fresh MFA sign-in. Return here to submit the action again.</p>
      <div className="bs-actions">
        <Button variant="secondary" disabled={redirect.busy} onClick={close}>
          Cancel
        </Button>
        <Button
          disabled={redirect.busy}
          onClick={() => {
            void redirect.run(
              async () => navigate((await auth.login(returnTo(), true)).authorizeUrl),
              () => {},
            );
          }}
        >
          Sign in with MFA
        </Button>
      </div>
    </Dialog>
  );
}

function completeSignIn(auth: AuthClient) {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code && !state && !url.searchParams.has('error')) return auth.refresh();

  for (const param of [
    'code',
    'state',
    'error',
    'error_description',
    'error_uri',
    'iss',
    'session_state',
  ]) {
    url.searchParams.delete(param);
  }
  window.history.replaceState(window.history.state, '', url);
  if (code && state) return auth.callback(code, state);
  return Promise.reject(new PlatformError('forbidden'));
}

export function AuthenticatedPlatformApp({
  navigate = followAuthorization,
  ...props
}: Omit<PlatformAppProps, 'sessionControls'> & { navigate?: Navigate }) {
  const [client, setClient] = useState(props.client);
  const [key, setKey] = useState(0);
  if (client !== props.client) {
    setClient(props.client);
    setKey(key + 1);
  }
  return <SessionGate key={key} navigate={navigate} {...props} />;
}

function SessionGate({
  client,
  navigate,
  ...props
}: Omit<PlatformAppProps, 'sessionControls'> & { navigate: Navigate }) {
  const [session, setSession] = useState<Session | null>();
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState<string>();
  const notify: Notice = (value) => setMessage(value);
  const { busy, run } = useAction(notify);
  const boot = useRef<{ auth: AuthClient; attempt: Promise<Session> }>(null);
  useEffect(() => {
    let active = true;
    if (boot.current?.auth !== client.auth) {
      boot.current = { auth: client.auth, attempt: completeSignIn(client.auth) };
    }
    void boot.current.attempt.then(
      (value) => {
        if (active) setSession(value);
      },
      (error: unknown) => {
        if (!active) return;
        setSession(null);
        if (!(error instanceof PlatformError) || error.code !== 'unauthenticated')
          setMessage(errorMessage(error));
      },
    );
    return () => {
      active = false;
    };
  }, [client]);

  function refresh() {
    void run(
      async () => {
        try {
          return await client.auth.refresh();
        } catch (error) {
          if (error instanceof PlatformError && error.code === 'unauthenticated') return null;
          throw error;
        }
      },
      (value) => {
        setSession(value);
        if (value) setRevision((current) => current + 1);
      },
    );
  }

  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });
  useEffect(() => {
    if (!session?.expiresAt) return;
    const expiry = Date.parse(session.expiresAt);
    if (!Number.isFinite(expiry)) return;
    const delay = Math.min(Math.max(0, expiry - Date.now()), 2_147_483_647);
    const timer = window.setTimeout(() => {
      if (expiry <= Date.now()) setSession(null);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [session]);
  useEffect(() => {
    if (!session?.expiresAt) return;
    const expiry = Date.parse(session.expiresAt);
    const delay = expiry - Date.now() - 60_000;
    if (delay < 0 || delay > 2_147_483_647) return;
    const timer = window.setTimeout(() => refreshRef.current(), delay);
    return () => window.clearTimeout(timer);
  }, [session]);

  return (
    <>
      {session ? (
        <PlatformApp
          {...props}
          client={client}
          sessionControls={{
            busy,
            refresh,
            logout: () => {
              void run(
                () => client.auth.logout(),
                () => {
                  setMessage(undefined);
                  setSession(null);
                },
              );
            },
            expired: () => setSession(null),
            navigate,
            revision,
          }}
        />
      ) : (
        <main className="bs-platform bs-sign-in">
          <Card title="Rivetquay platform">
            {session === undefined ? (
              <Skeleton label="Checking your session" />
            ) : (
              <div className="bs-stack">
                <h1>Sign in</h1>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setMessage(undefined);
                    void run(
                      async () => navigate((await client.auth.login(returnTo())).authorizeUrl),
                      () => {},
                    );
                  }}
                >
                  Sign in with your identity provider
                </Button>
              </div>
            )}
          </Card>
        </main>
      )}
      {message && (
        <div className="bs-notices">
          <Toast tone="danger" message={message} onDismiss={() => setMessage(undefined)} />
        </div>
      )}
    </>
  );
}
