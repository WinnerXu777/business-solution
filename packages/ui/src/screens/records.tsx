import { useCallback, useState } from 'react';
import type {
  Customer,
  Invoice,
  Order,
  PurchaseLine,
  PurchaseOrder,
  Sku,
  Vendor,
  PurchaseRequest,
  DraftPurchaseOrderOutput,
} from '@bs/contracts';
import { Button, Card, Dialog, EmptyState, StatusPill, Table } from '../components.tsx';
import { RemoteContent, useAction, useResource } from '../data.tsx';
import { canDecideApproval, canOperate } from '../platform-client.ts';
import type { PlatformRouteContext } from '../platform-app.tsx';
import { dealStages } from '../clients/records.ts';
import type { Contact } from '../clients/records.ts';
import {
  cad,
  Details,
  RecordLookup,
  ResourceTable,
  routeId,
  routeLink,
  useRequestKey,
} from './feature-helpers.tsx';

const erpLinks = [
  ['/erp', 'Orders'],
  ['/erp/purchase-requests', 'Purchase requests'],
  ['/erp/purchase-orders', 'Purchase orders'],
  ['/erp/inventory', 'Inventory'],
  ['/erp/vendors', 'Vendors'],
];
const crmLinks = [
  ['/crm', 'Customers'],
  ['/crm/contacts', 'Contacts'],
  ['/crm/pipeline', 'Pipeline'],
];

function RecordLinks({ path, links, label }: { path: string; links: string[][]; label: string }) {
  return (
    <nav className="bs-feature-actions bs-subnav" aria-label={label}>
      {links.map(([href, title]) => (
        <a key={href} href={'#' + href} aria-current={path === href ? 'page' : undefined}>
          {title}
        </a>
      ))}
    </nav>
  );
}

const orderColumns = [
  {
    key: 'id',
    title: 'Order',
    render: (row: Order) => <a href={routeLink('/erp/order', row.id)}>{row.id}</a>,
    sortValue: (row: Order) => row.id,
  },
  {
    key: 'date',
    title: 'Placed',
    render: (row: Order) => row.placedOn,
    sortValue: (row: Order) => row.placedOn,
  },
  {
    key: 'customer',
    title: 'Customer',
    render: (row: Order) => (
      <a href={routeLink('/crm/customer', row.customerId)}>{row.customerId}</a>
    ),
  },
  { key: 'status', title: 'Status', render: (row: Order) => <StatusPill status={row.status} /> },
  {
    key: 'total',
    title: 'Total',
    render: (row: Order) => cad(row.totalCents),
    sortValue: (row: Order) => row.totalCents,
  },
];
const invoiceColumns = [
  {
    key: 'id',
    title: 'Invoice',
    render: (row: Invoice) => <a href={routeLink('/crm/invoice', row.id)}>{row.id}</a>,
  },
  { key: 'due', title: 'Due', render: (row: Invoice) => row.dueOn },
  { key: 'status', title: 'Status', render: (row: Invoice) => <StatusPill status={row.status} /> },
  { key: 'balance', title: 'Balance', render: (row: Invoice) => cad(row.balanceCents) },
];
const contactColumns = [
  { key: 'name', title: 'Contact', render: (row: Contact) => row.name },
  {
    key: 'customer',
    title: 'Customer',
    render: (row: Contact) => (
      <a href={routeLink('/crm/customer', row.customerId)}>{row.customerId}</a>
    ),
  },
  { key: 'email', title: 'Email', render: (row: Contact) => row.email },
  { key: 'phone', title: 'Phone', render: (row: Contact) => row.phone },
];

