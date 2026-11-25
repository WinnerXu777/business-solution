import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  MockAutomationState,
  MockPlatformClient,
  MockRecordsState,
  PlatformApp,
  PlatformError,
} from '../src/index.ts';

beforeEach(() => {
  history.replaceState(null, '', '/');
  sessionStorage.clear();
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(path: string, client = new MockPlatformClient()) {
  history.replaceState(null, '', '#' + path);
  return { ...render(<PlatformApp client={client} />), client };
}

async function navigate(path: string) {
  await act(async () => {
    history.pushState(null, '', '#' + path);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function click(name: string | RegExp) {
  fireEvent.click(await screen.findByRole('button', { name }));
}

test('groups each entry in the requested sidebar and hides detail routes from the sidebar', async () => {
  mount('/');
  await screen.findByRole('heading', { level: 1, name: 'Overview' });
  const nav = within(screen.getByRole('navigation', { name: 'Platform navigation' }));
  const links = (label: string) =>
    within(nav.getByRole('group', { name: label }))
      .getAllByRole('link')
      .map((item) => item.textContent?.slice(1));
  expect(links('Operate')).toEqual(['Overview', 'Approvals', 'Bots', 'Workflows']);
  expect(links('Records')).toEqual(['ERP', 'CRM']);
  expect(links('Intelligence')).toEqual(['Insights']);
  expect(links('Platform')).toEqual([
    'Connectors',
    'Providers',
    'Credentials',
    'Modules and billing',
    'Connections',
    'Audit log',
    'Usage',
    'Settings',
  ]);
  await navigate('/billing');
  expect(nav.getByRole('link', { name: 'Modules and billing' }).getAttribute('aria-current')).toBe(
    'page',
  );
});

test('starts a bot, streams an approval interrupt and retains requester history across routes', async () => {
  const state = new MockAutomationState();
  const operator = new MockPlatformClient({ role: 'operator', automationState: state });
  const approver = new MockPlatformClient({ role: 'approver', automationState: state });
  const requester = mount('/bots', operator);
  await screen.findByRole('table', { name: 'Bot versions' });
  change('Run prompt', 'Draft PO for pr-001');
  await click('Start run');
  const handoff = await screen.findByLabelText('Approval handoff IDs');
  const ids = handoff.textContent!;
  const [runId] = ids.split(' ');
  expect(screen.getByLabelText('Bot approval material').textContent).toContain('vendor-002');
  expect(
    within(screen.getByRole('list', { name: 'Bot events' })).getByText('approval required'),
  ).toBeDefined();
  await navigate('/');
  await navigate('/bots');
  expect(
    within(await screen.findByRole('list', { name: 'Bot run history' })).getByRole('button', {
      name: runId,
    }),
  ).toBeDefined();
  requester.unmount();

  const reviewer = mount('/bots', approver);
  await screen.findByLabelText('Run and approval IDs');
  expect(screen.queryByRole('button', { name: 'Start run' })).toBeNull();
  change('Run and approval IDs', ids);
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'I reviewed the bound approval material.' }),
  );
  await click('Approve and resume assigned run');
  expect(await screen.findByText('Approval submitted.')).toBeDefined();
  reviewer.unmount();

  mount('/bots', operator);
  const historyList = within(await screen.findByRole('list', { name: 'Bot run history' }));
  fireEvent.click(historyList.getByRole('button', { name: runId }));
  expect(
    within(await screen.findByRole('list', { name: 'Bot events' })).getByText('resumed'),
  ).toBeDefined();
  expect((await screen.findByLabelText('Run result')).textContent).toContain(
    'fixture run completed',
  );
});

test('cancels a paused run and reconnects after the last event ID', async () => {
  const client = new MockPlatformClient({ role: 'operator' });
  const stream = vi.spyOn(client.automation, 'streamBot');
  mount('/bots', client);
  await screen.findByRole('table', { name: 'Bot versions' });
  change('Run prompt', 'Draft PO for pr-001');
  await click('Start run');
  await screen.findByLabelText('Approval handoff IDs');
  await click('Cancel run');
  await waitFor(() => {
    const calls = stream.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.at(-1)?.[1]).toBeGreaterThan(0);
  });
  expect((await screen.findAllByText('cancelled')).length).toBeGreaterThanOrEqual(1);
  expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull();
});

test('previews win-back messages without starting a run, then runs and reviews the timeline', async () => {
  const state = new MockAutomationState();
  const client = new MockPlatformClient({ role: 'operator', automationState: state });
  const launch = vi.spyOn(client.automation, 'startWorkflow');
  const operator = mount('/workflows', client);
  await click('Preview published v1');
  const preview = within(await screen.findByRole('region', { name: 'Workflow preview' }));
  expect(preview.getByText('No messages sent.')).toBeDefined();
  expect(preview.getByText(/cust-008/)).toBeDefined();
  expect(preview.getByText(/cust-009/)).toBeDefined();
  expect(preview.queryByText(/cust-010/)).toBeNull();
  expect(launch).not.toHaveBeenCalled();

  await click('Run published v1');
  expect(await screen.findByRole('heading', { name: 'Workflow run', level: 1 })).toBeDefined();
  const timeline = within(await screen.findByRole('list', { name: 'Workflow history' }));
  expect(timeline.getByText('approval required')).toBeDefined();
  const targetPath = window.location.hash.slice(1);
  const [row] = (await client.automation.listWorkflowRuns()).filter(
    (run) => run.status === 'pending_approval',
  );
  expect(row.approval?.approverId).toBe('actor-approver');

  operator.unmount();
  const reviewer = mount(
    '/workflows',
    new MockPlatformClient({ role: 'approver', automationState: state }),
  );
  const inbox = within(await screen.findByRole('table', { name: 'Assigned workflow approvals' }));
  fireEvent.click(inbox.getByRole('button', { name: row.approval?.subjectId }));
  expect((await screen.findByLabelText('Bound message previews')).textContent).toContain(
    'cust-008',
  );
  await click('Approve workflow');
  expect(await screen.findByText('Workflow approval submitted.')).toBeDefined();
  reviewer.unmount();

  mount(targetPath, client);
  expect(
    within(await screen.findByRole('list', { name: 'Workflow history' })).getByText('approved'),
  ).toBeDefined();
  await navigate('/workflows/runs');
  expect(await screen.findByRole('link', { name: row.id })).toBeDefined();
});

test('adds and connects a configured workflow node, validates it, and publishes a version', async () => {
  const { client } = mount('/workflows', new MockPlatformClient({ role: 'operator' }));
  await click('Add node');
  expect(screen.getByRole('button', { name: 'Publish version' })).toHaveProperty('disabled', true);
  change('Field mappings', '{oops');
  change('Inspect node', 'manual');
  change('Next node', 'mapping-1');
  change('Inspect node', 'mapping-1');
  expect(screen.getByLabelText('Field mappings')).toHaveProperty('value', '{oops');
  change('Field mappings', '{"eligible":true}');
  change('Next node', 'approve');
  expect(screen.getByRole('button', { name: 'Publish version' })).toHaveProperty('disabled', false);
  await click('Publish version');
  expect(await screen.findByText('Workflow version published.')).toBeDefined();
  expect(
    (await client.automation.listDefinitions()).find((row) => row.version === 2)?.nodes,
  ).toContainEqual({
    id: 'mapping-1',
    kind: 'mapping',
    values: { eligible: true },
    next: 'approve',
  });
  expect(await screen.findByRole('option', { name: 'win-back-v1 · v2' })).toBeDefined();
});

test('replays a failed workflow and removes it from dead letters', async () => {
  const { client } = mount('/workflows/dead-letters', new MockPlatformClient({ role: 'operator' }));
  await click(/^Replay workflow-dead-letter/);
  expect(await screen.findByText('Workflow replay started.')).toBeDefined();
  expect(await screen.findByText('No dead letters.')).toBeDefined();
  const [run] = await client.automation.listWorkflowRuns();
  expect(
    (await client.automation.getWorkflowHistory(run.id)).history.map((event) => event.kind),
  ).toEqual(['failed', 'replayed', 'completed']);
});

test('opens governed orders, inventory and vendor views', async () => {
  mount('/erp', new MockPlatformClient({ role: 'reader' }));
  const orderTable = within(await screen.findByRole('table', { name: 'Orders' }));
  expect(orderTable.getByRole('link', { name: 'ord-001' }).getAttribute('href')).toBe(
    '#/erp/order/ord-001',
  );
  await navigate('/erp/order/ord-001');
  expect(await screen.findByRole('table', { name: 'Order lines' })).toBeDefined();
  await navigate('/erp/inventory');
  expect(
    within(await screen.findByRole('table', { name: 'Inventory' })).getByRole('row', {
      name: /sku-001/,
    }),
  ).toBeDefined();
  expect(screen.getByRole('columnheader', { name: /On hand/ })).toBeDefined();
  await navigate('/erp/vendors');
  expect(
    within(await screen.findByRole('table', { name: 'Vendors' })).getByText('vendor-002'),
  ).toBeDefined();
});

test('drafts a purchase order as the operator and approves its exact draft as the assigned approver', async () => {
  const state = new MockRecordsState();
  const operator = mount(
    '/erp/purchase-requests',
    new MockPlatformClient({ role: 'operator', recordsState: state }),
  );
  expect(
    within(await screen.findByRole('table', { name: 'Purchase requests' })).getByRole('link', {
      name: 'pr-001',
    }),
  ).toBeDefined();
  await navigate('/erp/request/pr-001');
  await click('Draft purchase order');
  expect(await screen.findByText('Draft created for approval.')).toBeDefined();
  const [item] = await operator.client.records.listPurchaseDrafts();
  expect(item.draft.vendorId).toBe('vendor-002');
  await expect(
    operator.client.records.approvePurchaseOrder(item.draft.id, item.approval.id, 'retry-key'),
  ).rejects.toMatchObject({ code: 'forbidden' });
  operator.unmount();

  const reviewer = mount(
    '/erp/purchase-requests',
    new MockPlatformClient({ role: 'approver', recordsState: state }),
  );
  await click(item.draft.id);
  const dialog = within(screen.getByRole('dialog', { name: 'Review purchase order draft' }));
  expect(dialog.getByText('vendor-002')).toBeDefined();
  fireEvent.click(dialog.getByRole('button', { name: 'Approve purchase order' }));
  expect(await screen.findByRole('table', { name: 'Purchase orders' })).toBeDefined();
  const [po] = await reviewer.client.records.listPurchaseOrders();
  expect(po.approvalId).toBe(item.approval.id);
  await click(po.id);
  expect(
    within(screen.getByRole('dialog', { name: po.id })).getByRole('table', {
      name: 'Purchase lines',
    }),
  ).toBeDefined();
});

test('shows CRM customers, contacts, pipeline stages, consent and governed customer history', async () => {
  mount('/crm', new MockPlatformClient({ role: 'reader' }));
  expect(
    within(await screen.findByRole('table', { name: 'Customers' })).getAllByRole('link').length,
  ).toBeGreaterThan(0);
  await navigate('/crm/contacts');
  expect(await screen.findByRole('table', { name: 'Contacts' })).toBeDefined();
  await navigate('/crm/pipeline');
  expect(await screen.findByRole('region', { name: 'qualified' })).toBeDefined();
  await navigate('/crm/customer/cust-001');
  expect(await screen.findByRole('table', { name: 'Order history' })).toBeDefined();
  await navigate('/crm/customer/cust-002');
  expect(
    within(await screen.findByRole('table', { name: 'Invoice history' })).getByRole('link', {
      name: 'inv-001',
    }),
  ).toBeDefined();
  await navigate('/crm/customer/cust-010');
  const consent = within(await screen.findByRole('table', { name: 'Consent and suppression' }));
  expect(consent.getAllByText('suppressed')).toHaveLength(3);
  await navigate('/crm/invoice/inv-001');
  expect(await screen.findByText('overdue')).toBeDefined();
});

test('reviews fraud with both scores and reasons and displays a denied mutation toast', async () => {
  const client = new MockPlatformClient({ role: 'approver' });
  vi.spyOn(client.insights, 'reviewFraud').mockRejectedValueOnce(new PlatformError('forbidden'));
  mount('/insights', client);
  const queue = within(await screen.findByRole('table', { name: 'Fraud review queue' }));
  expect(queue.getByRole('columnheader', { name: 'Rule score' })).toBeDefined();
  expect(queue.getByRole('columnheader', { name: 'Model score' })).toBeDefined();
  expect(queue.getByRole('link', { name: 'ord-004' })).toBeDefined();
  await click('Review ord-003');
  const review = within(screen.getByRole('dialog', { name: 'Review ord-003' }));
  expect(review.getByText('Rule reasons')).toBeDefined();
  fireEvent.click(review.getByRole('button', { name: 'Escalate order' }));
  expect((await review.findByRole('alert')).textContent).toContain('permission');
  fireEvent.click(review.getByRole('button', { name: 'Clear order' }));
  expect(await screen.findByText('Fraud review recorded.')).toBeDefined();
  const order = (await client.insights.listFraudQueue()).find((item) => item.orderId === 'ord-003');
  expect(order?.decision).toBe('clear');
});

test('plots forecast bounds and handles sparse history', async () => {
  const { client } = mount('/insights/forecast');
  await click('Load forecast');
  expect(
    await screen.findByRole('img', { name: /forecast estimate with upper and lower bounds/i }),
  ).toBeDefined();
  const values = within(await screen.findByRole('table', { name: 'Forecast values' }));
  expect(values.getAllByRole('row')).toHaveLength(5);
  const sparse = (await client.records.listInventory()).find((item) => item.id !== 'sku-001');
  expect(sparse).toBeDefined();
  change('SKU ID', sparse!.id);
  await click('Load forecast');
  expect(await screen.findByText('Insufficient history to forecast.')).toBeDefined();
});

test('shows profile citations and records an approver decision', async () => {
  const { client } = mount(
    '/insights/profile/cust-008',
    new MockPlatformClient({ role: 'approver' }),
  );
  expect(await screen.findByRole('heading', { name: 'Evidence citations' })).toBeDefined();
  expect(screen.getByRole('link', { name: 'cust-008' })).toBeDefined();
  await click('Accept profile');
  expect(await screen.findByText('Profile review recorded.')).toBeDefined();
  expect((await client.insights.profile('cust-008')).reviewStatus).toBe('accepted');
});

test('changes the add-on plan, displays invoice line items and HST, and finalizes a closed invoice', async () => {
  const { client } = mount('/billing');
  expect(await screen.findByRole('table', { name: 'Billing SKUs' })).toBeDefined();
  fireEvent.click(screen.getByRole('checkbox', { name: /Native or connected ERP/ }));
  await click('Change plan');
  expect(await screen.findByText('Billing plan changed.')).toBeDefined();
  expect((await client.billing.getPlan())?.addOns).toEqual(['erp']);
  const [row] = (await client.billing.listInvoices()).items;
  const table = within(await screen.findByRole('table', { name: 'Billing invoices' }));
  expect(table.getByRole('link', { name: row.id }).getAttribute('href')).toBe(
    '#/billing/invoice/' + row.id,
  );
  await navigate('/billing/invoice/' + row.id);
  expect(await screen.findByRole('table', { name: 'Billing line items' })).toBeDefined();
  expect(screen.getByText('HST')).toBeDefined();
  await click('Finalize invoice');
  await click('Confirm finalize');
  expect(await screen.findByText('Invoice finalized.')).toBeDefined();
  expect((await client.billing.getInvoice(row.id)).status).toBe('finalized');
});

test('adds, rotates and revokes reference-only credentials, clearing secrets on the first attempt', async () => {
  const client = new MockPlatformClient();
  const add = vi
    .spyOn(client.credentials, 'add')
    .mockRejectedValueOnce(new PlatformError('forbidden'));
  mount('/credentials', client);
  await click('Add credential');
  await screen.findByRole('option', { name: 'Fixture BYO' });
  change('Provider', 'fixture-byo');
  change('Secret', 'fictional-secret-a');
  await click('Save credential');
  const dialog = within(screen.getByRole('dialog', { name: 'Add credential' }));
  expect((await dialog.findByRole('alert')).textContent).toContain('permission');
  expect(dialog.getByLabelText('Secret')).toHaveProperty('value', '');
  change('Secret', 'fictional-secret-b');
  await click('Save credential');
  expect(await screen.findByText('Credential added.')).toBeDefined();
  expect(add).toHaveBeenLastCalledWith({
    capability: 'llm',
    providerId: 'fixture-byo',
    secret: 'fictional-secret-b',
  });
  const [created] = await client.credentials.list();
  expect(created).toEqual({ ref: expect.stringMatching(/^vault:\/\/cred-/) });
  await click('Rotate ' + created.ref);
  change('Secret', 'fictional-secret-c');
  await click('Save new secret');
  expect(await screen.findByText('Credential rotated.')).toBeDefined();
  await click('Revoke ' + created.ref);
  await click('Confirm revoke');
  expect(await screen.findByText('Credential revoked.')).toBeDefined();
  expect((await client.credentials.list()).some(({ ref }) => ref === created.ref)).toBe(false);
});

test('installs, authorizes, syncs and reconciles a fixture connector', async () => {
  const client = new MockPlatformClient();
  const oauth = vi.spyOn(client.connectors, 'startOAuth');
  mount('/connectors', client);
  expect(
    within(await screen.findByRole('table', { name: 'Connectors' })).getByRole('link', {
      name: 'Accounting sandbox',
    }),
  ).toBeDefined();
  await navigate('/connectors/connector/accounting-fixture');
  await click('Install connector');
  expect(await screen.findByText('Connector installed.')).toBeDefined();
  await click('Connect with OAuth');
  await click('Trigger sync');
  expect(oauth).toHaveBeenCalledWith('accounting-fixture');
  expect(await screen.findByText('Connector sync requested.')).toBeDefined();
  expect(
    within(await screen.findByRole('table', { name: 'Reconciliation issues' })).getByText(
      'fixture-line-12',
    ),
  ).toBeDefined();
});

test('gates new mutation controls for a read-only session', async () => {
  const reader = new MockPlatformClient({ role: 'reader' });
  mount('/credentials', reader);
  await screen.findByRole('table', { name: 'Credential references' });
  expect(screen.queryByRole('button', { name: /Add credential|Rotate|Revoke/ })).toBeNull();
  await navigate('/billing');
  await screen.findByRole('table', { name: 'Billing SKUs' });
  expect(screen.queryByRole('button', { name: 'Change plan' })).toBeNull();
  await navigate('/connectors/connector/accounting-fixture');
  expect(await screen.findByText('available')).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Install connector' })).toBeNull();
  await expect(reader.billing.changePlan({ addOns: ['erp'] })).rejects.toMatchObject({
    code: 'forbidden',
  });
});
