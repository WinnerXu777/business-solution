import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  brandColors,
  HttpPlatformClient,
  MockOperationsState,
  MockPlatformClient,
  PlatformApp,
  PlatformError,
  translate,
} from '../src/index.ts';
import { messages } from '../src/messages.ts';
import type { WorkflowManagementClient } from '../src/clients/workflow-management.ts';

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function visit(path: string) {
  await act(async () => {
    window.history.pushState(null, '', '#' + path);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}
const click = (name: string | RegExp) =>
  screen.findByRole('button', { name }).then(fireEvent.click);
const type = (label: string | RegExp, value: string, root: HTMLElement = document.body) =>
  fireEvent.change(within(root).getByLabelText(label), { target: { value } });

test('contacts can be checked, consent withdrawn and suppressions added and removed', async () => {
  const client = new MockPlatformClient();
  render(<PlatformApp client={client} />);
  await visit('/compliance/contact-check');
  await screen.findByRole('heading', { name: 'Contact check', level: 1 });
  type('Contact ID', 'contact-001');
  await click('Check contact');
  await screen.findByText('Allowed');
  await visit('/compliance/consents');
  await click('Withdraw consent');
  await click('Confirm withdrawal');
  await screen.findByText('Consent withdrawn.');
  await visit('/compliance/contact-check');
  type('Contact ID', 'contact-001');
  await click('Check contact');
  await screen.findByText('Consent withdrawn', { selector: 'li' });
  await visit('/compliance/suppressions');
  const form = await screen.findByRole('button', { name: 'Add suppression' });
  type('Destination', 'billing@new-rivetquay.example');
  fireEvent.click(form);
  await screen.findByText('billing@new-rivetquay.example');
  const row = screen.getByText('billing@new-rivetquay.example').closest('tr')!;
  fireEvent.click(within(row).getByRole('button', { name: 'Remove suppression' }));
  await click('Confirm removal');
  await screen.findByText('Suppression removed.');
  await waitFor(() => expect(screen.queryByText('billing@new-rivetquay.example')).toBeNull());
});

test('privacy verifies identity, shows denied proof and blocks a held deletion', async () => {
  render(<PlatformApp client={new MockPlatformClient()} />);
  await visit('/compliance/privacy');
  await screen.findByRole('button', { name: 'Create request' });
  type('Subject ID', 'contact-001');
  type('Request type', 'deletion');
  await click('Create request');
  const dialog = await screen.findByRole('dialog', { name: /Privacy request privacy-/ });
  type('Proof reference', 'invalid-proof', dialog);
  await click('Verify identity');
  await screen.findByText('You don’t have permission to do this.');
  type('Proof reference', 'proof-contact-001', dialog);
  await click('Verify identity');
  await click('Complete request');
  await within(dialog).findByRole('list', { name: 'Retention blocks' });
  expect(within(dialog).getByText(/inv-001.*Retention hold/)).toBeDefined();
  await visit('/compliance/retention');
  await click('Run purge preview');
  await screen.findByText(/inv-001.*hold-001/);
});

test('webhook signing secret is one-time and a dead letter replays into one queued entry', async () => {
  const client = new MockPlatformClient();
  render(<PlatformApp client={client} />);
  await visit('/webhooks');
  await click('View deliveries');
  await click('Replay dead letter');
  await screen.findByText('Webhook replay queued.');
  const replay = (await client.eventing.listDeliveries('hook-001')).find(
    (delivery) => delivery.replayOf,
  );
  expect(replay?.status).toBe('queued');
  expect(await client.eventing.replayDelivery('delivery-001')).toEqual(replay);
  type('Endpoint URL', 'https://new.rivetquay.example/events');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Record changed' }));
  await click('Create endpoint');
  const dialog = await screen.findByRole('dialog', { name: 'Webhook signing secret' });
  expect(within(dialog).getByText(/fixture-secret-hook/)).toBeDefined();
  await click('Done');
  expect(screen.queryByText(/fixture-secret-hook/)).toBeNull();
  expect(JSON.stringify(await client.eventing.listWebhooks())).not.toContain('signingSecret');
  await click('Test endpoint');
  await screen.findByText('Webhook test queued.');
});

test('notifications show the unread count and preserve the read timestamp', async () => {
  const client = new MockPlatformClient({ role: 'reader' });
  render(<PlatformApp client={client} />);
  await click('Notifications (1)');
  await click('Mark read');
  const dialog = screen.getByRole('dialog', { name: 'Notifications' });
  await within(dialog).findByText('Read');
  await within(dialog).findByRole('button', { name: 'Close' }).then(fireEvent.click);
  expect(screen.getByRole('button', { name: 'Notifications' })).toBeDefined();
  const first = (await client.eventing.listNotifications())[0];
  expect(first.readAt).toBeTruthy();
  expect(await client.eventing.markRead(first.id)).toEqual(first);
});

test('procurement policy and three-way match show the approval thresholds and line discrepancy', async () => {
  const client = new MockPlatformClient();
  render(<PlatformApp client={client} />);
  await visit('/bots/procurement');
  await screen.findByLabelText('Authority limit (CAD)');
  type('Authority limit (CAD)', '24000');
  await click('Save policy');
  await screen.findByText('Bot policy saved.');
  expect(await client.botPolicies.getPolicy('procurement')).toMatchObject({
    authorityLimitCents: 2400000,
  });
  await visit('/bots/procurement/match/po-001');
  await screen.findByText('Mismatch');
  expect(screen.getByText(/Receipt.*receipt-001/)).toBeDefined();
});

test('collections commits a promise and sends a plan to a separate approver', async () => {
  const operationsState = new MockOperationsState();
  const client = new MockPlatformClient({ role: 'operator', operationsState });
  const reviewer = new MockPlatformClient({ role: 'approver', operationsState });
  const first = render(<PlatformApp client={client} />);
  await visit('/bots/collections/account/cust-001');
  await screen.findByText('inv-001');
  const promise = screen
    .getByRole('heading', { name: 'Record a promise to pay' })
    .closest('section')!;
  const plan = screen.getByRole('heading', { name: 'Request a payment plan' }).closest('section')!;
  for (const form of [promise, plan]) {
    type('Amount (CAD)', '1234.56', form);
    type('Due date', '2026-12-15', form);
  }
  await click('Record promise');
  await screen.findByText('Promise recorded.');
  await click('Request payment plan');
  await screen.findByText('Payment plan requested.');
  expect(screen.queryByRole('button', { name: 'Approve payment plan' })).toBeNull();
  const [requested] = await client.botPolicies.listPaymentPlans();
  await expect(client.botPolicies.approvePaymentPlan(requested.id)).rejects.toMatchObject({
    code: 'forbidden',
  });
  first.unmount();
  render(<PlatformApp client={reviewer} />);
  await click('Approve payment plan');
  await click('Confirm approval');
  await screen.findByText('Payment plan approved.');
  expect(await reviewer.botPolicies.listPaymentPlans()).toMatchObject([{ status: 'approved' }]);
  const other = new MockPlatformClient({ tenantId: 'tenant-spoolharbour', operationsState });
  expect(await other.botPolicies.listPaymentPlans()).toEqual([]);
});

test('templates preview and install drafts, validation flags nodes, triggers and diffs use the scoped client', async () => {
  const client = new MockPlatformClient();
  const api: WorkflowManagementClient = client.workflowManagement;
  vi.spyOn(api, 'validate').mockResolvedValue({
    issues: [{ nodeId: 'lookup', message: 'Connect to an existing node.' }],
  });
  render(<PlatformApp client={client} />);
  await visit('/workflows/templates');
  await click('Preview template');
  await screen.findByText(/Draft preview.*order-lookup/);
  await click('Install as draft');
  const link = await screen.findByRole('link', { name: /Open draft/ });
  await visit(link.getAttribute('href')!.slice(1));
  await click('Validate workflow');
  expect(
    (await screen.findByText(/lookup.*Invalid node/))
      .closest('.react-flow__node')
      ?.classList.contains('bs-flow-node-error'),
  ).toBe(true);
  await visit('/workflows/triggers');
  const triggers = await screen.findAllByRole('button', { name: 'Resume trigger' });
  fireEvent.click(triggers[0]);
  await screen.findByText('Trigger resumed.');
  await visit('/workflows/diff/win-back-v1');
  await click('Compare versions');
  await screen.findByText(/send.*Changed/);
});

test('ops is platform-operator only, including direct routes and mock reads', async () => {
  const tenantAdmin = new MockPlatformClient();
  const mounted = render(<PlatformApp client={tenantAdmin} />);
  await visit('/ops');
  await screen.findByRole('heading', { name: 'Page not found' });
  expect(screen.queryByRole('link', { name: 'Operations' })).toBeNull();
  await expect(tenantAdmin.ops.health()).rejects.toMatchObject({ code: 'forbidden' });
  mounted.unmount();
  render(
    <PlatformApp client={new MockPlatformClient({ role: 'reader', platformOperator: true })} />,
  );
  await screen.findByText('SLO burn rates');
  await screen.findByText('Ready');
  expect(await screen.findByText('Fixture queue delay')).toBeDefined();
});

test('locale catalogues agree on keys and interpolation; Settings persists French and tenant branding', async () => {
  const keys = Object.keys(messages['en-CA']).sort() as (keyof (typeof messages)['en-CA'])[];
  expect(Object.keys(messages['fr-CA']).sort()).toEqual(keys);
  for (const key of keys) {
    const tokens = (text: string) => [...text.matchAll(/\{\w+\}/g)].map(([token]) => token).sort();
    expect(messages['fr-CA'][key].trim()).not.toBe('');
    expect(tokens(messages['en-CA'][key])).toEqual(tokens(messages['fr-CA'][key]));
  }
  expect(translate('fr-CA', 'Find record {id}', { id: 'ord-001' })).toContain('ord-001');
  const first = render(<PlatformApp client={new MockPlatformClient()} />);
  await visit('/settings');
  await screen.findByLabelText('Product name');
  type('Product name', 'Quay Console');
  type('Accent colour', '#eeeeee');
  expect(brandColors('#eeeeee', 'light').ratio).toBeGreaterThanOrEqual(4.5);
  expect(brandColors('#eeeeee', 'dark').ratio).toBeGreaterThanOrEqual(4.5);
  await click('Save branding');
  expect(
    screen.getByRole('link', { name: 'Quay Console overview' }).closest('.bs-platform'),
  ).toHaveProperty('lang', 'en-CA');
  type('Display language', 'fr-CA');
  await screen.findByRole('heading', { name: 'Paramètres', level: 1 });
  first.unmount();
  render(
    <PlatformApp
      client={new MockPlatformClient({ role: 'reader', tenantId: 'tenant-spoolharbour' })}
    />,
  );
  await screen.findByRole('heading', { name: 'Paramètres', level: 1 });
  expect(screen.queryByRole('heading', { name: 'Image de marque du locataire' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Vue d’ensemble de Quay Console' })).toBeNull();
});

test('command palette filters restricted routes, searches known IDs and runs a theme action', async () => {
  const client = new MockPlatformClient({ role: 'reader' });
  render(<PlatformApp client={client} />);
  await screen.findByRole('button', { name: /Commands/ });
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  const palette = await screen.findByRole('dialog', { name: 'Command palette' });
  expect(within(palette).queryByRole('button', { name: 'Operations' })).toBeNull();
  expect(within(palette).queryByRole('button', { name: 'Run a contact check' })).toBeNull();
  type(/Search screens/, 'ord-001', palette);
  await click('Find record ord-001');
  await screen.findByRole('heading', { name: 'Order detail' });
  fireEvent.keyDown(window, { key: 'k', metaKey: true });
  await click('Toggle dark theme');
  expect(document.querySelector('.bs-platform')?.getAttribute('data-theme')).toBe('dark');
});

test('HTTP clients use documented routes, encoded IDs and the scoped transport', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response('{}'));
  const client = new HttpPlatformClient({ token: 'fixture-token', fetch });
  await client.compliance.checkContact({
    contactId: 'contact-001',
    channel: 'email',
    purpose: 'marketing',
  });
  await client.compliance.verifyPrivacyRequest('id/slash', 'proof-ref');
  await client.eventing.replayDelivery('id/slash');
  await client.botPolicies.getMatch('po/slash');
  await client.workflowManagement.diff('wf/slash', 1, 2);
  await client.workflowManagement.setTriggerPaused('id/slash', false);
  await client.ops.readiness();
  expect(fetch.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
    ['/platform/v1/contact-check', 'POST'],
    ['/platform/v1/privacy-requests/id%2Fslash/verify', 'POST'],
    ['/platform/v1/webhooks/deliveries/id%2Fslash/replay', 'POST'],
    ['/bots/procurement/matches/po%2Fslash', 'GET'],
    ['/workflows/wf%2Fslash/diff?from=1&to=2', 'GET'],
    ['/workflows/triggers/id%2Fslash/resume', 'POST'],
    ['/ops/ready', 'GET'],
  ]);
  expect(fetch.mock.calls[1][1]?.headers).toMatchObject({ Authorization: 'Bearer fixture-token' });
  expect(fetch.mock.calls[1][1]?.body).toBe(JSON.stringify({ proofRef: 'proof-ref' }));
  fetch.mockResolvedValueOnce(new Response('{"code":"forbidden"}', { status: 403 }));
  await expect(client.ops.alerts()).rejects.toBeInstanceOf(PlatformError);
});
