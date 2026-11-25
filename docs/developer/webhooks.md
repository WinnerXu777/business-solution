# Verify connector webhooks

The fixture connector format sends Unix seconds in `x-connector-timestamp` and a 64-character hex HMAC-SHA256 in `x-connector-signature`. The MAC covers the timestamp header value, a period, and the exact request bytes. Keep the raw body until verification passes.

```ts
import { verifyWebhookSignature } from '@bs/sdk';

const raw = new Uint8Array(await request.arrayBuffer());
if (!verifyWebhookSignature(raw, request.headers, bindingSecret)) {
  return new Response(null, { status: 401 });
}
const event = JSON.parse(new TextDecoder().decode(raw));
```

The helper compares digests in constant time and accepts timestamps within 300 seconds in either direction by default. Pass `{ nowSeconds, toleranceSeconds }` for a fixture clock or an explicitly configured tolerance. Use the secret associated with the receiving binding. After validation, check the schema and account and deduplicate the event ID within that binding and account. [Connector webhook format](../personal-plan/connectors/api.md#fixture-webhook-format)
