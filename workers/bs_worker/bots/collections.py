"""Collections policy, replies, plans and account history for synthetic accounts."""

from datetime import date, datetime, timedelta
import re
from typing import Callable

from .models import CollectionsPolicy, PlanInput, ReplyInput
from ..runtime.bots import fingerprint


DISPUTE = re.compile(
    r"\b(disput\w*|contest\w*|wrong (?:amount|invoice|party)|already paid|"
    r"not (?:our|my) (?:invoice|debt)|(?:never|did not|didn't) (?:order|receive))\b", re.I,
)
OPT_OUT = re.compile(r"\b(unsubscribe|opt[ -]out|do not (?:contact|call|text|email)|stop (?:contacting|calling|texting|emailing))\b", re.I)
STOP_KEYWORD = re.compile(r"stop(?:\s*all)?[.!]?", re.I)
PROMISE = re.compile(
    r"\b(?:we(?:'ll| will)|i(?:'ll| will)|promise to) pay\s+(?:CAD\s+)?\$(\d{1,7})"
    r"(?:\.(\d{2}))?\s+(?:on|by)\s+(\d{4}-\d{2}-\d{2})\b", re.I,
)

TEMPLATES = {
    "1-30": ("friendly", "Please contact Rivetquay accounts receivable when convenient."),
    "31-60": ("direct", "Please contact Rivetquay accounts receivable to review your account."),
    "61-90": ("firm", "Please contact Rivetquay accounts receivable to arrange a review."),
    "91+": ("staff_review", "Please contact Rivetquay accounts receivable for staff assistance."),
    "promise_follow_up": ("promise_follow_up", "Please contact Rivetquay accounts receivable about your recent arrangement."),
}


def aging_bucket(days):
    if days <= 0:
        return "current"
    if days <= 30:
        return "1-30"
    if days <= 60:
        return "31-60"
    if days <= 90:
        return "61-90"
    return "91+"


def reply_holds(text):
    text = text.strip()
    return bool(STOP_KEYWORD.fullmatch(text) or OPT_OUT.search(text)), bool(DISPUTE.search(text))


