"""Fixture PR intake, purchasing controls and line-level matching."""

from collections import Counter
from datetime import date
from decimal import Decimal
import json
import re

from .models import BillInput, Intake, ReceiptInput
from ..runtime.bots import fingerprint


REQUEST_ID = re.compile(r"\bpr-[a-z0-9]+(?:-[a-z0-9]+)*\b", re.I)
LINE = re.compile(r"(?<![\d.,-])(\d{1,6})\s+(?:units?\s+(?:of\s+)?)?(sku-[a-z0-9-]+)\b", re.I)
NEED_BY = re.compile(r"\b(?:need(?:ed)? by|by)\s+(\d{4}-\d\d-\d\d)\b", re.I)
CENTRE = re.compile(r"\bcost cent(?:re|er)\s*:?\s+([a-z0-9-]+)\b", re.I)


def parse_intake(text: str, proposal: dict) -> Intake:
    """Require explicit quantities, SKU IDs, cost centre and date in the source text."""
    lines = [(quantity, sku.lower()) for quantity, sku in LINE.findall(text)]
    sku_mentions = re.findall(r"\bsku-[a-z0-9-]+\b", text.lower())
    dates = NEED_BY.findall(text)
    centres = CENTRE.findall(text.lower())
    if sorted(sku for _, sku in lines) != sorted(sku_mentions) or len(dates) != 1 or len(centres) != 1:
        raise ValueError("Incomplete or ambiguous line, date or cost centre")
    grounded = Intake(
        costCentre=centres[0], needBy=date.fromisoformat(dates[0]),
        lines=[{"skuId": sku, "quantity": int(quantity)} for quantity, sku in lines],
    )
    try:
        candidate = Intake.model_validate_json(json.dumps(proposal))
    except ValueError:
        return grounded
    canonical = lambda request: sorted((line.skuId, line.quantity) for line in request.lines)
    if (
        candidate.costCentre == grounded.costCentre and candidate.needBy == grounded.needBy
        and canonical(candidate) == canonical(grounded)
    ):
        return candidate
    return grounded


# Fictional quotes and stock planning records keyed by SKU, scoped to Rivetquay.
# Tuple fields are vendor, CAD cents, calendar lead days and on-time reliability in bps.
QUOTES = {
    "sku-001": [
        ("vendor-001", 400, 5, 8700), ("vendor-002", 420, 2, 9900), ("vendor-003", 450, 1, 9600),
    ],
    "sku-002": [("vendor-001", 1150, 4, 9800), ("vendor-002", 1200, 2, 9900)],
}
STOCK = {"sku-001": (20, 3, 0, "vendor-002"), "sku-002": (30, 4, 0, "vendor-002")}


def approval_route(total, policy):
    if total <= policy.managerThroughCents:
        return "manager"
    if total <= policy.financeThroughCents:
        return "finance"
    return "executive"


