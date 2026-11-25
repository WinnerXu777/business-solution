import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test } from 'vitest';
import { Button, Dialog, Field, Input, Table, Tabs } from '../src/index.ts';

afterEach(() => cleanup());

test('associates a field with its label and error', () => {
  render(
    <Field label="Credential reference" error="A reference is required.">
      {(props) => <Input {...props} />}
    </Field>,
  );
  const input = screen.getByRole('textbox', { name: 'Credential reference' });
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe(
    'A reference is required.',
  );
});

test('sorts table values and paginates the sorted rows', () => {
  const rows = [{ name: 'Zinc' }, { name: 'Aluminum' }, { name: 'Brass' }];
  render(
    <Table
      label="Stock"
      rows={rows}
      rowKey={(row) => row.name}
      pageSize={2}
      columns={[
        { key: 'name', title: 'Name', sortValue: (row) => row.name, render: (row) => row.name },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Name' }));
  expect(screen.getByRole('columnheader').getAttribute('aria-sort')).toBe('ascending');
  expect(screen.getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
    'Aluminum',
    'Brass',
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByRole('cell').textContent).toBe('Zinc');
});

test('supports keyboard tab selection and dialog focus restoration', () => {
  function Demo() {
    const [tab, setTab] = useState('first');
    const [open, setOpen] = useState(false);
    return (
      <>
        <Tabs
          label="Sections"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'first', label: 'First', content: 'First panel' },
            {
              id: 'second',
              label: 'Second',
              content: <Button onClick={() => setOpen(true)}>Open dialog</Button>,
            },
          ]}
        />
        {open && (
          <Dialog title="Confirm" onClose={() => setOpen(false)}>
            Review the action.
          </Dialog>
        )}
      </>
    );
  }
  render(<Demo />);
  const first = screen.getByRole('tab', { name: 'First' });
  first.focus();
  fireEvent.keyDown(first, { key: 'ArrowRight' });
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Second' }));
  const trigger = screen.getByRole('button', { name: 'Open dialog' });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Confirm' });
  const close = within(dialog).getByRole('button', { name: 'Close' });
  expect(document.activeElement).toBe(close);
  fireEvent.click(close);
  expect(document.activeElement).toBe(trigger);
});