export function ErpScreen(props: PlatformRouteContext) {
  const { path } = props;
  let content;
  if (path.startsWith('/erp/order/')) content = <OrderDetail {...props} />;
  else if (path.startsWith('/erp/request/')) content = <RequestDetail {...props} />;
  else if (path === '/erp/purchase-requests') content = <PurchaseRequests {...props} />;
  else if (path === '/erp/purchase-orders') content = <PurchaseOrders {...props} />;
  else if (path === '/erp/inventory' || path === '/erp/vendors')
    content = <InventoryAndVendors {...props} />;
  else content = <Orders {...props} />;
  return (
    <div className="bs-stack">
      <RecordLinks path={path} links={erpLinks} label="ERP sections" />
      {content}
    </div>
  );
}

function Orders({ client }: PlatformRouteContext) {
  const list = useResource(useCallback(() => client.records.listOrders(), [client]));
  return (
    <>
      <RecordLookup label="Order" path="/erp/order" />
      <ResourceTable
        label="Orders"
        resource={list}
        rowKey={(row) => row.id}
        columns={orderColumns}
      />
    </>
  );
}

function OrderDetail({ client, path }: PlatformRouteContext) {
  const id = routeId(path);
  const resource = useResource(useCallback(() => client.records.getOrder(id), [client, id]));
  return (
    <Card title={id}>
      <RemoteContent resource={resource} label="order">
        {(order) => (
          <>
            <Details
              fields={[
                [
                  'Customer',
                  <a href={routeLink('/crm/customer', order.customerId)}>{order.customerId}</a>,
                ],
                ['Status', <StatusPill status={order.status} />],
                ['Placed', order.placedOn],
                ['Total', cad(order.totalCents)],
              ]}
            />
            <Table
              label="Order lines"
              rows={order.lines.map((line, index) => ({ ...line, index }))}
              rowKey={(line) => String(line.index)}
              columns={[
                { key: 'sku', title: 'SKU', render: (line) => line.skuId },
                { key: 'quantity', title: 'Quantity', render: (line) => line.quantity },
              ]}
            />
          </>
        )}
      </RemoteContent>
    </Card>
  );
}

