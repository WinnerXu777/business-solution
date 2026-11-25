# Requested shared changes

Lane E uses a standalone fixture backend while the shared interfaces are unchanged. The owner can wire the fixture UI/API without changing those interfaces. For the shared stack, use the verified tenant and actor for every read, proposal, approval and dispatch.

## Bootstrap diff

In `apps/api/src/app.ts`, add these imports with the other local modules.

```ts
import { botsPlugin } from './bots/index.ts';
import { createFixtureBotsBackend } from './bots/fixture.ts';
```

After the declaration of `resolveIdentity`, register the plugin in explicit fixture mode.

```ts
if (!pool && env.BS_FIXTURE_LOGIN === '1') {
  app.register(botsPlugin, {
    backend: createFixtureBotsBackend(env.BS_WORKER_PYTHON),
    async resolveIdentity(request) {
      const identity = await resolveIdentity(request);
      const role = identity && services.directory.resolve(identity)?.role;
      if (
        identity &&
        (role === 'admin' || role === 'operator' || role === 'approver' || role === 'reader')
      ) {
        return { ...identity, role };
      }
    },
  });
}
```

The fixture plugin already calls the public runtime API. For the shared automation host, import `definitions` and the domain host in `workers/bs_worker/chat/stdio.py`. Instantiate the domain host with the same gateway/clock and pass `CHAT, *definitions(domain_host)` to `BotRegistry`. Extend the `bot-start` variant in `apps/api/src/automation/worker.ts`, `runtime-routes.ts` and the stdio dispatcher with a discriminated niche command/input alternative. Derive role from the verified identity and validate the niche input in the worker. Keep the existing chat variant. Add a domain-output variant for bot replies and a recommendation field for approval surfaces. Preserve journaled tool keys, tenant leases and explicit approval interrupts.

## Contract diff

Add the operations below to `packages/contracts/v1/tools.json` under procurement or collections and reference the schemas added to `shared.json`. Add `collections.plan.approve` to `ApprovalAction`. In the generated-call relay, register the new tools in `workers/bs_worker/chat/gateway.py` and use the normal allowlist, scope checks and usage journal. Re-run shared codegen. Extend the business repositories and governance handlers to implement the semantics below, then swap the lane-local fixture operations for those shared calls. No dependency changes are needed.

| Operation                   | Input and result                                                       | Required semantics                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `purchase.context.read`     | `PurchaseContextInput` → `PurchaseContext`                             | Return scoped stock, offers, budget, spend and authority as one versioned snapshot. Resolve authority from the verified role and cost centre.                                                                                                                                                                                                                                                                       |
| `purchase.order.prepare`    | `PurchasePrepareInput` → existing draft and approval                   | Upsert the requisition by source ID. Compare normalized open requisitions per workspace. Recompute funding, price, lead time, policy and authority from the current records. Atomically reserve budget and bind approval to material, sources and policy. Resolve the designated approver from the current route. Expiry or rejection releases the reservation. Existing `purchase.order.approve` consumes it once. |
| `purchase.receipt.record`   | `ReceiptInput` → receipt ID, accepted quantities and source version    | Require an approved tenant PO, deduplicate the source receipt ID and serialize the quantity check with insertion.                                                                                                                                                                                                                                                                                                   |
| `purchase.invoice.match`    | `VendorInvoiceInput` → `MatchResult`                                   | Compare approved terms with receipts and previously matched invoices. Durable exception, variance and evidence rows should be visible to staff. Hold uncertain outcomes for reconciliation.                                                                                                                                                                                                                         |
| `collections.context.read`  | Existing invoice read input → `CollectionsContext`                     | Return authoritative balance, contact basis, verified recipient, suppression, classification, promises, plans and cross-channel attempts including manual entries.                                                                                                                                                                                                                                                  |
| `collections.case.record`   | `CaseEventInput` → event ID and source version                         | Apply opt-out and dispute flags transactionally with a redacted timeline append. Dedupe the reply ID. Reconcile promises against authoritative payment records before deciding to follow up.                                                                                                                                                                                                                        |
| `collections.plan.prepare`  | `PlanPrepareInput` → existing approval shape with a plan ID as subject | Propose only against verified balance and policy. Persist exact material and designated approver.                                                                                                                                                                                                                                                                                                                   |
| `collections.plan.approve`  | `PlanApproveInput` → plan ID, schedule, approved state                 | Check the separate approver, balance, dispute and policy revisions, then consume the grant once.                                                                                                                                                                                                                                                                                                                    |
| `message.preview` extension | Add optional `contact: ContactAttempt`                                 | Resolve a versioned template on the server and generate a stable preview per planned attempt. Include contact purpose, attempt ID and exact material in approval. Recheck contact eligibility and atomically claim an account cadence slot before dispatch. Keep the shared outbox, entitlement accounting and simulated-channel binding.                                                                           |

