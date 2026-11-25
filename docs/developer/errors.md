# Errors and denial codes

Generated tool methods and `client.mcp.call` return `ok` or `pending_approval`. Use the returned approval ID and designated approver to continue a pending action. `client.tools.callRaw` and `client.mcp.callRaw` expose the full governed response for callers that want to handle each state directly.

| Denial code            | What to check                                          |
| ---------------------- | ------------------------------------------------------ |
| `forbidden`            | Your actor's role and scope for the operation          |
| `not_found`            | The resource ID in your current tenant                 |
| `module_disabled`      | The tenant's module entitlement                        |
| `quota_exceeded`       | The tenant's remaining allowance and quota window      |
| `invalid_approval`     | The assigned signer, expiry and approved material      |
| `suppressed`           | The record's current contact permissions               |
| `idempotency_conflict` | The original input and purpose associated with the key |

These codes surface as `DenialError` from HTTP failures and governed results. `ToolFailure` includes the typed `invalid_input`, `provider_error` or `unavailable` code and the server's `retryable` indication. `UnknownOutcome` carries the `actionId` needed to reconcile the result.

Other HTTP failures use `ApiError` with `code`, `status`, and `requestId` and `retryAfterMs` when provided. MCP JSON-RPC errors use `McpError` with the numeric RPC code and HTTP status. Accumulate LLM stream output as partial until the iterator finishes successfully. A sanitized stream error or a missing completion marker raises an `ApiError`.