function PurchaseRequests({ client, me, notify }: PlatformRouteContext) {
  const requests = useResource(useCallback(() => client.records.listPurchaseRequests(), [client]));
  const drafts = useResource(useCallback(() => client.records.listPurchaseDrafts(), [client]));
  const [review, setReview] = useState<DraftPurchaseOrderOutput>();
  const action = useAction(notify);
  const attempt = useRequestKey();
  return (
    <>
      <RecordLookup label="Purchase request" path="/erp/request" />
      <ResourceTable<PurchaseRequest>
        label="Purchase requests"
        resource={requests}
        rowKey={(row) => row.id}
        columns={[
          {
            key: 'id',
            title: 'Request',
            render: (row) => <a href={routeLink('/erp/request', row.id)}>{row.id}</a>,
          },
          { key: 'vendor', title: 'Vendor', render: (row) => row.vendorId },
          { key: 'cost', title: 'Cost centre', render: (row) => row.costCentre },
          { key: 'total', title: 'Total', render: (row) => cad(purchaseTotal(row.lines)) },
        ]}
      />
      <ResourceTable<DraftPurchaseOrderOutput>
        label="Purchase order drafts"
        resource={drafts}
        rowKey={({ draft }) => draft.id}
        columns={[
          {
            key: 'id',
            title: 'Draft',
            render: (row) => (
              <Button variant="quiet" onClick={() => setReview(row)}>
                {row.draft.id}
              </Button>
            ),
          },
          { key: 'request', title: 'Request', render: ({ draft }) => draft.requestId },
          { key: 'total', title: 'Total', render: ({ draft }) => cad(purchaseTotal(draft.lines)) },
          { key: 'approver', title: 'Approver', render: ({ approval }) => approval.approverId },
          {
            key: 'state',
            title: 'Approval',
            render: ({ approval }) => <StatusPill status={approval.state} />,
          },
        ]}
      />
      {review && (
        <Dialog
          title="Review purchase order draft"
          busy={action.busy}
          onClose={() => setReview(undefined)}
        >
          <div className="bs-stack">
            <DraftDetail item={review} />
            {canDecideApproval(me, review.approval) && (
              <div>
                <Button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(
                      () =>
                        client.records.approvePurchaseOrder(
                          review.draft.id,
                          review.approval.id,
                          attempt.key(review.approval.id),
                        ),
                      (order) => {
                        attempt.clear();
                        drafts.reload();
                        setReview(undefined);
                        notify('Purchase order ' + order.id + ' approved.');
                        window.location.hash = '#/erp/purchase-orders';
                      },
                    )
                  }
                >
                  Approve purchase order
                </Button>
              </div>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}

const purchaseTotal = (lines: PurchaseLine[]) =>
  lines.reduce((total, row) => total + row.quantity * row.unitCostCents, 0);

function PurchaseLines({ lines }: { lines: PurchaseLine[] }) {
  return (
    <Table
      label="Purchase lines"
      rows={lines.map((line, index) => ({ ...line, index }))}
      rowKey={(row) => String(row.index)}
      columns={[
        { key: 'sku', title: 'SKU', render: (row) => row.skuId },
        { key: 'quantity', title: 'Quantity', render: (row) => row.quantity },
        { key: 'unit', title: 'Unit cost', render: (row) => cad(row.unitCostCents) },
        {
          key: 'total',
          title: 'Extended cost',
          render: (row) => cad(row.unitCostCents * row.quantity),
        },
      ]}
    />
  );
}

function DraftDetail({ item: { draft, approval } }: { item: DraftPurchaseOrderOutput }) {
  return (
    <>
      <Details
        fields={[
          ['Draft', draft.id],
          ['Vendor', draft.vendorId],
          ['Request', draft.requestId],
          ['Cost centre', draft.costCentre],
          ['Total', cad(purchaseTotal(draft.lines))],
          ['Requested by', approval.requestedBy],
          ['Assigned approver', approval.approverId],
          ['Expires', approval.expiresAt],
          ['Approval', <StatusPill status={approval.state} />],
        ]}
      />
      <PurchaseLines lines={draft.lines} />
    </>
  );
}

function RequestDetail({ client, me, notify, path }: PlatformRouteContext) {
  const id = routeId(path);
  const resource = useResource(
    useCallback(() => client.records.getPurchaseRequest(id), [client, id]),
  );
  const [draft, setDraft] = useState<DraftPurchaseOrderOutput>();
  const action = useAction(notify);
  const attempt = useRequestKey();
  return (
    <>
      <Card title={id}>
        <RemoteContent resource={resource} label="purchase request">
          {(row) => (
            <div className="bs-stack">
              <Details
                fields={[
                  ['Vendor', row.vendorId],
                  ['Cost centre', row.costCentre],
                  ['Total', cad(purchaseTotal(row.lines))],
                ]}
              />
              <PurchaseLines lines={row.lines} />
              {canOperate(me.role) && (
                <div>
                  <Button
                    disabled={action.busy || !!draft}
                    onClick={() =>
                      void action.run(
                        () => client.records.draftPurchaseOrder(row.id, attempt.key(row.id)),
                        (item) => {
                          setDraft(item);
                          notify('Draft created for approval.');
                        },
                      )
                    }
                  >
                    Draft purchase order
                  </Button>
                </div>
              )}
            </div>
          )}
        </RemoteContent>
      </Card>
      {draft && (
        <Card title="Draft purchase order">
          <DraftDetail item={draft} />
          <a href="#/erp/purchase-requests">View purchase requests and drafts</a>
        </Card>
      )}
    </>
  );
}

function PurchaseOrders({ client }: PlatformRouteContext) {
  const list = useResource(useCallback(() => client.records.listPurchaseOrders(), [client]));
  const [selected, setSelected] = useState<PurchaseOrder>();
  return (
    <>
      <ResourceTable
        label="Purchase orders"
        resource={list}
        rowKey={(row) => row.id}
        columns={[
          {
            key: 'id',
            title: 'Purchase order',
            render: (row) => (
              <Button variant="quiet" onClick={() => setSelected(row)}>
                {row.id}
              </Button>
            ),
          },
          { key: 'vendor', title: 'Vendor', render: (row) => row.draft.vendorId },
          { key: 'status', title: 'Status', render: (row) => <StatusPill status={row.status} /> },
          { key: 'total', title: 'Total', render: (row) => cad(purchaseTotal(row.draft.lines)) },
        ]}
      />
      {selected && (
        <Dialog title={selected.id} onClose={() => setSelected(undefined)}>
          <Details
            fields={[
              ['Request', selected.draft.requestId],
              ['Vendor', selected.draft.vendorId],
              ['Approval ID', selected.approvalId],
            ]}
          />
          <PurchaseLines lines={selected.draft.lines} />
        </Dialog>
      )}
    </>
  );
}

function InventoryAndVendors({ client, path }: PlatformRouteContext) {
  return path.endsWith('inventory') ? <Inventory client={client} /> : <Vendors client={client} />;
}

function Inventory({ client }: Pick<PlatformRouteContext, 'client'>) {
  const list = useResource(useCallback(() => client.records.listInventory(), [client]));
  return (
    <ResourceTable<Sku>
      label="Inventory"
      resource={list}
      rowKey={(row) => row.id}
      columns={[
        { key: 'id', title: 'SKU', render: (row) => row.id },
        { key: 'name', title: 'Item', render: (row) => row.name },
        {
          key: 'qty',
          title: 'On hand',
          render: (row) => row.onHand,
          sortValue: (row) => row.onHand,
        },
      ]}
    />
  );
}

function Vendors({ client }: Pick<PlatformRouteContext, 'client'>) {
  const list = useResource(useCallback(() => client.records.listVendors(), [client]));
  return (
    <ResourceTable<Vendor>
      label="Vendors"
      resource={list}
      rowKey={(row) => row.id}
      columns={[
        { key: 'id', title: 'Vendor ID', render: (row) => row.id },
        { key: 'name', title: 'Vendor', render: (row) => row.name },
      ]}
    />
  );
}

export function CrmScreen(props: PlatformRouteContext) {
  const { path } = props;
  let content;
  if (path.startsWith('/crm/customer/')) content = <CustomerDetail {...props} />;
  else if (path.startsWith('/crm/invoice/')) content = <CustomerInvoice {...props} />;
  else if (path === '/crm/contacts') content = <Contacts {...props} />;
  else if (path === '/crm/pipeline') content = <Pipeline {...props} />;
  else content = <Customers {...props} />;
  return (
    <div className="bs-stack">
      <RecordLinks path={path} links={crmLinks} label="CRM sections" />
      {content}
    </div>
  );
}

function Customers({ client }: PlatformRouteContext) {
  const list = useResource(useCallback(() => client.records.listCustomers(), [client]));
  return (
    <>
      <RecordLookup label="Customer" path="/crm/customer" />
      <ResourceTable<Customer>
        label="Customers"
        resource={list}
        rowKey={(row) => row.id}
        columns={[
          {
            key: 'name',
            title: 'Customer',
            render: (row) => <a href={routeLink('/crm/customer', row.id)}>{row.name}</a>,
            sortValue: (row) => row.name,
          },
          { key: 'order', title: 'Last order', render: (row) => row.lastOrderOn },
          {
            key: 'consent',
            title: 'Outreach',
            render: (row) => <StatusPill status={row.outreachAllowed ? 'allowed' : 'suppressed'} />,
          },
        ]}
      />
    </>
  );
}

function Contacts({ client }: PlatformRouteContext) {
  const list = useResource(useCallback(() => client.records.listContacts(), [client]));
  return (
    <ResourceTable
      label="Contacts"
      resource={list}
      rowKey={(row) => row.id}
      columns={contactColumns}
    />
  );
}

function Pipeline({ client }: PlatformRouteContext) {
  const list = useResource(useCallback(() => client.records.listDeals(), [client]));
  return (
    <Card title="Pipeline">
      <RemoteContent resource={list} label="pipeline">
        {(rows) =>
          rows.length ? (
            <div className="bs-board">
              {dealStages.map((stage) => {
                const deals = rows.filter((row) => row.stage === stage);
                return (
                  <section className="bs-inset" key={stage} aria-label={stage}>
                    <h3>
                      {stage[0].toUpperCase() + stage.slice(1)} ({deals.length})
                    </h3>
                    {deals.length ? (
                      <ul className="bs-feature-list">
                        {deals.map((row) => (
                          <li key={row.id}>
                            <a href={routeLink('/crm/customer', row.customerId)}>{row.title}</a>
                            <br />
                            {cad(row.valueCents)}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="bs-muted">No deals.</p>
                    )}
                  </section>
                );
              })}
            </div>
          ) : (
            <EmptyState title="No pipeline deals." />
          )
        }
      </RemoteContent>
    </Card>
  );
}

function CustomerDetail({ client, path }: PlatformRouteContext) {
  const id = routeId(path);
  const customer = useResource(useCallback(() => client.records.getCustomer(id), [client, id]));
  return (
    <RemoteContent resource={customer} label="customer">
      {(row) => (
        <div className="bs-stack">
          <Card title={row.name}>
            <Details
              fields={[
                ['Account', row.id],
                ['Email', row.email],
                ['Phone', row.phone],
                [
                  'Outreach',
                  <StatusPill status={row.outreachAllowed ? 'allowed' : 'suppressed'} />,
                ],
              ]}
            />
            <a href={routeLink('/insights/profile', row.id)}>View customer profile</a>
          </Card>
          <CustomerHistory client={client} id={id} />
        </div>
      )}
    </RemoteContent>
  );
}

function CustomerHistory({ client, id }: Pick<PlatformRouteContext, 'client'> & { id: string }) {
  const orders = useResource(useCallback(() => client.records.listOrders(id), [client, id]));
  const invoices = useResource(
    useCallback(() => client.records.listCustomerInvoices(id), [client, id]),
  );
  const contacts = useResource(useCallback(() => client.records.listContacts(id), [client, id]));
  const consent = useResource(useCallback(() => client.records.getConsent(id), [client, id]));
  return (
    <>
      <ResourceTable
        label="Consent and suppression"
        resource={consent}
        rowKey={(row) => row.channel}
        columns={[
          { key: 'channel', title: 'Channel', render: (row) => row.channel },
          { key: 'state', title: 'State', render: (row) => <StatusPill status={row.state} /> },
          { key: 'evidence', title: 'Evidence', render: (row) => row.evidenceId ?? '—' },
        ]}
      />
      <ResourceTable
        label="Contacts"
        resource={contacts}
        rowKey={(row) => row.id}
        columns={contactColumns}
      />
      <ResourceTable
        label="Order history"
        resource={orders}
        rowKey={(row) => row.id}
        columns={orderColumns}
      />
      <ResourceTable
        label="Invoice history"
        resource={invoices}
        rowKey={(row) => row.id}
        columns={invoiceColumns}
      />
    </>
  );
}

function CustomerInvoice({ client, path }: PlatformRouteContext) {
  const id = routeId(path);
  const invoice = useResource(useCallback(() => client.records.getInvoice(id), [client, id]));
  return (
    <Card title={id}>
      <RemoteContent resource={invoice} label="customer invoice">
        {(row) => (
          <Details
            fields={[
              [
                'Customer',
                <a href={routeLink('/crm/customer', row.customerId)}>{row.customerId}</a>,
              ],
              ['Order', <a href={routeLink('/erp/order', row.orderId)}>{row.orderId}</a>],
              ['Due', row.dueOn],
              ['Balance', cad(row.balanceCents)],
              ['Status', <StatusPill status={row.status} />],
            ]}
          />
        )}
      </RemoteContent>
    </Card>
  );
}
