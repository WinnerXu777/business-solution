import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MockPlatformClient, PlatformApp, PlatformError } from '../src/index.ts';
import type { PlatformRouteContext } from '../src/index.ts';

beforeEach(() => {
  history.replaceState(null, '', '/');
  localStorage.clear();
});
afterEach(() => cleanup());

async function navigate(label: string, path: string) {
  const nav = within(screen.getByRole('navigation', { name: 'Platform navigation' }));
  const link = nav.getByRole('link', { name: label });
  expect(link.getAttribute('href')).toBe('#' + path);
  await act(async () => {
    history.pushState(null, '', '#' + path);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await screen.findByRole('heading', { level: 1, name: label });
  expect(link.getAttribute('aria-current')).toBe('page');
}

describe('platform app', () => {
  test('renders overview, injected screens, profile and persisted theme', async () => {
    const client = new MockPlatformClient();
    function Bots({ workspace }: PlatformRouteContext) {
      return <p>Injected bots for {workspace.id}</p>;
    }
    const { container, unmount } = render(
      <PlatformApp
        client={client}
        extraRoutes={[{ path: '/bots', title: 'Bots', component: Bots }]}
      />,
    );
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeDefined();
    expect(await screen.findByRole('table', { name: 'Module allowances' })).toBeDefined();
    expect(screen.getByRole('combobox', { name: 'Workspace' })).toHaveProperty(
      'value',
      'tenant-rivetquay',
    );
    expect(screen.getByText('admin')).toBeDefined();
    expect(screen.getByLabelText('User menu, Avery Chen')).toBeDefined();
    await navigate('Bots', '/bots');
    expect(screen.getByText('Injected bots for tenant-rivetquay')).toBeDefined();
    await navigate('Settings', '/settings');
    fireEvent.click(screen.getByRole('switch', { name: 'Dark theme' }));
    expect(container.querySelector('.bs-platform')?.getAttribute('data-theme')).toBe('dark');
    unmount();
    render(<PlatformApp client={client} />);
    expect(await screen.findByRole('switch', { name: 'Dark theme' })).toHaveProperty(
      'checked',
      true,
    );
  });

  test('requires confirmation before signing bound material', async () => {
    const client = new MockPlatformClient();
    render(<PlatformApp client={client} />);
    await navigate('Approvals', '/approvals');
    fireEvent.click(await screen.findByRole('button', { name: 'View approval win-back-v1' }));
    const drawer = screen.getByRole('dialog', { name: 'Approval details' });
    expect(within(drawer).getByLabelText('Bound material inputs').textContent).toContain(
      'cust-008',
    );
    expect(within(drawer).getByText('Expires (Toronto)')).toBeDefined();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Sign approval' }));
    expect(await client.getApprovals('pending')).toHaveLength(1);
    fireEvent.click(within(drawer).getByRole('button', { name: 'Confirm sign' }));
    expect(await screen.findByText('Approval signed.')).toBeDefined();
    expect(await screen.findByText('No pending approvals.')).toBeDefined();
    fireEvent.click(screen.getByRole('tab', { name: 'Approved' }));
    expect(await screen.findByRole('table', { name: 'approved approvals' })).toBeDefined();
  });

  test('rejects as the designated approver and requires a reason', async () => {
    const client = new MockPlatformClient({ role: 'approver' });
    const reject = vi.spyOn(client, 'rejectApproval');
    render(<PlatformApp client={client} />);
    await navigate('Approvals', '/approvals');
    fireEvent.click(await screen.findByRole('button', { name: /View approval/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject approval' }));
    const confirm = screen.getByRole('button', { name: 'Confirm reject' });
    expect(confirm).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Review the audience again.' },
    });
    fireEvent.click(confirm);
    expect(await screen.findByText('Approval rejected.')).toBeDefined();
    expect(reject).toHaveBeenCalledWith('approval-workflow-001', 'Review the audience again.');
  });

  test('changes a binding with a credential reference and fallback', async () => {
    const client = new MockPlatformClient();
    render(<PlatformApp client={client} />);
    await navigate('Providers', '/providers');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Change provider for Language models' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Change provider for Language models' });
    fireEvent.change(await within(dialog).findByLabelText('Provider'), {
      target: { value: 'openai' },
    });
    expect(within(dialog).getByRole('button', { name: 'Save binding' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.change(within(dialog).getByLabelText('Credential reference'), {
      target: { value: 'fixture/llm' },
    });
    fireEvent.change(within(dialog).getByLabelText('Fallback provider'), {
      target: { value: 'fixture-native' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save binding' }));
    expect(await screen.findByText('Provider binding updated.')).toBeDefined();
    const llmRow = await screen.findByRole('row', { name: /Language models openai/ });
    expect(within(llmRow).getByText('BYO')).toBeDefined();
    expect(within(llmRow).getByText(/Version 2.*fixture-native/)).toBeDefined();
    expect((await client.getAudit()).items[0].tool).toBe('platform.capabilities.bind');
  });

  test('gates write controls for a reader', async () => {
    const client = new MockPlatformClient({ role: 'reader' });
    render(<PlatformApp client={client} />);
    await navigate('Providers', '/providers');
    expect(await screen.findByText('Language models')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Change provider/ })).toBeNull();
    await navigate('Modules and billing', '/modules');
    expect(await screen.findByText('Business records')).toBeDefined();
    expect(screen.queryByRole('switch')).toBeNull();
    await navigate('Connections', '/connections');
    expect(await screen.findByText('Warehouse console')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Revoke|New connection/ })).toBeNull();
    await navigate('Approvals', '/approvals');
    fireEvent.click(await screen.findByRole('button', { name: /View approval/ }));
    expect(screen.queryByRole('button', { name: 'Sign approval' })).toBeNull();
  });

  test('updates module access and pages filtered audit results', async () => {
    const client = new MockPlatformClient();
    for (let index = 0; index < 10; index += 1) {
      await client.updateModule('ai', true);
    }
    render(<PlatformApp client={client} />);
    await navigate('Modules and billing', '/modules');
    const toggle = await screen.findByRole('switch', { name: 'Enable AI services' });
    fireEvent.click(toggle);
    expect(await screen.findByText('AI services disabled.')).toBeDefined();
    await waitFor(() => expect(toggle).toHaveProperty('checked', false));
    await navigate('Audit log', '/audit');
    fireEvent.change(screen.getByLabelText('Tool'), {
      target: { value: 'platform.modules.update' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    const audit = await screen.findByRole('table', { name: 'Audit events' });
    expect(within(audit).getAllByText('platform.modules.update')).toHaveLength(10);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Page 2')).toBeDefined();
    expect(screen.getAllByText('platform.modules.update')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('Page 1')).toBeDefined();
  });

  test('shows a retryable read failure and loads usage after retry', async () => {
    const client = new MockPlatformClient();
    vi.spyOn(client, 'getUsage').mockRejectedValueOnce(new PlatformError('unavailable'));
    render(<PlatformApp client={client} />);
    await navigate('Usage', '/usage');
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('table', { name: 'Usage events' })).toBeDefined();
  });

  test('displays server denial as a dismissible toast inside the active dialog', async () => {
    const client = new MockPlatformClient();
    vi.spyOn(client, 'signApproval').mockRejectedValueOnce(new PlatformError('invalid_approval'));
    render(<PlatformApp client={client} />);
    await navigate('Approvals', '/approvals');
    fireEvent.click(await screen.findByRole('button', { name: /View approval/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign approval' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm sign' }));
    const dialog = within(screen.getByRole('dialog'));
    expect((await dialog.findByRole('alert')).textContent).toContain('no longer valid');
    fireEvent.click(dialog.getByRole('button', { name: 'Dismiss notification' }));
    expect(dialog.queryByRole('alert')).toBeNull();
  });

  test('reveals the secret once and confirms revocation', async () => {
    const client = new MockPlatformClient();
    render(<PlatformApp client={client} />);
    await navigate('Connections', '/connections');
    fireEvent.click(screen.getByRole('button', { name: 'New connection' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Fixture automation' } });
    fireEvent.change(screen.getByLabelText('Scopes'), {
      target: { value: 'records:read, workflows:read' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create client' }));
    const reveal = await screen.findByRole('dialog', { name: 'Connection secret' });
    expect(within(reveal).getByLabelText('Connection secret').textContent).toBe(
      'fixture-only-secret-1',
    );
    fireEvent.click(within(reveal).getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('fixture-only-secret-1')).toBeNull();
    const rows = await client.getConnections();
    expect(rows.find((row) => row.name === 'Fixture automation')).not.toHaveProperty('secret');
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke Fixture automation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoke' }));
    await waitFor(() => expect(screen.queryByText('Fixture automation')).toBeNull());
    expect(await screen.findByText('Connection revoked.')).toBeDefined();
  });

  test('scopes workspace changes through the host resolver', async () => {
    const first = new MockPlatformClient();
    const second = new MockPlatformClient({ tenantId: 'tenant-spoolharbour' });
    const original = await first.getMe();
    const { tenant } = await second.getMe();
    vi.spyOn(first, 'getMe').mockResolvedValue({
      ...original,
      workspaces: [...original.workspaces, tenant],
    });
    vi.spyOn(first, 'getWorkspace').mockResolvedValue(tenant);
    const resolver = vi.fn(async () => second);
    render(<PlatformApp client={first} resolveWorkspaceClient={resolver} />);
    const select = await screen.findByRole('combobox', { name: 'Workspace' });
    fireEvent.change(select, { target: { value: tenant.id } });
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Workspace' })).toHaveProperty(
        'value',
        tenant.id,
      ),
    );
    expect(resolver).toHaveBeenCalledWith(tenant);
    expect(await screen.findByText('No audit activity yet.')).toBeDefined();
  });
});
