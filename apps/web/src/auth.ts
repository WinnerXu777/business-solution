import { useEffect, useState } from 'react';

type Session = { accessToken: string; refreshToken: string; expiresAt: string };

export function useOidcSession(baseUrl: string, enabled: boolean) {
  const [session, setSession] = useState<Session>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const root = baseUrl.replace(/\/+$/, '') + '/platform/v1/auth/';

  useEffect(() => {
    if (!enabled || window.location.pathname !== '/oidc/callback') return;
    const { search } = window.location;
    window.history.replaceState(null, '', '/');
    setBusy(true);
    void fetch(root + 'callback' + search, { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error('OIDC callback failed.');
        const result = await response.json();
        if (result.status !== 'authenticated') {
          setError('This Dex account is unavailable in the selected workspace.');
          return;
        }
        setSession(result);
      })
      .catch(() => setError('Sign-in could not be completed. Start a new login.'))
      .finally(() => setBusy(false));
  }, [enabled, root]);

  useEffect(() => {
    if (!session) return;
    const timer = window.setTimeout(
      () => {
        void fetch(root + 'refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: session.refreshToken }),
        })
          .then(async (response) => {
            if (!response.ok) throw new Error('Session refresh failed.');
            const refreshed: Session = await response.json();
            setSession((current) => (current === session ? refreshed : current));
          })
          .catch(() => {
            setSession((current) => (current === session ? undefined : current));
            setError('Your session expired. Sign in again.');
          });
      },
      Math.max(0, Date.parse(session.expiresAt) - Date.now() - 30_000),
    );
    return () => window.clearTimeout(timer);
  }, [root, session]);

  async function signIn(tenantId: string) {
    setError('');
    setBusy(true);
    try {
      const response = await fetch(root + 'login?tenantId=' + encodeURIComponent(tenantId), {
        credentials: 'include',
      });
      if (!response.ok) throw new Error('OIDC login failed.');
      const { authorizeUrl } = await response.json();
      window.location.assign(authorizeUrl);
    } catch {
      setError('Dex sign-in is unavailable.');
      setBusy(false);
    }
  }

  async function signOut() {
    if (!session) return;
    setSession(undefined);
    setError('');
    try {
      const response = await fetch(root + 'logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      });
      if (!response.ok) throw new Error('OIDC logout failed.');
    } catch {
      setError('The sign-out request could not reach the session service.');
    }
  }
  return { token: session?.accessToken, error, busy, signIn, signOut };
}
