import { useCallback, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Card, Field, Input, Table } from '../components.tsx';
import type { TableColumn } from '../components.tsx';
import { validId } from '../clients/workflow-definition.ts';
import { RemoteContent, useResource } from '../data.tsx';

const money = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });
export const cad = (cents: number) => money.format(cents / 100);
export const routeLink = (path: string, id: string) => '#' + path + '/' + encodeURIComponent(id);
export function routeId(path: string) {
  try {
    return decodeURIComponent(path.split('/').at(-1) ?? '');
  } catch {
    return '';
  }
}

export function useRequestKey() {
  const attempt = useRef<{ input: string; key: string }>(null);
  const key = useCallback((input: unknown) => {
    const serialized = JSON.stringify(input);
    if (attempt.current?.input !== serialized)
      attempt.current = { input: serialized, key: crypto.randomUUID() };
    return attempt.current.key;
  }, []);
  const clear = useCallback(() => {
    attempt.current = null;
  }, []);
  return { key, clear };
}

export function ResourceTable<T>({
  label,
  resource,
  columns,
  rowKey,
}: {
  label: string;
  resource: ReturnType<typeof useResource<T[]>>;
  columns: TableColumn<T>[];
  rowKey: (row: T) => string;
}) {
  return (
    <Card title={label}>
      <RemoteContent resource={resource} label={label.toLowerCase()}>
        {(rows) => (
          <Table
            label={label}
            rows={rows}
            columns={columns}
            rowKey={rowKey}
            empty={'No ' + label.toLowerCase() + '.'}
          />
        )}
      </RemoteContent>
    </Card>
  );
}

export function Details({ fields }: { fields: [string, ReactNode][] }) {
  return (
    <dl className="bs-details">
      {fields.map(([label, value]) => (
        <div className="bs-detail-row" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function RecordLookup({ label, path }: { label: string; path: string }) {
  const [id, setId] = useState('');
  const value = id.trim();
  return (
    <form
      className="bs-feature-fields bs-lookup"
      onSubmit={(event) => {
        event.preventDefault();
        if (validId(value)) window.location.hash = routeLink(path, value);
      }}
    >
      <Field label={label + ' ID'}>
        {(props) => (
          <Input
            {...props}
            required
            maxLength={128}
            value={id}
            onChange={(event) => setId(event.target.value)}
          />
        )}
      </Field>
      <Button type="submit" variant="secondary" disabled={!validId(value)}>
        Open {label.toLowerCase()}
      </Button>
    </form>
  );
}
