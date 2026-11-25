import type { ProviderAdapters } from '@bs/adapters';
import type { RecordKind, RecordRepository } from '@bs/business';
import type {
  Approval,
  FraudDecision,
  ProfileReviewStatus,
  PurchaseOrderDraft,
  ToolCall,
} from '@bs/contracts';
import { denied, digest, invalidInput, ok, unavailable } from './results.ts';

const pageTools = {
  'order.list': 'orders',
  'purchase.request.list': 'purchaseRequests',
  'purchase.order.list': 'purchaseOrders',
  'inventory.list': 'skus',
  'vendor.list': 'vendors',
  'customer.list': 'customers',
  'contact.list': 'contacts',
  'invoice.list': 'invoices',
  'deal.list': 'deals',
} as const satisfies Record<string, RecordKind>;

export const reviewTools = new Set(['purchase.order.approve', 'fraud.review', 'profile.review']);
export const reviewEvidenceTools = new Set(['fraud.score', 'profile.run']);

export function isReadTool(tool: ToolCall['tool']) {
  return tool.endsWith('.read') || tool.endsWith('.list') || tool === 'fraud.queue';
}

type Review = { sourceVersion: number } & (
  | { kind: 'fraud'; decision: FraudDecision }
  | { kind: 'profile'; decision: Exclude<ProfileReviewStatus, 'pending'> }
);

export type StoredReview = Review;

export function visibleDrafts(
  { tenantId, actor }: ToolCall['envelope'],
  now: string,
  grants: Iterable<Approval>,
  draftFor: (id: string) => PurchaseOrderDraft | undefined,
) {
  return [...grants].flatMap((approval) => {
    if (
      approval.tenantId !== tenantId ||
      approval.tool !== 'purchase.order.approve' ||
      approval.state !== 'pending' ||
      approval.expiresAt <= now ||
      (approval.requestedBy !== actor.id && approval.approverId !== actor.id)
    )
      return [];
    const draft = draftFor(approval.subjectId);
    return draft ? [{ draft, approval }] : [];
  });
}

export async function dispatchRecordTool(
  request: ToolCall,
  records: RecordRepository,
  reviews: Map<string, StoredReview>,
  scoring?: ProviderAdapters['scoring'],
) {
  const { tenantId } = request.envelope;
  switch (request.tool) {
    case 'order.list':
    case 'purchase.request.list':
    case 'purchase.order.list':
    case 'inventory.list':
    case 'vendor.list':
    case 'customer.list':
    case 'contact.list':
    case 'invoice.list':
    case 'deal.list': {
      const { cursor, limit = 25 } = request.input;
      const query = request.input.query?.trim().toLowerCase() || undefined;
      const customerId = 'customerId' in request.input ? request.input.customerId : undefined;
      const scope = digest([tenantId, request.tool, query, customerId]).slice(0, 32) + '.';
      if (cursor && !cursor.startsWith(scope))
        return invalidInput('Cursor does not match this query.');
      const rows = await records.list(pageTools[request.tool], tenantId, {
        after: cursor?.slice(scope.length) ?? '',
        limit: limit + 1,
        query,
        customerId,
      });
      const items = rows.slice(0, limit);
      const nextCursor = rows.length > limit ? scope + items.at(-1)!.id : null;
      // The record kind comes from the same exhaustively checked catalog as the tool.
      return ok({ items, nextCursor }) as Extract<
        import('@bs/contracts').ToolResult,
        { state: 'ok' }
      >;
    }
    case 'customer.consent.read': {
      const customer = await records.get('customers', tenantId, request.input.customerId);
      if (!customer) return denied('not_found');
      return ok(
        (['email', 'sms', 'voice'] as const).map((channel) => ({
          channel,
          state: customer.outreachAllowed
            ? channel === 'email'
              ? ('allowed' as const)
              : ('unknown' as const)
            : ('suppressed' as const),
          evidenceId: 'consent-' + customer.id,
        })),
      );
    }
    case 'fraud.queue': {
      if (!scoring) return unavailable();
      const entries = [];
      let after = '';
      for (;;) {
        const orders = await records.list('orders', tenantId, { after, limit: 100 });
        for (const order of orders) {
          if ((await scoring.fraud(order)).disposition !== 'review') continue;
          const review = reviews.get(digest([tenantId, 'fraud', order.id]));
          entries.push({
            orderId: order.id,
            decision:
              review?.kind === 'fraud' && review.sourceVersion === order.version
                ? review.decision
                : null,
          });
        }
        if (orders.length < 100) return ok(entries);
        after = orders.at(-1)!.id;
      }
    }
    case 'fraud.review': {
      const { orderId, decision } = request.input;
      const order = await records.get('orders', tenantId, orderId);
      if (!order) return denied('not_found');
      if (!scoring) return unavailable();
      if ((await scoring.fraud(order)).disposition !== 'review') return denied('not_found');
      reviews.set(digest([tenantId, 'fraud', orderId]), {
        kind: 'fraud',
        decision,
        sourceVersion: order.version,
      });
      return ok({});
    }
    case 'profile.review.read':
    case 'profile.review': {
      const { customerId } = request.input;
      const customer = await records.get('customers', tenantId, customerId);
      if (!customer) return denied('not_found');
      const key = digest([tenantId, 'profile', customerId]);
      if (request.tool === 'profile.review') {
        reviews.set(key, {
          kind: 'profile',
          decision: request.input.decision === 'accept' ? 'accepted' : 'rejected',
          sourceVersion: customer.version,
        });
        return ok({});
      }
      const review = reviews.get(key);
      return ok({
        reviewStatus:
          review?.kind === 'profile' && review.sourceVersion === customer.version
            ? review.decision
            : ('pending' as const),
      });
    }
  }
}