class Collections:
    def __init__(self, fixtures, tenant, local_time: Callable, can_contact: Callable):
        self.tenant = tenant
        self.invoices = {row["id"]: row for row in fixtures["invoices"] if row["tenantId"] == tenant}
        self.customers = {row["id"]: row for row in fixtures["customers"] if row["tenantId"] == tenant}
        self.local_time = local_time
        self.canContact = can_contact
        self.events = {}
        self.disputes = set()
        self.suppressed = set()
        self.promises = {}
        self.plans = {}
        self.replies = {}
        self.uncertain = set()

    def event(self, invoice, kind, now, **details):
        events = self.events.setdefault(invoice["customerId"], [])
        events.append({
            "sequence": len(events) + 1, "kind": kind, "at": now.isoformat(),
            "invoiceId": invoice["id"], **details,
        })

    def escalate(self, invoice, reason, now):
        events = self.events.get(invoice["customerId"], [])
        if not any(event["kind"] == "staff_escalation" and event["invoiceId"] == invoice["id"]
                   and event["reason"] == reason for event in events):
            self.event(invoice, "staff_escalation", now, reason=reason)
        return {"state": "staff_review", "reason": reason}

    def evaluate(self, invoice_id, policy: CollectionsPolicy, now):
        invoice = self.invoices[invoice_id]
        account = invoice["customerId"]
        customer = self.customers[account]
        today = self.local_time(now).date()
        days = (today - date.fromisoformat(invoice["dueOn"])).days
        bucket = aging_bucket(days)

        def hold(reason):
            return {"state": "held", "reason": reason, "bucket": bucket, "daysPastDue": max(0, days)}

        if not customer["outreachAllowed"] or account in self.suppressed:
            return hold("opt_out")
        if invoice_id in self.disputes or invoice["status"] == "disputed":
            self.escalate(invoice, "dispute", now)
            return hold("dispute")
        if account in self.uncertain:
            return hold("reconcile_delivery")
        if invoice["status"] == "paid" or invoice["balanceCents"] <= 0 or days <= 0:
            return hold("no_past_due_balance")
        plan = self.plans.get(invoice_id)
        if plan and plan["state"] == "approved":
            return hold("approved_payment_plan")
        promise = self.promises.get(invoice_id)
        if promise and (invoice["balanceCents"] < promise["sourceBalanceCents"]
                        or invoice["version"] != promise["sourceVersion"]):
            return {**self.escalate(invoice, "reconcile_promise_balance", now), "bucket": bucket}
        if promise and today <= date.fromisoformat(promise["dueOn"]):
            return hold("promise_pending")
        if days >= policy.escalationDays:
            return {**self.escalate(invoice, "aging_threshold", now), "bucket": bucket}

        events = self.events.get(account, [])
        attempts = [datetime.fromisoformat(event["at"]) for event in events if event["kind"] == "contact_attempt"]
        rule = policy.cadence[bucket]
        if attempts and now < max(attempts) + timedelta(days=rule.daysBetween):
            return hold("cadence")
        if sum(stamp > now - timedelta(days=7) for stamp in attempts) >= 3:
            return hold("rolling_contact_cap")
        eligible = [channel for channel in rule.channels if policy.channelEnabled.get(channel, False)]
        if not eligible:
            return hold("channels_disabled")
        # An injected gate owns the recipient-local business calendar and verified contact eligibility.
        offset = len(attempts) % len(eligible)
        for channel in eligible[offset:] + eligible[:offset]:
            if self.canContact(customer, invoice, channel, now):
                tone, template = TEMPLATES["promise_follow_up" if promise and not promise["followedUp"] else bucket]
                return {
                    "state": "contact", "channel": channel, "tone": tone, "template": template,
                    "bucket": bucket, "daysPastDue": days, "customerId": account,
                    "customerVersion": customer["version"], "sourceVersion": invoice["version"],
                    "balanceCents": invoice["balanceCents"],
                }
        return hold("contact_window_or_eligibility")

    def attempted(self, invoice_id, decision, now, *, unknown=False):
        invoice = self.invoices[invoice_id]
        self.event(invoice, "contact_attempt", now, channel=decision["channel"], tone=decision["tone"],
                   outcome="unknown" if unknown else "simulated")
        if unknown:
            self.uncertain.add(invoice["customerId"])
            self.escalate(invoice, "reconcile_delivery", now)
        elif decision["tone"] == "promise_follow_up":
            self.promises[invoice_id]["followedUp"] = True

    def reply(self, reply: ReplyInput, model, now):
        invoice = self.invoices[reply.invoiceId]
        material = fingerprint([reply.invoiceId, reply.text])
        prior = self.replies.get(reply.replyId)
        if prior:
            if prior[0] != material:
                raise ValueError("Reply ID is bound to another message")
            return prior[1]
        account = invoice["customerId"]
        text = reply.text.strip()
        opt_out, disputed = reply_holds(text)
        outcome = {"state": "staff_review", "reason": "unclassified_reply"}
        if opt_out or model.get("intent") == "opt_out":
            self.suppressed.add(account)
            self.event(invoice, "opt_out", now)
            outcome = {"state": "held", "reason": "opt_out"}
        if disputed or model.get("intent") == "dispute":
            self.disputes.add(reply.invoiceId)
            self.event(invoice, "dispute_hold", now)
            self.escalate(invoice, "dispute", now)
            outcome = {"state": "held", "reason": "dispute"}
        if outcome["state"] == "staff_review":
            matches = PROMISE.findall(text)
            if len(matches) == 1 and not re.search(r"\b(?:if|maybe|might|try|unless|cannot|can't)\b", text, re.I):
                outcome = self._promise(invoice, reply.replyId, matches[0], now) or outcome
            if outcome["state"] == "staff_review":
                self.escalate(invoice, outcome["reason"], now)
        self.replies[reply.replyId] = (material, outcome)
        return outcome

    def _promise(self, invoice, reply_id, capture, now):
        dollars, cents, due = capture
        amount = int(dollars) * 100 + int(cents or 0)
        try:
            due_on = date.fromisoformat(due)
        except ValueError:
            return None
        if not self.local_time(now).date() <= due_on <= self.local_time(now).date() + timedelta(days=90):
            return None
        if not 0 < amount <= invoice["balanceCents"] or invoice["status"] in {"disputed", "paid"}:
            return None
        if invoice["id"] in self.disputes:
            return None
        promise = {
            "state": "recorded", "id": reply_id, "invoiceId": invoice["id"], "amountCents": amount,
            "dueOn": due, "sourceBalanceCents": invoice["balanceCents"], "sourceVersion": invoice["version"],
            "followedUp": False,
        }
        self.promises[invoice["id"]] = promise
        self.event(invoice, "promise_to_pay", now, promiseId=reply_id, dueOn=due, amountCents=amount)
        return dict(promise)

    def plan(self, proposal: PlanInput, policy, policy_version, requester, now):
        invoice = self.invoices[proposal.invoiceId]
        today = self.local_time(now).date()
        last_date = proposal.firstDueOn + timedelta(days=proposal.intervalDays * (proposal.installments - 1))
        if (
            invoice["status"] not in {"open", "overdue"} or proposal.invoiceId in self.disputes
            or not proposal.installments <= invoice["balanceCents"] <= policy.maxPlanCents
            or proposal.installments > policy.maxInstallments or proposal.firstDueOn < today
            or last_date > today + timedelta(days=policy.maxPlanDays)
        ):
            return self.escalate(invoice, "payment_plan_outside_policy", now)
        prior = self.plans.get(proposal.invoiceId)
        if prior and prior["state"] == "approved":
            return dict(prior)
        cents, remainder = divmod(invoice["balanceCents"], proposal.installments)
        schedule = [
            {"dueOn": (proposal.firstDueOn + timedelta(days=i * proposal.intervalDays)).isoformat(),
             "amountCents": cents + (i < remainder)}
            for i in range(proposal.installments)
        ]
        material = {
            "invoiceId": invoice["id"], "installments": schedule, "sourceVersion": invoice["version"],
            "balanceCents": invoice["balanceCents"], "policyVersion": policy_version,
        }
        plan_id = "plan-" + fingerprint([self.tenant, requester, material])
        if prior and prior["id"] == plan_id:
            return dict(prior)
        plan = {
            **material, "state": "pending_approval", "id": plan_id, "requestedBy": requester,
            "approverId": "actor-approver", "expiresAt": (now + timedelta(hours=1)).isoformat(),
        }
        self.plans[proposal.invoiceId] = plan
        self.event(invoice, "payment_plan_proposed", now, planId=plan_id)
        return dict(plan)

    def approve_plan(self, invoice_id, plan_id, actor, policy_version, now):
        invoice = self.invoices[invoice_id]
        plan = self.plans[invoice_id]
        if plan["id"] != plan_id or plan["requestedBy"] == actor or plan["approverId"] != actor:
            raise KeyError(plan_id)
        if plan["state"] == "approved":
            return dict(plan)
        if (
            now >= datetime.fromisoformat(plan["expiresAt"]) or policy_version != plan["policyVersion"]
            or invoice["version"] != plan["sourceVersion"] or invoice["balanceCents"] != plan["balanceCents"]
            or invoice_id in self.disputes or invoice["status"] not in {"open", "overdue"}
        ):
            raise ValueError("Plan approval is stale")
        plan["state"] = "approved"
        self.event(invoice, "payment_plan_approved", now, planId=plan_id)
        return dict(plan)
