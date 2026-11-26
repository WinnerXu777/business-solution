"""Customer-scoped service responses and a fixture conversation staff queue."""

from collections import Counter
from datetime import date
import re

from .payables import round_bps
from .sales import issue


ORDER_ID = re.compile(r"\bord-[a-z0-9]+(?:-[a-z0-9]+)*\b", re.I)
INTENTS = {
    "return": re.compile(r"\b(?:return|rma|refund|credit memo)\b", re.I),
    "tracking": re.compile(r"\b(?:track(?:ing)?|shipment|carrier)\b", re.I),
    "status": re.compile(r"\b(?:status|where|order update)\b", re.I),
}
RETURN_LINE = re.compile(r"(?<![\d.,-])(\d{1,6})\s+(?:units?\s+(?:of\s+)?)?(sku-[a-z0-9-]+)\b", re.I)
CONDITIONS = re.compile(r"\b(?:unopened|resalable|opened|damaged|used)\b", re.I)
NEGATED_CONDITION = re.compile(r"\b(?:not|never|non|isn't)\b[\s-]+(?:unopened|resalable)\b", re.I)
CARRIERS = {
    "ord-001": {"carrier": "Fable Parcel", "trackingNumber": "FIX-FABLE-0001", "status": "delivered",
                "deliveredOn": "2026-11-23", "unitPricesCents": {"sku-001": 24125}},
    "ord-002": {"carrier": "Fable Parcel", "trackingNumber": "FIX-FABLE-0002", "status": "delivered",
                "deliveredOn": "2026-11-21", "unitPricesCents": {}},
}


def interpret(text, proposal):
    ids = {key.casefold() for key in ORDER_ID.findall(text)}
    intents = [key for key, pattern in INTENTS.items() if pattern.search(text)]
    if set(intents) == {"status", "tracking"}:
        intents = ["tracking"]
    if len(ids) != 1 or len(intents) != 1:
        return None, None
    grounded = (next(iter(ids)), intents[0])
    candidate = (proposal.get("orderId"), proposal.get("intent"))
    return candidate if candidate == grounded else grounded


class CustomerService:
    def __init__(self, tenant):
        self.carriers = CARRIERS if tenant == "tenant-rivetquay" else {}
        self.queue = {}
        self.returns = {}
        self.returned = Counter()

    def evaluate(self, entry, proposal, order, policy, today):
        order_id, intent = interpret(entry.text, proposal)
        if not order_id:
            return issue("service_intent_needs_review")
        if not order or order["id"] != order_id or order["customerId"] != entry.verifiedCustomerId:
            return issue("order_unavailable")
        base = {"orderId": order_id, "orderStatus": order["status"], "sourceVersion": order["version"]}
        if intent == "status":
            return {"state": "order_status", **base}
        carrier = self.carriers.get(order_id)
        if not carrier:
            return issue("shipment_unavailable")
        if intent == "tracking":
            return {"state": "shipment_tracking", **base,
                    "shipment": {key: value for key, value in carrier.items() if key != "unitPricesCents"}}
        days = (today - date.fromisoformat(carrier["deliveredOn"])).days
        if carrier["status"] != "delivered" or not 0 <= days <= policy.returnWindowDays:
            return issue("return_outside_window")
        conditions = {word.casefold() for word in CONDITIONS.findall(entry.text)}
        if (len(conditions) != 1 or not conditions <= set(policy.acceptedConditions)
                or NEGATED_CONDITION.search(entry.text)):
            return issue("return_condition_needs_review")
        parts = RETURN_LINE.findall(entry.text)
        if len(parts) != 1 or len(re.findall(r"\bsku-[a-z0-9-]+\b", entry.text, re.I)) != 1:
            return issue("return_quantity_needs_review")
        qty, sku = int(parts[0][0]), parts[0][1].lower()
        purchased = {line["skuId"]: line["quantity"] for line in order["lines"]}
        if not 1 <= qty <= purchased.get(sku, 0) - self.returned[order_id, sku]:
            return issue("return_quantity_exceeds_eligible")
        unit = carrier["unitPricesCents"].get(sku)
        if unit is None:
            return issue("return_price_unavailable")
        subtotal = unit * qty
        fee = round_bps(subtotal, policy.restockingFeeBps)
        return {"state": "return", **base, "customerId": order["customerId"], "skuId": sku, "quantity": qty,
                "previouslyAuthorizedQuantity": self.returned[order_id, sku],
                "condition": next(iter(conditions)), "deliveredOn": carrier["deliveredOn"],
                "restockingFeeBps": policy.restockingFeeBps, "creditMemo": {
                    "status": "draft", "currency": "CAD", "merchandiseCents": subtotal,
                    "restockingFeeCents": fee, "creditCents": subtotal - fee,
                }}

    def approve(self, draft):
        self.returned[draft["orderId"], draft["skuId"]] += draft["quantity"]
        self.returns[draft["id"]] = draft