### Proposed JSON Schema

These are schema definitions to merge into the shared Draft 2020-12 registry. Existing definitions such as `Id`, `Count`, `DateValue`, `Timestamp`, `MessageChannel`, `OrderLine`, `PurchaseLine`, `Invoice` and `Customer` retain their v1 meanings.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$defs": {
    "PurchaseContextInput": {
      "type": "object",
      "additionalProperties": false,
      "required": ["costCentre", "skuIds"],
      "properties": {
        "costCentre": { "$ref": "#/$defs/Id" },
        "skuIds": {
          "type": "array",
          "minItems": 1,
          "maxItems": 20,
          "uniqueItems": true,
          "items": { "$ref": "#/$defs/Id" }
        }
      }
    },
    "SupplierOffer": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "vendorId",
        "skuId",
        "unitCostCents",
        "leadDays",
        "reliabilityBps",
        "preferred"
      ],
      "properties": {
        "id": { "$ref": "#/$defs/Id" },
        "vendorId": { "$ref": "#/$defs/Id" },
        "skuId": { "$ref": "#/$defs/Id" },
        "unitCostCents": { "$ref": "#/$defs/Count" },
        "leadDays": { "type": "integer", "minimum": 0, "maximum": 365 },
        "reliabilityBps": { "type": "integer", "minimum": 0, "maximum": 10000 },
        "preferred": { "type": "boolean" }
      }
    },
    "PurchaseContext": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "sourceVersion",
        "policyVersion",
        "stock",
        "offers",
        "availableBudgetCents",
        "authorityCents"
      ],
      "properties": {
        "sourceVersion": { "$ref": "#/$defs/Count" },
        "policyVersion": { "$ref": "#/$defs/Id" },
        "stock": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["skuId", "onHand", "reorderPoint", "dailyDemand", "incoming"],
            "properties": {
              "skuId": { "$ref": "#/$defs/Id" },
              "onHand": { "$ref": "#/$defs/Count" },
              "reorderPoint": { "$ref": "#/$defs/Count" },
              "dailyDemand": { "$ref": "#/$defs/Count" },
              "incoming": { "$ref": "#/$defs/Count" }
            }
          }
        },
        "offers": { "type": "array", "items": { "$ref": "#/$defs/SupplierOffer" } },
        "availableBudgetCents": { "$ref": "#/$defs/Count" },
        "authorityCents": { "$ref": "#/$defs/Count" }
      }
    },
    "PurchasePrepareInput": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "source",
        "sourceId",
        "costCentre",
        "needBy",
        "offerIds",
        "lines",
        "sourceVersion"
      ],
      "properties": {
        "source": { "enum": ["chat", "email"] },
        "sourceId": { "$ref": "#/$defs/Id" },
        "costCentre": { "$ref": "#/$defs/Id" },
        "needBy": { "$ref": "#/$defs/DateValue" },
        "sourceVersion": { "$ref": "#/$defs/Count" },
        "offerIds": {
          "type": "array",
          "minItems": 1,
          "maxItems": 20,
          "items": { "$ref": "#/$defs/Id" }
        },
        "lines": {
          "type": "array",
          "minItems": 1,
          "maxItems": 20,
          "items": { "$ref": "#/$defs/OrderLine" }
        }
      }
    },
    "ReceiptInput": {
      "type": "object",
      "additionalProperties": false,
      "required": ["orderId", "receiptId", "lines"],
      "properties": {
        "orderId": { "$ref": "#/$defs/Id" },
        "receiptId": { "$ref": "#/$defs/Id" },
        "lines": {
          "type": "array",
          "minItems": 1,
          "maxItems": 20,
          "items": { "$ref": "#/$defs/OrderLine" }
        }
      }
    },
    "VendorInvoiceInput": {
      "type": "object",
      "additionalProperties": false,
      "required": ["orderId", "invoiceId", "vendorId", "currency", "lines"],
      "properties": {
        "orderId": { "$ref": "#/$defs/Id" },
        "invoiceId": { "$ref": "#/$defs/Id" },
        "vendorId": { "$ref": "#/$defs/Id" },
        "currency": { "const": "CAD" },
        "lines": {
          "type": "array",
          "minItems": 1,
          "maxItems": 20,
          "items": { "$ref": "#/$defs/PurchaseLine" }
        }
      }
    },
    "MatchResult": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "orderId", "state", "reasons", "citations", "toleranceBps", "variances"],
      "properties": {
        "id": { "$ref": "#/$defs/Id" },
        "orderId": { "$ref": "#/$defs/Id" },
        "state": { "enum": ["matched", "exception"] },
        "reasons": { "type": "array", "items": { "type": "string" } },
        "citations": { "type": "array", "items": { "$ref": "#/$defs/Id" } },
        "toleranceBps": { "type": "integer", "minimum": 0, "maximum": 1000 },
        "variances": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "skuId",
              "unitPriceDeltaCents",
              "lineDeltaCents",
              "invoicedQuantity",
              "receivedQuantity",
              "previouslyMatchedQuantity",
              "orderedQuantity"
            ],
            "properties": {
              "skuId": { "$ref": "#/$defs/Id" },
              "unitPriceDeltaCents": { "type": "integer" },
              "lineDeltaCents": { "type": "integer" },
              "invoicedQuantity": { "$ref": "#/$defs/Count" },
              "receivedQuantity": { "$ref": "#/$defs/Count" },
              "previouslyMatchedQuantity": { "$ref": "#/$defs/Count" },
              "orderedQuantity": { "$ref": "#/$defs/Count" }
            }
          }
        }
      }
    },
    "CollectionsContext": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "invoice",
        "customerId",
        "customerVersion",
        "contactEligibility",
        "attemptedAt",
        "historyComplete",
        "caseVersion",
        "promiseId",
        "planId"
      ],
      "properties": {
        "invoice": { "$ref": "#/$defs/Invoice" },
        "customerId": { "$ref": "#/$defs/Id" },
        "customerVersion": { "$ref": "#/$defs/Count" },
        "caseVersion": { "$ref": "#/$defs/Count" },
        "contactEligibility": {
          "type": "array",
          "uniqueItems": true,
          "items": { "$ref": "#/$defs/MessageChannel" }
        },
        "attemptedAt": { "type": "array", "items": { "$ref": "#/$defs/Timestamp" } },
        "historyComplete": { "type": "boolean" },
        "promiseId": { "anyOf": [{ "$ref": "#/$defs/Id" }, { "type": "null" }] },
        "planId": { "anyOf": [{ "$ref": "#/$defs/Id" }, { "type": "null" }] }
      }
    },
    "CaseEventInput": {
      "type": "object",
      "additionalProperties": false,
      "required": ["invoiceId", "replyId", "kind"],
      "properties": {
        "invoiceId": { "$ref": "#/$defs/Id" },
        "replyId": { "$ref": "#/$defs/Id" },
        "kind": { "enum": ["dispute", "opt_out", "promise_to_pay", "staff_review"] },
        "dueOn": { "$ref": "#/$defs/DateValue" },
        "amountCents": { "type": "integer", "minimum": 1, "maximum": 9007199254740991 }
      },
      "if": { "properties": { "kind": { "const": "promise_to_pay" } } },
      "then": { "required": ["dueOn", "amountCents"] },
      "else": { "not": { "anyOf": [{ "required": ["dueOn"] }, { "required": ["amountCents"] }] } }
    },
    "PlanPrepareInput": {
      "type": "object",
      "additionalProperties": false,
      "required": ["invoiceId", "installments", "firstDueOn", "intervalDays", "sourceVersion"],
      "properties": {
        "invoiceId": { "$ref": "#/$defs/Id" },
        "installments": { "type": "integer", "minimum": 2, "maximum": 12 },
        "firstDueOn": { "$ref": "#/$defs/DateValue" },
        "intervalDays": { "type": "integer", "minimum": 7, "maximum": 30 },
        "sourceVersion": { "$ref": "#/$defs/Count" }
      }
    },
    "PlanApproveInput": {
      "type": "object",
      "additionalProperties": false,
      "required": ["planId", "approvalId"],
      "properties": { "planId": { "$ref": "#/$defs/Id" }, "approvalId": { "$ref": "#/$defs/Id" } }
    },
    "ContactAttempt": {
      "type": "object",
      "additionalProperties": false,
      "required": ["attemptId", "templateId", "templateVersion", "caseVersion"],
      "properties": {
        "attemptId": { "$ref": "#/$defs/Id" },
        "templateId": { "$ref": "#/$defs/Id" },
        "templateVersion": { "$ref": "#/$defs/Count" },
        "caseVersion": { "$ref": "#/$defs/Count" }
      }
    }
  }
}
```
