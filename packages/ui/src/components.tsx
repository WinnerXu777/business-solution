import { useEffect, useId, useRef, useState } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

export function Button({
  variant = 'primary',
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'quiet';
}) {
  return (
    <button type={type} className={`bs-button bs-button--${variant} ${className}`} {...props} />
  );
}

export function IconButton({
  label,
  children,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & { label: string }) {
  return (
    <Button {...props} variant="quiet" className="bs-icon-button" aria-label={label} title={label}>
      {children}
    </Button>
  );
}

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={'bs-input ' + className} {...props} />;
}

export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={'bs-input ' + className} {...props} />;
}

export function Textarea({
  className = '',
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={'bs-input ' + className} {...props} />;
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (attributes: {
    id: string;
    'aria-describedby'?: string;
    'aria-invalid'?: true;
  }) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="bs-field">
      <label htmlFor={id}>{label}</label>
      {children({
        id,
        'aria-describedby': error || hint ? id + '-detail' : undefined,
        'aria-invalid': error ? true : undefined,
      })}
      {(error || hint) && (
        <small className={error ? 'bs-text-danger' : 'bs-muted'} id={id + '-detail'}>
          {error ?? hint}
        </small>
      )}
    </div>
  );
}

export function Switch({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="bs-switch">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={'bs-card ' + className}>
      {(title || action) && (
        <header className="bs-card-heading">
          {title && <h2>{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'accent';
}) {
  return <span className={`bs-badge bs-badge--${tone}`}>{children}</span>;
}

export function StatusPill({ status }: { status: string }) {
  const tone = ['active', 'approved', 'consumed', 'enabled', 'ok'].includes(status)
    ? 'success'
    : ['pending', 'pending_approval', 'unknown', 'expired'].includes(status)
      ? 'warning'
      : ['error', 'denied', 'rejected', 'failed'].includes(status)
        ? 'danger'
        : 'neutral';
  return <Badge tone={tone}>{status.replaceAll('_', ' ')}</Badge>;
}

export interface TableColumn<Row> {
  key: string;
  title: string;
  render: (row: Row) => ReactNode;
  sortValue?: (row: Row) => string | number;
}

export function Table<Row>({
  label,
  rows,
  columns,
  rowKey,
  pageSize = 10,
  empty = 'No matching records.',
}: {
  label: string;
  rows: readonly Row[];
  columns: readonly TableColumn<Row>[];
  rowKey: (row: Row) => string;
  pageSize?: number;
  empty?: string;
}) {
  const [sort, setSort] = useState<{ key: string; descending: boolean }>();
  const [page, setPage] = useState(0);
  const sortValue = columns.find((column) => column.key === sort?.key)?.sortValue;
  const ordered = sortValue
    ? [...rows].sort((left, right) => {
        const a = sortValue(left);
        const b = sortValue(right);
        const comparison =
          typeof a === 'number' && typeof b === 'number'
            ? a - b
            : String(a).localeCompare(String(b), undefined, { numeric: true });
        return sort?.descending ? -comparison : comparison;
      })
    : rows;
  const size = Math.max(1, Math.trunc(pageSize));
  const pages = Math.max(1, Math.ceil(ordered.length / size));
  const current = Math.min(page, pages - 1);
  if (!rows.length) return <EmptyState title={empty} />;
  return (
    <div>
      <div className="bs-table-scroll" tabIndex={0} role="region" aria-label={label + ' table'}>
        <table className="bs-table" aria-label={label}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={
                    column.key === sort?.key
                      ? sort.descending
                        ? 'descending'
                        : 'ascending'
                      : undefined
                  }
                >
                  {column.sortValue ? (
                    <Button
                      variant="quiet"
                      onClick={() => {
                        setSort({
                          key: column.key,
                          descending: sort?.key === column.key && !sort.descending,
                        });
                        setPage(0);
                      }}
                    >
                      {column.title}
                      <span aria-hidden="true">
                        {sort?.key === column.key ? (sort.descending ? '↓' : '↑') : '↕'}
                      </span>
                    </Button>
                  ) : (
                    column.title
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ordered.slice(current * size, (current + 1) * size).map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((column) => (
                  <td key={column.key}>{column.render(row)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="bs-pagination">
          <span role="status">
            Page {current + 1} of {pages}
          </span>
          <Button variant="secondary" disabled={current === 0} onClick={() => setPage(current - 1)}>
            Previous
          </Button>
          <Button
            variant="secondary"
            disabled={current + 1 === pages}
            onClick={() => setPage(current + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

export function Tabs({
  label,
  tabs,
  value,
  onChange,
}: {
  label: string;
  tabs: readonly { id: string; label: string; content: ReactNode }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const id = useId();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  return (
    <>
      <div className="bs-tabs" role="tablist" aria-label={label}>
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={id + '-tab-' + tab.id}
            aria-selected={value === tab.id}
            className="bs-tab"
            tabIndex={value === tab.id ? 0 : -1}
            aria-controls={id + '-panel-' + tab.id}
            ref={(element) => {
              if (element) buttons.current.set(tab.id, element);
              else buttons.current.delete(tab.id);
            }}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              const movement = {
                ArrowRight: (index + 1) % tabs.length,
                ArrowLeft: (index + tabs.length - 1) % tabs.length,
                Home: 0,
                End: tabs.length - 1,
              };
              if (!Object.hasOwn(movement, event.key)) return;
              event.preventDefault();
              const next = tabs[movement[event.key as keyof typeof movement]].id;
              onChange(next);
              buttons.current.get(next)?.focus();
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          tabIndex={0}
          id={id + '-panel-' + tab.id}
          aria-labelledby={id + '-tab-' + tab.id}
          hidden={value !== tab.id}
        >
          {value === tab.id && tab.content}
        </div>
      ))}
    </>
  );
}

interface DialogProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}

function Overlay({ title, children, onClose, busy, drawer }: DialogProps & { drawer?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const opener = document.activeElement;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    if (!dialog.contains(document.activeElement)) close.current?.focus();
    return () => {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={drawer ? 'bs-overlay bs-drawer' : 'bs-overlay'}
      aria-labelledby={id}
      aria-modal="true"
      onKeyDown={(event) => {
        const dialog = event.currentTarget;
        if ((event.target as HTMLElement).closest('dialog') !== dialog) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          if (!busy) onClose();
        }
        if (event.key !== 'Tab') return;
        const controls = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            'a[href], button, input, select, textarea, summary, [tabindex]',
          ),
        ).filter(
          (element) =>
            element.tabIndex >= 0 &&
            !element.matches(':disabled, input[type="hidden"]') &&
            !element.closest('[hidden], [inert]') &&
            element.closest('dialog') === dialog,
        );
        const first = controls[0];
        const last = controls.at(-1);
        const active = document.activeElement;
        if (
          !first ||
          !controls.includes(active as HTMLElement) ||
          active === (event.shiftKey ? first : last)
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="bs-overlay-heading">
        <h2 id={id}>{title}</h2>
        <button
          ref={close}
          className="bs-button bs-button--quiet bs-icon-button"
          type="button"
          aria-label="Close"
          title="Close"
          disabled={busy}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function Dialog(props: DialogProps) {
  return <Overlay {...props} />;
}
export function Drawer(props: DialogProps) {
  return <Overlay {...props} drawer />;
}

export function Toast({
  message,
  tone = 'success',
  onDismiss,
}: {
  message: string;
  tone?: 'success' | 'danger';
  onDismiss: () => void;
}) {
  return (
    <div className={`bs-toast bs-toast--${tone}`}>
      <span role={tone === 'danger' ? 'alert' : 'status'}>{message}</span>
      <IconButton label="Dismiss notification" onClick={onDismiss}>
        ×
      </IconButton>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="bs-empty">
      <strong>{title}</strong>
      {children && <div>{children}</div>}
    </div>
  );
}

export function Skeleton({ label = 'Loading', lines = 3 }: { label?: string; lines?: number }) {
  return (
    <div className="bs-skeleton" role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} />
      ))}
    </div>
  );
}

export function CodeBlock({ children, label }: { children: string; label?: string }) {
  return (
    <pre className="bs-code" tabIndex={0} aria-label={label}>
      <code>{children}</code>
    </pre>
  );
}
