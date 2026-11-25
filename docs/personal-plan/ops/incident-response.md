# Incident response

1. Record the UTC start time, affected surfaces and fixture tenant, first request ID, and current deployment revision. Keep the record in the private operations workspace.
2. Check `/ops/health` and `/ops/ready`. Compare `/ops/alerts` short and long windows and use `/ops/metrics` to locate the route, error status and latency change. An insufficient-data evaluation means the sample floor has not been met.
3. Follow the request or trace ID into the structured logs. Scope the evidence to the verified tenant. Keep raw payloads, headers, credentials and contact details out of the incident record.
4. If the incident could duplicate an effect, pause dispatch before recovering traffic. Keep outstanding approvals, audit and outbox evidence intact. Use the provider outage or stuck-outbox runbook for uncertain outcomes.
5. Recheck readiness and the affected fixture scenario. Verify that retries use the original action identity and that there are no duplicate receipts. Record recovery time, actions taken and any follow-ups with owners.
