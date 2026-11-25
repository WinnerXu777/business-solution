import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HttpPlatformClient, PlatformApp, type PlatformRoute } from '@bs/ui';
import '@xyflow/react/dist/style.css';
import './styles.css';
import {
  AutomationContext,
  createAutomationClient,
  useAutomation,
  type WorkflowRun,
} from './api.ts';
import { useOidcSession } from './auth.ts';
import { BotRuns } from './bot-runs.tsx';
import { platformFetch } from './platform-http.ts';
import { Notice } from './panels.tsx';
import { BrowserVoice, Chat, Portal } from './portal.tsx';
import { Workflow } from './workflow.tsx';

const baseUrl = import.meta.env.VITE_API_BASE_URL ?? '';
const oidcLogin = import.meta.env.VITE_BS_AUTH_MODE === 'oidc';
const fixtureLogin =
  !oidcLogin && import.meta.env.DEV && import.meta.env.VITE_FIXTURE_LOGIN === '1';
const logins = [
  ['fixture-operator', 'Rivetquay operator'],
  ['fixture-admin', 'Rivetquay admin'],
  ['fixture-approver', 'Rivetquay approver'],
  ['fixture-reader', 'Rivetquay reader'],
  ['fixture-isolation', 'Spoolharbour operator'],
];

function WorkflowPage() {
  const api = useAutomation();
  const [history, setHistory] = useState<WorkflowRun[]>([]);
  const [revision, refresh] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void api.history().then(
      (runs) => {
        if (active) {
          setHistory(runs);
          setError('');
        }
      },
      () => {
        if (active) setError('Workflow history is unavailable.');
      },
    );
    return () => {
      active = false;
    };
  }, [api, revision]);
  return (
    <div className="legacy-ui">
      <Notice>{error}</Notice>
      <Workflow history={history} onChange={() => refresh((value) => value + 1)} />
    </div>
  );
}

const routes: readonly PlatformRoute[] = [
  {
    path: '/chat',
    title: 'Chat',
    navLabel: 'Chat',
    component: () => (
      <div className="legacy-ui">
        <Chat route="native" onChange={() => {}} />
      </div>
    ),
  },
  {
    path: '/voice',
    title: 'Browser voice',
    navLabel: 'Browser voice',
    component: () => (
      <div className="legacy-ui">
        <BrowserVoice route="native" />
      </div>
    ),
  },
  { path: '/legacy-workflows', title: 'Milestone 1 workflows', component: WorkflowPage },
  { path: '/bot-runs', title: 'Bot runs and approvals', navLabel: 'Bot runs', component: BotRuns },
  {
    path: '/legacy',
    title: 'Milestone 1 portal',
    navLabel: 'Milestone 1 portal',
    component: ({ me }) => (
      <div className="legacy-ui">
        <Portal role={me.role} />
      </div>
    ),
  },
];

function App() {
  const [fixtureToken, setToken] = useState(fixtureLogin ? logins[0][0] : '');
  const [entered, setEntered] = useState('');
  const [tenant, setTenant] = useState('tenant-rivetquay');
  const oidc = useOidcSession(baseUrl, oidcLogin);
  const token = oidcLogin ? (oidc.token ?? '') : fixtureToken;
  const client = useMemo(
    () => new HttpPlatformClient({ baseUrl, token, fetch: platformFetch }),
    [token],
  );
  const automation = useMemo(() => createAutomationClient(baseUrl, token), [token]);
  return (
    <>
      <div className="fixture-session">
        {oidcLogin ? (
          <>
            {oidc.error && <p role="alert">{oidc.error}</p>}
            {token ? (
              <button type="button" onClick={() => void oidc.signOut()}>
                Sign out
              </button>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void oidc.signIn(tenant);
                }}
              >
                <label>
                  Workspace
                  <select value={tenant} onChange={(event) => setTenant(event.target.value)}>
                    <option value="tenant-rivetquay">Rivetquay</option>
                    <option value="tenant-spoolharbour">Spoolharbour</option>
                  </select>
                </label>
                <button type="submit" disabled={oidc.busy}>
                  Sign in with Dex
                </button>
              </form>
            )}
          </>
        ) : fixtureLogin ? (
          <label>
            Fixture identity
            <select value={token} onChange={(event) => setToken(event.target.value)}>
              {logins.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        ) : token ? (
          <button
            type="button"
            onClick={() => {
              setToken('');
              setEntered('');
            }}
          >
            Sign out
          </button>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setToken(entered.trim());
            }}
          >
            <label>
              Fixture bearer token
              <input
                type="password"
                required
                value={entered}
                onChange={(event) => setEntered(event.target.value)}
              />
            </label>
            <button type="submit">Open platform</button>
          </form>
        )}
      </div>
      {token && (
        <AutomationContext.Provider value={automation}>
          <PlatformApp client={client} extraRoutes={routes} />
        </AutomationContext.Provider>
      )}
    </>
  );
}

const root = document.querySelector('#root');
if (!root) throw new Error('Missing portal root');

createRoot(root).render(<App />);
