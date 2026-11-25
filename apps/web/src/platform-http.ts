const pagedTools = new Set([
  'order.list',
  'purchase.request.list',
  'purchase.order.list',
  'inventory.list',
  'vendor.list',
  'customer.list',
  'contact.list',
  'invoice.list',
  'deal.list',
]);

/** Adapt the console's array readers and fixture connector screens at the web boundary. */
export const platformFetch: typeof fetch = async (input, init) => {
  if (typeof input !== 'string') return fetch(input, init);
  const url = new URL(input, window.location.origin);
  if (url.pathname === '/connectors' || url.pathname.startsWith('/connectors/')) {
    url.pathname = '/connectors/ui' + url.pathname.slice('/connectors'.length);
    return fetch(url, init);
  }
  const tool = url.pathname.split('/v1/tools/')[1];
  if (!pagedTools.has(tool) || typeof init?.body !== 'string') return fetch(input, init);
  const call = JSON.parse(init.body);
  const items: unknown[] = [];
  const seen = new Set<string>();
  let body = init.body;
  for (;;) {
    const response = await fetch(input, { ...init, body });
    if (!response.ok) return response;
    const result = await response.clone().json();
    if (result.state !== 'ok') return response;
    const { items: page, nextCursor } = result.output;
    items.push(...page);
    if (!nextCursor) return Response.json({ state: 'ok', output: items });
    if (seen.has(nextCursor)) throw new Error('Repeated records cursor.');
    seen.add(nextCursor);
    body = JSON.stringify({
      ...call,
      input: { ...call.input, cursor: nextCursor },
      envelope: { ...call.envelope, idempotencyKey: crypto.randomUUID() },
    });
  }
};
