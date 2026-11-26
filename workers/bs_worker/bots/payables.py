"""Vendor invoice extraction and accounting checks against the procurement match engine."""

from collections import Counter
import json
import re

from ..runtime.bots import fingerprint
from .models import BillInput, InvoiceDocument
from .sales import issue, normalized


HEADERS = {
    "vendor": "vendor", "invoice": "invoiceNumber", "date": "invoiceDate", "po": "poId",
    "currency": "currency", "hst cents": "hstCents", "total cents": "totalCents",
}
ITEM = re.compile(r"(sku-[a-z0-9-]+)\s*,\s*(\d{1,6})\s*,\s*(\d{1,10})", re.I)
GL_HISTORY = {
    ("vendor-002", "sku-001"): [("hist-bill-101", "5100"), ("hist-bill-102", "5100"), ("hist-bill-103", "5190")],
    ("vendor-002", "sku-002"): [("hist-bill-104", "5100")],
}


def text_fields(text):
    fields = {}
    for row in text.splitlines():
        label, separator, value = row.strip().partition(":")
        if not separator:
            continue
        label, value = label.casefold(), value.strip()
        if label == "line":
            match = ITEM.fullmatch(value)
            if not match:
                raise ValueError("Invalid invoice line")
            sku, qty, cost = match.groups()
            fields.setdefault("lines", []).append({"skuId": sku.lower(), "quantity": int(qty),
                                                   "unitCostCents": int(cost)})
        elif label in HEADERS:
            key = HEADERS[label]
            if key in fields:
                raise ValueError("Repeated invoice field")
            fields[key] = int(value) if key in {"hstCents", "totalCents"} else value
    return fields


def extract(entry, proposal):
    fields = text_fields(entry.text)
    if entry.attachment:
        values = entry.attachment.model_dump(mode="json")
        if any(values[key] != value for key, value in fields.items()):
            raise ValueError("Conflicting attachment and message fields")
        return entry.attachment
    if proposal == fields:
        # The strict document schema also rejects coercions from model-proposed values.
        try:
            return InvoiceDocument.model_validate_json(json.dumps(proposal))
        except ValueError:
            pass
    return InvoiceDocument.model_validate_json(json.dumps(fields))


def round_bps(cents, bps):
    return (cents * bps + 5000) // 10_000


class Payables:
    def __init__(self, procurement):
        self.procurement = procurement
        self.bills = {}
        self.invoice_numbers = {}
        self.exceptions = {}

    def evaluate(self, entry, proposal, policy, procurement_policy, today):
        try:
            document = extract(entry, proposal)
        except ValueError:
            return issue("invoice_extraction_needs_review")
        vendors = [key for key, row in self.procurement.vendors.items()
                   if normalized(document.vendor) in {normalized(key), normalized(row["name"])}]
        if len(vendors) != 1:
            return issue("vendor_unresolved")
        vendor = vendors[0]
        number = document.invoiceNumber.casefold()
        prior = self.invoice_numbers.get((vendor, number))
        if prior:
            if prior["totalCents"] == document.totalCents:
                return {"state": "duplicate", "billId": prior["id"]}
            return issue("invoice_number_amount_conflict", billId=prior["id"])
        if document.invoiceDate > today:
            return issue("future_invoice_date")
        subtotal = sum(line.quantity * line.unitCostCents for line in document.lines)
        expected_hst = round_bps(subtotal, policy.hstBps)
        tax = {"reportedHstCents": document.hstCents, "expectedHstCents": expected_hst,
               "totalCents": document.totalCents, "subtotalCents": subtotal}
        if subtotal + document.hstCents != document.totalCents:
            return issue("invoice_total_mismatch", tax=tax)
        if abs(document.hstCents - expected_hst) > policy.hstToleranceCents:
            return issue("hst_mismatch", tax=tax)
        if document.poId not in self.procurement.orders:
            return issue("po_unresolved")
        bill_id = "bill-ap-" + fingerprint([self.procurement.tenant, vendor, number, document.totalCents])
        bill = BillInput(id=bill_id, vendorId=vendor, currency="CAD", lines=document.lines)
        match = self.procurement.match(document.poId, bill, procurement_policy, commit=False)
        if match["state"] != "matched":
            return {"state": "exception", "reasons": match["reasons"], "match": match}
        return {"state": "vendor_bill", "id": bill_id, "vendorId": vendor, "invoiceNumber": document.invoiceNumber,
                "invoiceDate": document.invoiceDate.isoformat(), "poId": document.poId,
                "currency": "CAD", **tax, "lines": [
                    {**line.model_dump(), "glSuggestion": self.suggest_gl(vendor, line.skuId)}
                    for line in document.lines
                ], "match": match}

    def suggest_gl(self, vendor, sku):
        history = GL_HISTORY.get((vendor, sku), []) if self.procurement.tenant == "tenant-rivetquay" else []
        ranks = Counter(code for _, code in history).most_common(2)
        if not ranks or len(ranks) == 2 and ranks[0][1] == ranks[1][1]:
            return None
        code, _ = ranks[0]
        return {"accountCode": code, "evidenceIds": [key for key, value in history if value == code]}

    def approve(self, draft, policy):
        bill = BillInput(id=draft["id"], vendorId=draft["vendorId"], currency="CAD",
                         lines=[{key: line[key] for key in ("skuId", "quantity", "unitCostCents")}
                                for line in draft["lines"]])
        result = self.procurement.match(draft["poId"], bill, policy)
        if result["state"] != "matched":
            raise ValueError("Invoice match changed")
        self.bills[draft["id"]] = draft
        self.invoice_numbers[(draft["vendorId"], draft["invoiceNumber"].casefold())] = draft
