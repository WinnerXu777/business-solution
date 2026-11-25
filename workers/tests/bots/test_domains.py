from copy import deepcopy
from datetime import datetime, timedelta
import unittest

from workers.bs_worker.bots.collections import aging_bucket
from workers.bs_worker.bots.procurement import approval_route
from workers.bs_worker.bots.service import FixtureBots, fixture_can_contact
from workers.bs_worker.chat.gateway import fake_gateway_stdio


def scope(key, actor="actor-operator", tenant="tenant-rivetquay"):
    return {
        "version": "v1", "tenantId": tenant, "actor": {"id": actor, "kind": "person"},
        "source": "rest", "traceId": "trace-bots", "correlationId": "correlation-bots",
        "idempotencyKey": key,
    }


def request(text, key, source="chat"):
    return {"text": text, "sourceId": key, "source": source, "route": "native"}


def output(run):
    if run["status"] != "completed":
        raise AssertionError(run)
    return run["result"]["output"]


class ProcurementTests(unittest.TestCase):
    def test_governed_po_partial_receipts_and_variances(self):
        with fake_gateway_stdio() as gateway:
            host = FixtureBots(gateway, lambda *_: False)
            run = host.dispatch("purchase", scope("buy"), "operator", body=request("Draft pr-001", "chat-1"))
            self.assertEqual(run["status"], "pending_approval", run)
            recommendation = run["pending"]["recommendation"]
            self.assertEqual(recommendation["approvalRoute"], "manager")
            self.assertEqual(recommendation["vendorId"], "vendor-002")
            self.assertIn("sku-001", recommendation["citations"])
            self.assertTrue(recommendation["inventoryChecks"][0]["reorder"])
            approval = {"approvalId": run["pending"]["approval"]["id"]}
            with self.assertRaises(KeyError):
                host.dispatch("resume", scope("wrong", "actor-admin"), "admin", run["id"], approval)
            signed = host.dispatch("resume", scope("yes", "actor-approver"), "approver", run["id"], approval)
            order = output(signed)["id"]
            retry = host.dispatch("resume", scope("retry", "actor-approver"), "approver", run["id"], approval)
            self.assertEqual(signed, retry)
            self.assertEqual(output(host.dispatch("purchase", scope("more"), "operator",
                                                  body=request("Draft pr-001", "email-1", "email")))["state"], "duplicate")

            def receipt(key, quantity):
                return host.dispatch("receipt", scope(key), "operator", order, {
                    "id": key, "lines": [{"skuId": "sku-001", "quantity": quantity}],
                })

            def invoice(key, quantity, unit):
                return host.dispatch("match", scope(key), "operator", order, {
                    "id": key, "vendorId": "vendor-002", "currency": "CAD",
                    "lines": [{"skuId": "sku-001", "quantity": quantity, "unitCostCents": unit}],
                })

            self.assertEqual(receipt("r1", 25)["state"], "partial")
            self.assertEqual(receipt("r1", 25)["received"]["sku-001"], 25)
            self.assertIn("insufficient_receipts:sku-001", invoice("b1", 26, 428)["reasons"])
            self.assertEqual(receipt("r2", 35)["state"], "complete")
            self.assertEqual(invoice("b1", 26, 428)["state"], "matched")
            self.assertIn("unit_price_variance:sku-001", invoice("b2", 34, 429)["reasons"])
            self.assertIn("quantity_exceeds_po:sku-001", invoice("b3", 35, 420)["reasons"])
            self.assertEqual(len(host.dispatch("exceptions", scope("read"), "reader")), 2)
            self.assertEqual(len(host.dispatch("matches", scope("read"), "reader", order)), 3)

    def test_authority_budget_thresholds_and_fresh_email(self):
        with fake_gateway_stdio() as gateway:
            host = FixtureBots(gateway, lambda *_: False)
            workspace = host.workspace(scope("workspace"))
            policy = workspace.procurement_policy
            self.assertEqual([approval_route(amount, policy) for amount in [50_000, 50_001, 250_000, 250_001]],
                             ["manager", "finance", "finance", "executive"])

            def intake(quantity, key, due="2026-11-29"):
                return output(host.dispatch("purchase", scope(key), "operator", body=request(
                    f"Please purchase {quantity} units of sku-001 by {due}, cost centre stock-toronto.", key, "email",
                )))

            self.assertIn("requester_authority_exceeded", intake(500, "high")["reasons"])
            self.assertIn("no_vendor_meets_lead_time", intake(10, "late", "2026-11-25")["reasons"])
            workspace.procurement_policy = policy.model_copy(update={"budgetCents": {"stock-toronto": 1}})
            self.assertIn("insufficient_budget", intake(10, "budget")["reasons"])
            workspace.procurement_policy = policy
            expedited = intake(10, "rush", "2026-11-26")
            self.assertEqual(expedited["vendorId"], "vendor-003")
            self.assertEqual(expedited["state"], "pending_approval")
            self.assertEqual(intake(10, "duplicate", "2026-11-29")["requestId"], expedited["requestId"])
            approved = host.dispatch("approve-draft", scope("yes", "actor-approver"), "approver",
                                     expedited["requestId"], {"approvalId": expedited["approvalId"]})
            self.assertEqual(approved["status"], "approved_fixture")
            finance = intake(150, "finance")
            self.assertEqual(finance["approverId"], "actor-finance")


