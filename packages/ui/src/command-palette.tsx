import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, Field } from './components.tsx';
import { useAction } from './data.tsx';
import type { Notice } from './data.tsx';
import { useI18n } from './i18n.tsx';
import type { PlatformRoute } from './platform-app.tsx';
import type { PlatformClient, PlatformIdentity } from './platform-client.ts';
import { validId } from './clients/workflow-definition.ts';

interface Command {
  label: string;
  run: () => void;
}

export function CommandPalette({
  client,
  me,
  routes,
  notify,
  toggleTheme,
}: {
  client: PlatformClient;
  me: PlatformIdentity;
  routes: readonly PlatformRoute[];
  notify: Notice;
  toggleTheme: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.key.toLowerCase() !== 'k' ||
        event.repeat
      )
        return;
      // Avoid placing one modal over another.
      if (document.querySelector('.bs-overlay[open]')) return;
      event.preventDefault();
      setOpen(true);
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  const navigate = (path: string) => {
    setOpen(false);
    window.location.hash = '#' + path;
  };
  const commands: Command[] = [
    ...routes
      .filter((route) => !route.path.includes('/:') && (!route.visible || route.visible(me)))
      .map((route) => ({
        label: t(route.navLabel ?? route.title),
        run: () => navigate(route.path),
      })),
    {
      label: t('Toggle dark theme'),
      run: () => {
        toggleTheme();
        setOpen(false);
      },
    },
    ...(me.role === 'admin'
      ? [{ label: t('Run a contact check'), run: () => navigate('/compliance/contact-check') }]
      : []),
  ];
  return (
    <>
      <Button variant="quiet" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {t('Commands')} <kbd className="bs-shortcut">Ctrl/⌘ K</kbd>
      </Button>
      {open && (
        <PaletteDialog
          client={client}
          commands={commands}
          close={() => setOpen(false)}
          notify={notify}
          navigate={navigate}
        />
      )}
    </>
  );
}

function PaletteDialog({
  client,
  commands,
  close,
  notify,
  navigate,
}: {
  client: PlatformClient;
  commands: Command[];
  close: () => void;
  notify: Notice;
  navigate: (path: string) => void;
}) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const action = useAction(notify);
  const canonical = (value: string) =>
    value
      .trim()
      .toLocaleLowerCase(locale)
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '');
  const matches = commands.filter(({ label }) => canonical(label).includes(canonical(query)));
  const id = query.trim();
  const records = client.records;
  const lookups = [
    { prefix: 'ord-', path: '/erp/order', read: (id: string) => records.getOrder(id) },
    { prefix: 'pr-', path: '/erp/request', read: (id: string) => records.getPurchaseRequest(id) },
    { prefix: 'cust-', path: '/crm/customer', read: (id: string) => records.getCustomer(id) },
    { prefix: 'inv-', path: '/crm/invoice', read: (id: string) => records.getInvoice(id) },
    {
      prefix: 'run-',
      path: '/workflows/run',
      read: (id: string) => client.automation.getWorkflowHistory(id),
    },
  ];
  const lookup = validId(id)
    ? lookups.find(({ prefix }) => id.startsWith(prefix) && id.length > prefix.length)
    : undefined;
  function search() {
    if (!lookup) return;
    void action.run(
      async () => {
        await lookup.read(id);
      },
      () => navigate(lookup.path + '/' + encodeURIComponent(id)),
    );
  }
  useEffect(() => {
    input.current?.focus();
  }, []);
  return (
    <Dialog title={t('Command palette')} onClose={close}>
      <form
        className="bs-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (lookup) search();
          else if (matches.length === 1) matches[0].run();
        }}
      >
        <Field label={t('Search screens, commands or record IDs')}>
          {(props) => (
            <input
              className="bs-input"
              {...props}
              ref={input}
              type="search"
              value={query}
              maxLength={128}
              disabled={action.busy}
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
        </Field>
        {lookup && (
          <Button type="submit" disabled={action.busy}>
            {t('Find record {id}', { id })}
          </Button>
        )}
        {matches.length ? (
          <ul className="bs-command-list">
            {matches.map((command, index) => (
              <li key={index}>
                <Button variant="quiet" disabled={action.busy} onClick={command.run}>
                  {command.label}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          !lookup && <p>{t('No matching commands.')}</p>
        )}
      </form>
    </Dialog>
  );
}
