# Stuck outbox

1. Identify the tenant and action ID from the redacted audit or operator dead-letter listing. Compare intent, approval, outbox status and last known receipt in the private demo database. Use read-only access during diagnosis.
2. Check the app's dispatch loop and database readiness. Confirm the worker is running and distinguish a delayed attempt, an unresolved in-flight attempt, and a dead-letter outcome. Pause affected dispatch while investigating ambiguous effects.
3. Locate the action ID at the local fake provider or Mailpit. If an effect already happened, preserve its receipt and reconcile the recorded outcome. If an effect is confirmed absent, revalidate approval and policy and use the existing governed retry or reconciliation path with the original action identity. Escalate unknown or unresolved outcomes for review.
4. Check audit and usage against the final outcome before resuming other work. Keep the original approval, intent and audit history intact and record the recovery and any operator action.