class CollectionsTests(unittest.TestCase):
    def setUp(self):
        self.clock = datetime.fromisoformat("2026-11-25T15:00:00Z")
        self.gateway_calls = []
        self.host = FixtureBots(self.gateway, lambda *_: False, now=lambda: self.clock)
        self.workspace = self.host.workspace(scope("workspace"))
        self.domain = self.workspace.collections
        self.policy = self.workspace.collections_policy

    def gateway(self, tool, envelope, inputs):
        self.gateway_calls.append((tool, inputs))
        if tool != "llm.complete":
            raise AssertionError(tool)
        return {"state": "ok", "output": {
            "text": "Fixture completion", "model": inputs["model"], "route": inputs["route"],
            "inputTokens": 5, "outputTokens": 2,
        }}

    def command(self, kind, key, **fields):
        return output(self.host.dispatch(kind, scope(key), "operator", body={"invoiceId": "inv-001", **fields}))

    def test_aging_cadence_and_injected_contact_window(self):
        self.assertEqual([aging_bucket(days) for days in [0, 1, 30, 31, 60, 61, 90, 91]],
                         ["current", "1-30", "1-30", "31-60", "31-60", "61-90", "61-90", "91+"])
        self.domain.canContact = lambda *_: False
        self.assertEqual(self.command("dunning", "window")["reason"], "contact_window_or_eligibility")
        self.assertEqual(self.gateway_calls, [])
        self.domain.canContact = fixture_can_contact
        decision = self.domain.evaluate("inv-001", self.policy, self.clock)
        self.assertEqual(decision["channel"], "email")
        self.domain.attempted("inv-001", decision, self.clock)
        self.assertEqual(self.domain.evaluate("inv-001", self.policy, self.clock + timedelta(days=5))["reason"], "cadence")
        self.assertEqual(self.domain.evaluate("inv-001", self.policy, self.clock + timedelta(days=7))["state"], "contact")
        self.assertEqual(self.domain.evaluate("inv-001", self.policy, self.clock + timedelta(days=10))["reason"],
                         "contact_window_or_eligibility")
        self.assertEqual(self.domain.evaluate("inv-002", self.policy, self.clock)["reason"], "aging_threshold")

    def test_disputes_and_account_opt_out_stop_all_channels(self):
        self.assertEqual(self.command("reply", "reply", replyId="r1", text="We dispute this invoice.")["reason"], "dispute")
        self.assertEqual(self.command("dunning", "hold")["reason"], "dispute")
        self.assertEqual(self.command("reply", "stop", replyId="r2", text="STOP")["reason"], "opt_out")
        for channel in ("email", "sms", "voice"):
            current = self.policy.model_copy(update={"channelEnabled": {channel: True}})
            self.assertEqual(self.domain.evaluate("inv-001", current, self.clock)["reason"], "opt_out")
        self.assertEqual(self.gateway_calls, [])
        timeline = self.host.dispatch("timeline", scope("timeline"), "reader", "cust-002")
        self.assertEqual([row["kind"] for row in timeline], ["dispute_hold", "staff_escalation", "opt_out"])

    def test_promise_follow_up_via_original_balance_and_plan_approval(self):
        recorded = self.command("reply", "promised", replyId="r3", text="We will pay $300.50 on 2026-11-26.", route="byo")
        self.assertEqual(recorded["amountCents"], 30050)
        self.assertEqual(self.gateway_calls[-1][1]["route"]["providerId"], "fixture-byo")
        self.assertEqual(self.command("dunning", "before")["reason"], "promise_pending")
        self.clock += timedelta(days=2)
        follow_up = self.domain.evaluate("inv-001", self.policy, self.clock)
        self.assertEqual(follow_up["tone"], "promise_follow_up")
        self.domain.attempted("inv-001", follow_up, self.clock)
        self.assertTrue(self.host.dispatch("promise", scope("read"), "reader", "inv-001")["followedUp"])
        over_limit = self.command("plan", "invalid-plan", installments=12, firstDueOn="2026-12-01", intervalDays=14)
        self.assertEqual(over_limit["reason"], "payment_plan_outside_policy")
        plan = self.command("plan", "plan", installments=3, firstDueOn="2026-12-01", intervalDays=14)
        self.assertEqual(plan["state"], "pending_approval")
        self.assertEqual(sum(item["amountCents"] for item in plan["installments"]), 67300)
        material = {"approvalId": plan["id"]}
        with self.assertRaises(PermissionError):
            self.host.dispatch("approve-plan", scope("operator"), "operator", "inv-001", material)
        with self.assertRaises(KeyError):
            self.host.dispatch("approve-plan", scope("wrong", "actor-other"), "approver", "inv-001", material)
        invoice = self.domain.invoices["inv-001"]
        self.domain.invoices["inv-001"] = {**invoice, "version": invoice["version"] + 1}
        with self.assertRaises(ValueError):
            self.host.dispatch("approve-plan", scope("stale", "actor-approver"), "approver", "inv-001", material)
        self.domain.invoices["inv-001"] = deepcopy(invoice)
        approved = self.host.dispatch("approve-plan", scope("approved", "actor-approver"), "approver", "inv-001", material)
        self.assertEqual(approved["state"], "approved")
        self.assertEqual(self.command("dunning", "after")["reason"], "approved_payment_plan")

