import type { FormEvent, ReactNode } from 'react';
import { Badge, Button, Card, Field, Input, Select, Table } from '../components.tsx';
import type { TableColumn } from '../components.tsx';
import { RemoteContent, useResource } from '../data.tsx';
import { useI18n } from '../i18n.tsx';

export function List<T extends { id: string }>({
  title,
  load,
  columns,
}: {
  title: string;
  load: ReturnType<typeof useResource<T[]>>;
  columns: TableColumn<T>[];
}) {
  const { t } = useI18n();
  return (
    <Card title={t(title)}>
      <RemoteContent resource={load} label={t(title)}>
        {(rows) => (
          <Table
            label={t(title)}
            rows={rows}
            columns={columns.map((column) => ({ ...column, title: t(column.title) }))}
            rowKey={(row) => row.id}
            empty={t('No entries.')}
          />
        )}
      </RemoteContent>
    </Card>
  );
}

export function Values<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
}) {
  const { t } = useI18n();
  return (
    <Field label={t(label)}>
      {(props) => (
        <Select
          {...props}
          value={value}
          onChange={(event) => {
            const selected = options.find((option) => option === event.target.value);
            if (selected !== undefined) onChange(selected);
          }}
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {t(option)}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

export function TextField({
  label,
  name,
  ...input
}: { label: string; name: string } & React.ComponentProps<typeof Input>) {
  const { t } = useI18n();
  return (
    <Field label={t(label)}>
      {(props) => <Input {...props} name={name} required {...input} />}
    </Field>
  );
}

export function Form({
  children,
  onSubmit,
}: {
  children: ReactNode;
  onSubmit: (data: FormData) => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(new FormData(event.currentTarget));
  }
  return (
    <form className="bs-feature-fields" onSubmit={submit}>
      {children}
    </form>
  );
}

export const field = (data: FormData, key: string) => String(data.get(key) ?? '').trim();

export function Status({ value, danger }: { value: string; danger?: boolean }) {
  const { t } = useI18n();
  return <Badge tone={danger ? 'danger' : 'accent'}>{t(value)}</Badge>;
}

export function Submit({ busy, label }: { busy?: boolean; label: string }) {
  const { t } = useI18n();
  return (
    <Button type="submit" disabled={busy}>
      {t(label)}
    </Button>
  );
}
