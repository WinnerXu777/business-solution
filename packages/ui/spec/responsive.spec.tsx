import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { Button, Drawer, MockPlatformClient, PlatformApp } from '../src/index.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

test.each([375, 768])(
  'renders key screens and keeps controls keyboard reachable at %ipx',
  async (width) => {
    vi.stubGlobal('innerWidth', width);
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 850px)' && window.innerWidth <= 850,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    render(<PlatformApp client={new MockPlatformClient({ platformOperator: true })} />);
    await screen.findByRole('heading', { name: 'First-run setup' });
    const menu = screen.getByRole('button', { name: 'Menu' });
    expect(screen.queryByRole('navigation', { name: 'Platform navigation' })).toBeNull();
    for (const [label, landmark] of [
      ['Conversations', 'Chat and voice inbox'],
      ['LLM playground', 'Completion request'],
      ['Tenants', 'Platform tenants'],
      ['Members', 'Workspace members'],
    ]) {
      fireEvent.click(menu);
      expect(menu.getAttribute('aria-expanded')).toBe('true');
      const link = screen.getByRole('link', { name: label });
      fireEvent.click(link);
      expect(await screen.findByRole('heading', { name: landmark })).toBeTruthy();
      expect(menu.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: label, level: 1 }));
    }
    const trigger = screen.getByRole('button', { name: 'Invite member' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = within(screen.getByRole('dialog', { name: 'Invite member' }));
    const first = dialog.getByRole('button', { name: 'Close' });
    const last = dialog.getByRole('button', { name: 'Create invitation' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  },
);

test('wraps drawer focus and restores the opener on dismissal', () => {
  function Sample() {
    const [open, setOpen] = useState(false);
    const close = () => setOpen(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open transcript</Button>
        {open && (
          <Drawer title="Transcript" onClose={close}>
            <Button onClick={close}>Done</Button>
          </Drawer>
        )}
      </>
    );
  }
  render(<Sample />);
  const opener = screen.getByRole('button', { name: 'Open transcript' });
  opener.focus();
  fireEvent.click(opener);
  const done = screen.getByRole('button', { name: 'Done' });
  done.focus();
  fireEvent.keyDown(done, { key: 'Tab' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(done);
  expect(document.activeElement).toBe(opener);
});
