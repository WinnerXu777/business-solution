import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { Badge, Button, Card, EmptyState, Field, Select, Switch, Toast } from './components.tsx';
import { ActionAuthContext, RemoteContent, useAction, useResource } from './data.tsx';
import type { Notice } from './data.tsx';
import { PlatformError } from './platform-client.ts';
import type { PlatformClient, PlatformIdentity, Workspace } from './platform-client.ts';
import { ApprovalsScreen } from './screens/approvals.tsx';
import { ConnectionsScreen } from './screens/connections.tsx';
import { ProvidersScreen } from './screens/providers.tsx';
import { AuditScreen, OverviewScreen, UsageScreen } from './screens/reporting.tsx';
import { BotsScreen } from './screens/bots.tsx';
import {
  WorkflowsScreen,
  WorkflowRunsScreen,
  WorkflowHistoryScreen,
} from './screens/workflows.tsx';
import { ErpScreen, CrmScreen } from './screens/records.tsx';
import { InsightsScreen } from './screens/insights.tsx';
import { MembersScreen, RolesScreen } from './screens/access.tsx';
import { TenantsScreen } from './screens/tenants.tsx';
import { ConversationsScreen } from './screens/conversations.tsx';
import { LlmPlayground } from './screens/llm.tsx';
import { StepUpDialog } from './session.tsx';
import {
  ConnectorsScreen,
  CredentialsScreen,
  ModulesAndBillingScreen,
} from './screens/administration.tsx';
import './styles.css';

type Theme = 'light' | 'dark';

export interface PlatformRouteContext {
  client: PlatformClient;
  me: PlatformIdentity;
  workspace: Workspace;
  path: string;
  notify: Notice;
}
export interface PlatformRoute {
  path: string;
  title: string;
  component: ComponentType<PlatformRouteContext>;
  navLabel?: string;
  visible?: (me: PlatformIdentity) => boolean;
}
interface SessionControls {
  busy: boolean;
  refresh: () => void;
  logout: () => void;
  expired: () => void;
  navigate: (url: string) => void;
  revision: number;
}
export interface PlatformAppProps {
  client: PlatformClient;
  extraRoutes?: readonly PlatformRoute[];
  resolveWorkspaceClient?: (workspace: Workspace) => Promise<PlatformClient>;
  sessionControls?: SessionControls;
}

