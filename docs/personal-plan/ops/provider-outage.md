# Provider outage

1. Confirm which fixture capability, route and tenant are affected. Check readiness, local adapter availability and the latest outcome transitions. Use synthetic probes and local test receivers.
2. Pause the affected route if it performs delivery or writes. Leave uncertain effects held while reconciling action IDs with local receipts. Check the bound credential version and any provider-spend or entitlement gate before considering retry.
3. For eligible reads, use a configured synthetic fallback after verifying capability and policy. Revalidate policy and approval for any intended external effect. Use a human review step for missing or ambiguous receipts.
4. Verify the recovered adapter with a fixture request. Confirm expected provider ID, one receipt per action and the corresponding usage and audit entries. Resume approved dispatch and update the incident record.
