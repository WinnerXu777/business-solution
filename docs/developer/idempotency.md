# Idempotency and retries

The transport supplies an `Idempotency-Key` on writes. Governed REST also puts the same key in the call envelope. The platform deduplicates governed REST and MCP tool calls, bot launches, and workflow launches according to the requester and input. A changed input under a previous key can return `idempotency_conflict` or HTTP 409.

Automatic retries reuse the key and serialized body of the original request. The default is two retries after the first attempt, with exponential backoff starting at 250 ms and a 5-second delay cap. Only safe reads and supported keyed operations are retried after transport failures or HTTP 408, 429, 502, 503, or 504. A valid `Retry-After` within the cap sets a minimum wait. A longer delay returns the error to the caller. Use `maxRetries: 0` to disable retries.

Inference, connector sync, approval decisions, token rotation and ordinary platform writes get one attempt even when they carry a key. Browser auth start and callback also get one attempt. Once an SSE response is accepted the SDK reads that stream to completion. A bot caller can reconnect to the same run explicitly using its last event ID.

To repeat a known retryable request after a process restart, persist the caller-supplied `idempotencyKey` alongside the original intent and keep its input stable. Reconcile an ambiguous external outcome using the action ID before issuing another write. After a governed call returns pending approval, an approved execution with changed material such as an added approval ID needs its own key, as specified by that tool.

```ts
const draft = await client.tools.draftPurchaseOrder(
  { requestId: 'pr-001' },
  { idempotencyKey: 'fixture-draft-pr-001' },
);
```

For CLI bot launches with a supplied `--idempotency-key`, the CLI derives a stable session ID unless you set `--session`. Keep the version, prompt, route and explicit session fixed when retrying the same launch.