class Procurement:
    def __init__(self, fixtures, tenant):
        self.tenant = tenant
        self.skus = {row["id"]: row for row in fixtures["skus"] if row["tenantId"] == tenant}
        self.vendors = {row["id"] for row in fixtures["vendors"] if row["tenantId"] == tenant}
        self.requisitions = {
            row["id"]: row for row in fixtures["purchaseRequests"] if row["tenantId"] == tenant
        }
        self.exceptions = {}
        self.matches = {}
        self.drafts = {}
        self.orders = {}
        self.receipts = {}
        self.bills = {}
        self.inbox = {}
        self.material = {}

    def exception(self, record_id, *reasons):
        entry = {"id": record_id, "state": "exception", "reasons": list(reasons)}
        self.exceptions[record_id] = entry
        return entry

    def assess(self, request: Intake, request_id, role, policy, today):
        room = (request.needBy - today).days
        assessments = []
        quotes_by_sku = {}
        for line in request.lines:
            sku = line.skuId
            if self.tenant != "tenant-rivetquay" or sku not in STOCK or sku not in self.skus:
                return self.exception(request_id, "missing_stock_policy")
            reorder, daily, incoming, preferred = STOCK[sku]
            position = self.skus[sku]["onHand"] + incoming
            offers = {}
            for vendor, price, lead, reliability in QUOTES[sku]:
                if vendor in self.vendors and lead <= room and reliability >= 8500:
                    # Penalize slow and unreliable supply in cents and give preferred suppliers a small credit.
                    adjusted = Decimal(price) * (1 + Decimal(10_000 - reliability) / 10_000)
                    score = line.quantity * (adjusted + 10 * lead - (12 if vendor == preferred else 0))
                    offers[vendor] = (score, price, lead, reliability)
            quotes_by_sku[sku] = offers
            assessments.append({
                "skuId": sku, "onHand": self.skus[sku]["onHand"], "stockPosition": position,
                "reorderPoint": reorder, "dailyDemand": daily, "preferredVendorId": preferred,
            })
        common = set.intersection(*(set(offers) for offers in quotes_by_sku.values()))
        if not common:
            return self.exception(request_id, "no_vendor_meets_lead_time")
        vendor = min(common, key=lambda v: (sum(q[v][0] for q in quotes_by_sku.values()), v))
        lines = []
        for line, stock in zip(request.lines, assessments, strict=True):
            _, price, lead, reliability = quotes_by_sku[line.skuId][vendor]
            projected = stock["stockPosition"] - lead * stock["dailyDemand"]
            stock.update({
                "leadDays": lead, "projectedStockAtDelivery": projected,
                "reorder": projected <= stock["reorderPoint"], "reliabilityBps": reliability,
            })
            if not stock["reorder"]:
                return self.exception(request_id, "above_reorder_point")
            lines.append({**line.model_dump(), "unitCostCents": price})
        total = sum(line["quantity"] * line["unitCostCents"] for line in lines)
        reserved = sum(
            draft["totalCents"] for draft in self.drafts.values()
            if draft["costCentre"] == request.costCentre and draft["requestId"] != request_id
        )
        if total > policy.authorityCents.get(role, 0):
            return self.exception(request_id, "requester_authority_exceeded")
        if total + reserved > policy.budgetCents.get(request.costCentre, 0):
            return self.exception(request_id, "insufficient_budget")
        return {
            "state": "draft", "requestId": request_id, "currency": "CAD",
            "costCentre": request.costCentre, "needBy": request.needBy.isoformat(),
            "vendorId": vendor, "lines": lines, "totalCents": total,
            "approvalRoute": approval_route(total, policy), "inventoryChecks": assessments,
            "justification": "Projected stock reaches the reorder point. Supplier meets the required date "
                             "and has the lowest adjusted cost for the full requisition.",
            "citations": [request_id, vendor, *(line.skuId for line in request.lines),
                          *(f"quote:{vendor}:{line.skuId}:v1" for line in request.lines),
                          f"budget:{request.costCentre}"],
        }

    def remember(self, source, raw_hash, request, candidate):
        request_id = candidate["requestId"]
        material_key = self.material_key(request)
        prior = self.material.get(material_key)
        if prior is not None:
            return {"state": "duplicate", "requestId": prior}
        self.material[material_key] = request_id
        self.drafts[request_id] = candidate
        self.inbox[source] = (raw_hash, request_id)
        return candidate

    @staticmethod
    def material_key(request):
        return fingerprint([
            request.costCentre, sorted((line.skuId, line.quantity) for line in request.lines),
        ])

    def receipt(self, order_id, receipt: ReceiptInput):
        order = self.orders[order_id]
        key = receipt.id
        material = (order_id, receipt.model_dump())
        if key in self.receipts:
            if self.receipts[key] != material:
                raise ValueError("Receipt ID is bound to another document")
        else:
            quantities = self._quantities(self.receipts, order_id)
            received = self._lines(receipt.lines)
            ordered = {line["skuId"]: line["quantity"] for line in order["lines"]}
            if any(qty + quantities[sku] > ordered.get(sku, 0) for sku, qty in received.items()):
                return self.exception(f"receipt:{key}", "over_receipt_or_unordered_sku")
            self.receipts[key] = material
            self.exceptions.pop(f"receipt:{key}", None)
        quantities = self._quantities(self.receipts, order_id)
        return {
            "id": key, "orderId": order_id, "received": dict(quantities),
            "state": "complete" if all(quantities[line["skuId"]] == line["quantity"]
                                       for line in order["lines"]) else "partial",
        }

    def match(self, order_id, bill: BillInput, policy, *, commit=True):
        order = self.orders[order_id]
        key = bill.id
        material = (order_id, bill.model_dump())
        if key in self.bills and self.bills[key] != material:
            raise ValueError("Invoice ID is bound to another document")
        if self.matches.get(key, {}).get("state") == "matched":
            return self.matches[key]
        billed = self._lines(bill.lines)
        approved = {line["skuId"]: line for line in order["lines"]}
        received = self._quantities(self.receipts, order_id)
        matched = self._quantities(self.bills, order_id, self.matches)
        issues = [] if bill.vendorId == order["vendorId"] else ["vendor_mismatch"]
        variances = []
        for line in bill.lines:
            sku = line.skuId
            if sku not in approved:
                issues.append(f"unordered_sku:{sku}")
                continue
            expected = approved[sku]
            if billed[sku] + matched[sku] > expected["quantity"]:
                issues.append(f"quantity_exceeds_po:{sku}")
            elif billed[sku] + matched[sku] > received[sku]:
                issues.append(f"insufficient_receipts:{sku}")
            delta = line.unitCostCents - expected["unitCostCents"]
            variances.append({
                "skuId": sku, "unitPriceDeltaCents": delta, "lineDeltaCents": delta * line.quantity,
                "invoicedQuantity": line.quantity, "receivedQuantity": received[sku],
                "previouslyMatchedQuantity": matched[sku], "orderedQuantity": expected["quantity"],
            })
            if abs(delta) * 10_000 > expected["unitCostCents"] * policy.priceToleranceBps:
                issues.append(f"unit_price_variance:{sku}")
        result = {
            "id": key, "orderId": order_id, "state": "exception" if issues else "matched",
            "reasons": issues, "variances": variances, "toleranceBps": policy.priceToleranceBps,
            "citations": [order_id, key, *(rid for rid, (po, _) in self.receipts.items() if po == order_id)],
        }
        if not commit:
            return result
        self.bills[key] = material
        self.matches[key] = result
        if issues:
            self.exceptions[f"bill:{key}"] = result
        else:
            self.exceptions.pop(f"bill:{key}", None)
        return result

    @staticmethod
    def _lines(lines):
        quantities = {line.skuId: line.quantity for line in lines}
        if len(quantities) != len(lines):
            raise ValueError("Use one line per SKU")
        return quantities

    @staticmethod
    def _quantities(documents, order_id, matches=None):
        quantities = Counter()
        for key, (subject, document) in documents.items():
            if subject == order_id and (matches is None or matches.get(key, {}).get("state") == "matched"):
                quantities.update({line["skuId"]: line["quantity"] for line in document["lines"]})
        return quantities