const themeKey = 'bs-platform-theme';
function preferredTheme(): Theme {
  try {
    const stored = globalThis.localStorage?.getItem(themeKey);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // The current session can still use either theme when storage is unavailable.
  }
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function normalizePath(value: string) {
  return '/' + value.replace(/^\/+|\/+$/g, '');
}

function readPath() {
  return normalizePath(window.location.hash.slice(1).split('?')[0]);
}

function subscribePath(callback: () => void) {
  window.addEventListener('hashchange', callback);
  return () => window.removeEventListener('hashchange', callback);
}

const compactNavigation = '(max-width: 850px)';
function narrowViewport() {
  return window.matchMedia?.(compactNavigation).matches ?? false;
}
function subscribeViewport(callback: () => void) {
  const query = window.matchMedia?.(compactNavigation);
  query?.addEventListener('change', callback);
  return () => query?.removeEventListener('change', callback);
}

function SettingsRoute() {
  return null;
}

const baseRoutes: readonly PlatformRoute[] = [
  { path: '/', title: 'Overview', component: OverviewScreen },
  { path: '/approvals', title: 'Approvals', component: ApprovalsScreen },
  { path: '/bots', title: 'Bots', component: BotsScreen },
  { path: '/conversations', title: 'Conversations', component: ConversationsScreen },
  { path: '/workflows', title: 'Workflows', component: WorkflowsScreen },
  { path: '/erp', title: 'ERP', component: ErpScreen },
  { path: '/crm', title: 'CRM', component: CrmScreen },
  { path: '/insights', title: 'Insights', component: InsightsScreen },
  { path: '/llm', title: 'LLM playground', component: LlmPlayground },
  { path: '/connectors', title: 'Connectors', component: ConnectorsScreen },
  { path: '/providers', title: 'Providers', component: ProvidersScreen },
  { path: '/credentials', title: 'Credentials', component: CredentialsScreen },
  { path: '/modules', title: 'Modules and billing', component: ModulesAndBillingScreen },
  { path: '/connections', title: 'Connections', component: ConnectionsScreen },
  { path: '/members', title: 'Members', component: MembersScreen },
  { path: '/roles', title: 'Roles', component: RolesScreen, visible: (me) => me.role === 'admin' },
  {
    path: '/tenants',
    title: 'Tenants',
    component: TenantsScreen,
    visible: (me) => Boolean(me.platformOperator),
  },
  { path: '/audit', title: 'Audit log', component: AuditScreen },
  { path: '/usage', title: 'Usage', component: UsageScreen },
  { path: '/settings', title: 'Settings', component: SettingsRoute },
];

const detailRoutes: readonly PlatformRoute[] = [
  { path: '/workflows/runs', title: 'Workflow runs', component: WorkflowRunsScreen },
  { path: '/workflows/dead-letters', title: 'Dead letters', component: WorkflowRunsScreen },
  { path: '/workflows/run/:id', title: 'Workflow run', component: WorkflowHistoryScreen },
  { path: '/erp/order/:id', title: 'Order detail', component: ErpScreen },
  { path: '/erp/request/:id', title: 'Purchase request', component: ErpScreen },
  { path: '/erp/purchase-requests', title: 'Purchase requests', component: ErpScreen },
  { path: '/erp/purchase-orders', title: 'Purchase orders', component: ErpScreen },
  { path: '/erp/inventory', title: 'Inventory', component: ErpScreen },
  { path: '/erp/vendors', title: 'Vendors', component: ErpScreen },
  { path: '/crm/customer/:id', title: 'Customer detail', component: CrmScreen },
  { path: '/crm/invoice/:id', title: 'Customer invoice', component: CrmScreen },
  { path: '/crm/contacts', title: 'Contacts', component: CrmScreen },
  { path: '/crm/pipeline', title: 'Pipeline', component: CrmScreen },
  { path: '/insights/fraud/:id', title: 'Fraud score', component: InsightsScreen },
  { path: '/insights/forecast', title: 'Forecast', component: InsightsScreen },
  { path: '/insights/profile', title: 'Customer profile', component: InsightsScreen },
  { path: '/insights/profile/:id', title: 'Customer profile', component: InsightsScreen },
  { path: '/billing', title: 'Billing', component: ModulesAndBillingScreen },
  { path: '/billing/invoice/:id', title: 'Billing invoice', component: ModulesAndBillingScreen },
  { path: '/connectors/connector/:id', title: 'Connector detail', component: ConnectorsScreen },
];

const navigation = [
  { label: 'Operate', paths: ['/', '/approvals', '/bots', '/conversations', '/workflows'] },
  { label: 'Records', paths: ['/erp', '/crm'] },
  { label: 'Intelligence', paths: ['/insights', '/llm'] },
  {
    label: 'Platform',
    paths: [
      '/connectors',
      '/providers',
      '/credentials',
      '/modules',
      '/connections',
      '/members',
      '/roles',
      '/tenants',
      '/audit',
      '/usage',
      '/settings',
    ],
  },
];
const navIcons: Record<string, string> = {
  '/': '◫',
  '/approvals': '✓',
  '/bots': '◉',
  '/conversations': '☏',
  '/workflows': '◇',
  '/erp': '▤',
  '/crm': '◎',
  '/insights': '◈',
  '/llm': '✦',
  '/connectors': '⎇',
  '/providers': '⇆',
  '/credentials': '⌘',
  '/modules': '▦',
  '/connections': '⊞',
  '/members': '♙',
  '/roles': '☷',
  '/tenants': '▧',
  '/audit': '≡',
  '/usage': '▥',
  '/settings': '⚙',
};
const navPaths = new Set(navigation.flatMap(({ paths }) => paths));

function SettingsScreen({
  me,
  theme,
  setTheme,
}: {
  me: PlatformIdentity;
  theme: Theme;
  setTheme: (theme: Theme) => void;
}) {
  return (
    <div className="bs-stack">
      <Card title="Profile">
        <dl className="bs-details">
          <dt>Name</dt>
          <dd>{me.actor.displayName}</dd>
          <dt>Actor ID</dt>
          <dd>{me.actor.id}</dd>
          <dt>Role</dt>
          <dd>
            <Badge tone="accent">{me.role}</Badge>
          </dd>
          <dt>Tenant</dt>
          <dd>{me.tenant.name}</dd>
        </dl>
      </Card>
      <Card title="Appearance">
        <Switch
          label="Dark theme"
          checked={theme === 'dark'}
          onChange={(active) => setTheme(active ? 'dark' : 'light')}
        />
      </Card>
    </div>
  );
}

function TopBar({
  me,
  client,
  activeWorkspace,
  onSwitch,
  notify,
  sessionControls,
}: {
  me: PlatformIdentity;
  client: PlatformClient;
  activeWorkspace?: Workspace;
  onSwitch?: (workspace: Workspace) => Promise<void>;
  notify: Notice;
  sessionControls?: SessionControls;
}) {
  const options = useResource(useCallback(() => client.getWorkspaces(), [client]));
  const { busy, run } = useAction(notify);
  const workspace =
    activeWorkspace ??
    me.workspaces.find((item) => item.id === me.tenant.id) ??
    me.workspaces[0] ??
    me.tenant;
  const workspaces =
    options.state.status === 'ready'
      ? options.state.data.filter((item) => me.workspaces.some((allowed) => allowed.id === item.id))
      : me.workspaces;
  const choices = [workspace, ...workspaces.filter((item) => item.id !== workspace.id)];
  const profileMenu = useRef<HTMLDetailsElement>(null);
  const profileTrigger = useRef<HTMLElement>(null);

  return (
    <header className="bs-topbar">
      <div className="bs-workspace">
        <Field
          label="Workspace"
          error={options.state.status === 'error' ? options.state.message : undefined}
        >
          {(props) => (
            <Select
              {...props}
              value={workspace.id}
              disabled={busy || choices.length < 2 || !onSwitch}
              onChange={(event) => {
                const id = event.target.value;
                if (!onSwitch) return;
                void run(
                  async () => {
                    await onSwitch(await client.getWorkspace(id));
                  },
                  () => {},
                );
              }}
            >
              {choices.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {options.state.status === 'error' && (
          <button type="button" className="bs-link-button" onClick={options.reload}>
            Retry workspaces
          </button>
        )}
      </div>
      <div className="bs-profile">
        <Badge tone="accent">{me.role}</Badge>
        <details
          className="bs-user-menu"
          ref={profileMenu}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && profileMenu.current?.open) {
              profileMenu.current.open = false;
              profileTrigger.current?.focus();
            }
          }}
        >
          <summary ref={profileTrigger} aria-label={'User menu, ' + me.actor.displayName}>
            <span className="bs-avatar" aria-hidden="true">
              {me.actor.displayName
                .split(' ')
                .slice(0, 2)
                .map((part) => part[0])
                .join('')}
            </span>
            <span>{me.actor.displayName}</span>
          </summary>
          <div className="bs-user-popover">
            <strong>{me.actor.displayName}</strong>
            <small className="bs-subline">{me.actor.id}</small>
            <a
              href="#/settings"
              onClick={() => {
                if (profileMenu.current) profileMenu.current.open = false;
              }}
            >
              Profile settings
            </a>
            {sessionControls && (
              <>
                <Button
                  variant="quiet"
                  disabled={sessionControls.busy}
                  onClick={sessionControls.refresh}
                >
                  Refresh session
                </Button>
                <Button
                  variant="quiet"
                  disabled={sessionControls.busy}
                  onClick={sessionControls.logout}
                >
                  Sign out
                </Button>
              </>
            )}
          </div>
        </details>
      </div>
    </header>
  );
}

function PlatformShell({
  client,
  extraRoutes = [],
  resolveWorkspaceClient,
  sessionControls,
}: PlatformAppProps) {
  const [selection, setSelection] = useState<{
    client: PlatformClient;
    workspace: Workspace;
    identity: PlatformIdentity;
  }>();
  const sessionClient = selection?.client ?? client;
  const identity = useResource(
    useCallback(
      () => (selection ? Promise.resolve(selection.identity) : client.getMe()),
      [client, selection],
    ),
  );
  const path = useSyncExternalStore(subscribePath, readPath, () => '/');
  const navigationId = useId();
  const compact = useSyncExternalStore(subscribeViewport, narrowViewport, () => false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [theme, setTheme] = useState(preferredTheme);
  const [notices, setNotices] = useState<
    { id: number; message: string; tone: 'success' | 'danger' }[]
  >([]);
  const sequence = useRef(0);
  const title = useRef<HTMLHeadingElement>(null);
  const previousPath = useRef(path);
  const body = useRef<HTMLDivElement>(null);
  const [toastTarget, setToastTarget] = useState<HTMLDialogElement | null>(null);
  const [stepUp, setStepUp] = useState(false);

  const notify: Notice = useCallback((message, tone = 'success') => {
    const id = ++sequence.current;
    setNotices((items) => [...items.slice(-3), { id, message, tone }]);
  }, []);
  function handleAuth(error: PlatformError) {
    if (error.code === 'step_up_required') {
      setStepUp(true);
      return true;
    }
    if (error.code === 'unauthenticated' && sessionControls) {
      sessionControls.expired();
      return true;
    }
    return false;
  }
  const expired = sessionControls?.expired;
  const revision = sessionControls?.revision;
  const lastRevision = useRef(revision);
  const reloadIdentity = identity.reload;
  useEffect(() => {
    if (lastRevision.current !== revision) {
      lastRevision.current = revision;
      reloadIdentity();
    }
  }, [revision, reloadIdentity]);
  useEffect(() => {
    if (identity.state.status === 'error' && identity.state.code === 'unauthenticated') expired?.();
  }, [identity.state, expired]);
  const routes = new Map([...baseRoutes, ...detailRoutes].map((route) => [route.path, route]));
  for (const route of extraRoutes) {
    const routePath = normalizePath(route.path);
    routes.set(routePath, { ...route, path: routePath });
  }
  const route = routes.get(path) ?? routes.get(path.replace(/\/[^/]+$/, '/:id'));
  const me = identity.state.status === 'ready' ? identity.state.data : undefined;
  const nav = [...routes.values()].filter(
    (item) =>
      (navPaths.has(item.path) || item.navLabel) && (!item.visible || (me && item.visible(me))),
  );
  const parentPath = path === '/billing' || path.startsWith('/billing/') ? '/modules' : path;
  const activeNav =
    nav.find((item) => item.path === parentPath) ??
    [...nav].reverse().find((item) => item.path !== '/' && path.startsWith(item.path + '/'));
  const navGroups = navigation.map(({ label, paths }) => ({
    label,
    items: nav.filter(
      (item) => paths.includes(item.path) || (label === 'Platform' && !navPaths.has(item.path)),
    ),
  }));

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(themeKey, theme);
    } catch {
      // The current theme still applies when storage is unavailable.
    }
  }, [theme]);

  useEffect(() => {
    if (previousPath.current !== path) {
      previousPath.current = path;
      setNavigationOpen(false);
      title.current?.focus();
    }
  }, [path]);

  // Keep notifications in the active modal's focus boundary.
  useEffect(() => {
    const root = body.current!;
    const observer = new MutationObserver(() => {
      setToastTarget(
        Array.from(root.querySelectorAll<HTMLDialogElement>('.bs-overlay[open]')).at(-1) ?? null,
      );
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open'],
    });
    return () => observer.disconnect();
  }, []);
  async function switchWorkspace(workspace: Workspace) {
    if (!resolveWorkspaceClient) return;
    const next = await resolveWorkspaceClient(workspace);
    if (next === sessionClient) throw new PlatformError('forbidden');
    const nextMe = await next.getMe();
    if (
      nextMe.tenant.id !== workspace.id &&
      !nextMe.workspaces.some((item) => item.id === workspace.id)
    ) {
      throw new PlatformError('forbidden');
    }
    setNotices([]);
    setSelection({ client: next, workspace, identity: nextMe });
  }

  const notifications = (
    <div className="bs-notices" aria-label="Notifications">
      {notices.map((notice) => (
        <Toast
          key={notice.id}
          {...notice}
          onDismiss={() => setNotices((items) => items.filter((item) => item.id !== notice.id))}
        />
      ))}
    </div>
  );
  return (
    <ActionAuthContext.Provider value={handleAuth}>
      <div className="bs-platform" data-theme={theme} ref={body}>
        <aside className="bs-sidebar">
          <a className="bs-brand" href="#/" aria-label="Rivetquay overview">
            <span className="bs-brand-mark" aria-hidden="true">
              R
            </span>
            <span>
              <strong>Rivetquay</strong>
              <small>Platform console</small>
            </span>
          </a>
          <Button
            className="bs-nav-toggle"
            variant="secondary"
            aria-expanded={navigationOpen}
            aria-controls={navigationId}
            onClick={() => setNavigationOpen((value) => !value)}
          >
            Menu
          </Button>
          <nav
            id={navigationId}
            aria-label="Platform navigation"
            hidden={compact && !navigationOpen}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && compact && navigationOpen) {
                setNavigationOpen(false);
                event.currentTarget.parentElement
                  ?.querySelector<HTMLButtonElement>('.bs-nav-toggle')
                  ?.focus();
              }
            }}
          >
            {navGroups.map(({ label, items }) => (
              <div key={label} className="bs-nav-group" role="group" aria-label={label}>
                <p className="bs-nav-group-title" aria-hidden="true">
                  {label}
                </p>
                {items.map((item) => (
                  <a
                    key={item.path}
                    href={'#' + item.path}
                    aria-current={activeNav?.path === item.path ? 'page' : undefined}
                    onClick={() => {
                      setNavigationOpen(false);
                      if (item.path === path) title.current?.focus();
                    }}
                  >
                    <span aria-hidden="true" className="bs-nav-icon">
                      {navIcons[item.path] ?? '·'}
                    </span>
                    {item.navLabel ?? item.title}
                  </a>
                ))}
              </div>
            ))}
          </nav>
        </aside>
        <div className="bs-main">
          <RemoteContent resource={identity} label="your workspace">
            {(me) => {
              const workspace =
                selection?.workspace ??
                me.workspaces.find((item) => item.id === me.tenant.id) ??
                me.workspaces[0] ??
                me.tenant;
              const Component = route?.component;
              return (
                <>
                  <TopBar
                    me={me}
                    client={sessionClient}
                    notify={notify}
                    activeWorkspace={workspace}
                    onSwitch={resolveWorkspaceClient ? switchWorkspace : undefined}
                    sessionControls={sessionControls}
                  />
                  <main className="bs-content">
                    <h1 ref={title} tabIndex={-1}>
                      {route?.title ?? 'Page not found'}
                    </h1>
                    <div key={workspace.id + ':' + path}>
                      {path === '/settings' && Component === SettingsRoute ? (
                        <SettingsScreen me={me} theme={theme} setTheme={setTheme} />
                      ) : Component ? (
                        <Component
                          client={sessionClient}
                          me={me}
                          workspace={workspace}
                          path={path}
                          notify={notify}
                        />
                      ) : (
                        <EmptyState title="This route is unavailable.">
                          <a href="#/">Return to overview</a>
                        </EmptyState>
                      )}
                    </div>
                  </main>
                </>
              );
            }}
          </RemoteContent>
        </div>
        {stepUp && (
          <StepUpDialog
            auth={sessionClient.auth}
            notify={notify}
            navigate={sessionControls?.navigate}
            close={() => setStepUp(false)}
          />
        )}
        {toastTarget ? createPortal(notifications, toastTarget) : notifications}
      </div>
    </ActionAuthContext.Provider>
  );
}

export function PlatformApp(props: PlatformAppProps) {
  // Reset the session whenever the mounting app replaces its verified client.
  const [mountedClient, setMountedClient] = useState(props.client);
  const [sessionKey, setSessionKey] = useState(0);
  if (props.client !== mountedClient) {
    setMountedClient(props.client);
    setSessionKey(sessionKey + 1);
  }
  return <PlatformShell key={sessionKey} {...props} />;
}
