"""Fixture account, product, order entry and RFQ rules."""

import csv
from datetime import timedelta
from io import StringIO
import re

from .procurement import QUOTES


# Synthetic price lists and cost categories. Stock comes from the existing workspace SKUs.
CATALOG = {
    "sku-001": ("RV-GL100", "ppe", 650, "sku-005", 550),
    "sku-002": ("RV-FS200", "ppe", 1800, None, 1600),
    "sku-004": ("RV-SG400", "ppe", 900, None, 800),
    "sku-005": ("RV-GL500", "ppe", 1550, None, 1400),
    "sku-006": ("RV-HW600", "hardware", 2100, None, 1900),
}
EXTRA_OFFERS = {
    "sku-004": [("vendor-002", 500, 3, 9800)],
    "sku-005": [("vendor-002", 880, 4, 9800)],
    "sku-006": [("vendor-001", 1200, 5, 9800)],
}
ACCOUNTS = {
    "cust-001": ({"dock-a": "Toronto Dock A", "dock-b": "Toronto Dock B"}, 150_000, False),
    "cust-002": ({"main": "Toronto Main"}, 75_000, False),
    "cust-003": ({"main": "Toronto Receiving"}, 200_000, True),
}
ALIASES = {"cust-001": {"line gloves": "sku-001"}, "cust-002": {"line gloves": "sku-002"}}
CONTRACT = {("cust-001", "sku-001"): 600}
LINE = re.compile(r"(\d{1,6})\s*(?:[x×]\s+|\s+(?:(?:units?|pcs)\s+(?:of\s+)?)?)(.+)", re.I)
SPLIT = re.compile(r"[\n,;]+|\s+and\s+(?=\d)", re.I)
PREFIX = re.compile(r"^(?:(?:please|can you|could you)\s+|(?:send|order|buy|quote|need|i need|we need|rfq for|order for)\s+)+", re.I)
HEADER = re.compile(r"\b(customer|ship[\s-]?to)\s*:\s*([^;,\n]+)", re.I)


def normalized(value):
    return " ".join(re.findall(r"[^\W_]+", value.casefold()))


def issue(reason, **details):
    return {"state": "exception", "reasons": [reason], **details}


def explicit_lines(text):
    lines = []
    for part in SPLIT.split(HEADER.sub("", text)):
        part = PREFIX.sub("", part.strip()).strip(" .?!")
        if not part or part.casefold() in {"thanks", "thank you", "hi", "hello"}:
            continue
        match = LINE.fullmatch(part)
        if not match:
            raise ValueError("Unparsed order line")
        qty, item = match.groups()
        target = re.search(r"\s+(?:at|@)\s+(\d{1,9})\s*(?:cents?)?$", item, re.I)
        lines.append({
            "item": item[:target.start()].strip() if target else item.strip(),
            "quantity": int(qty), "targetUnitPriceCents": int(target[1]) if target else None,
        })
    return lines


def requested_lines(entry, proposal, quote):
    if entry.csv:
        reader = csv.DictReader(StringIO(entry.csv), strict=True)
        columns = ["item", "quantity"]
        if quote and reader.fieldnames == [*columns, "targetUnitPriceCents"]:
            columns.append("targetUnitPriceCents")
        if reader.fieldnames != columns:
            raise ValueError("Invalid attachment columns")
        lines = []
        for row in reader:
            if set(row) != set(columns) or any(value is None for value in row.values()):
                raise ValueError("Invalid attachment row")
            target = row.get("targetUnitPriceCents")
            numbers = [row["quantity"], target] if target else [row["quantity"]]
            if any(not re.fullmatch(r"[0-9]{1,9}", number) for number in numbers):
                raise ValueError("Invalid quantity or target price")
            lines.append({"item": row["item"].strip(), "quantity": int(row["quantity"]),
                          "targetUnitPriceCents": int(target) if target else None})
    else:
        lines = explicit_lines(entry.text)
        candidate = proposal.get("lines")
        if isinstance(candidate, list):
            # Accept a structured extraction only when each explicit line survives unchanged.
            if candidate == lines and all(type(line.get("quantity")) is int and
                                          (line.get("targetUnitPriceCents") is None or
                                           type(line["targetUnitPriceCents"]) is int) for line in candidate):
                lines = candidate
    if not 1 <= len(lines) <= 20 or any(
        not line["item"] or len(line["item"]) > 160 or not 1 <= line["quantity"] <= 100_000
        or (line["targetUnitPriceCents"] is not None and (not quote or line["targetUnitPriceCents"] < 1))
        for line in lines
    ):
        raise ValueError("Invalid intake lines")
    return lines


class Sales:
    def __init__(self, fixtures, tenant, procurement):
        self.customers = {row["id"]: row for row in fixtures["customers"] if row["tenantId"] == tenant}
        self.catalog = {sku: terms for sku, terms in CATALOG.items()
                        if tenant == "tenant-rivetquay" and sku in procurement.skus}
        self.procurement = procurement
        self.inventory = {sku: procurement.skus[sku]["onHand"] for sku in self.catalog}
        self.exposure = {customer: sum(row["balanceCents"] for row in fixtures["invoices"]
                                       if row["tenantId"] == tenant and row["customerId"] == customer)
                         for customer in self.customers}
        self.orders = {}
        self.quotes = {}

    def resolve_customer(self, reference):
        return [key for key, row in self.customers.items()
                if normalized(reference) in {normalized(row[field]) for field in ("id", "name", "email")}]

    def resolve_sku(self, customer, item):
        reference = normalized(item)
        if not reference:
            return []
        matches = []
        alias = ALIASES.get(customer, {}).get(reference)
        for sku, (part, *_) in self.catalog.items():
            description = normalized(self.procurement.skus[sku]["name"])
            if reference in {normalized(sku), normalized(part)}:
                score, method = 10_000, "part_number"
            elif sku == alias:
                score, method = 9800, "customer_alias"
            elif reference == description:
                score, method = 9500, "description"
            elif set(reference.split()) <= set(description.split()):
                score, method = 8000, "partial_description"
            else:
                continue
            matches.append({"skuId": sku, "confidenceBps": score, "method": method})
        return sorted(matches, key=lambda row: (-row["confidenceBps"], row["skuId"]))

    def evaluate(self, entry, proposal, policy, today, quote):
        headers = {}
        for key, value in HEADER.findall(entry.text):
            headers.setdefault(normalized(key).replace(" ", ""), []).append(value.strip())
        references = [value for value in [entry.customer, *headers.get("customer", [])] if value]
        matches = [self.resolve_customer(ref) for ref in references]
        if not matches or any(len(match) != 1 or match != matches[0] for match in matches):
            return issue("customer_unresolved", questions=["Which customer account is this request for?"])
        customer = matches[0][0]
        account = ACCOUNTS.get(customer) if self.catalog else None
        if not account:
            return issue("customer_terms_unavailable")
        destinations, limit, hold = account
        references = [value for value in [entry.shipTo, *headers.get("shipto", [])] if value]
        matched = [{dest for dest, label in destinations.items()
                    if normalized(ref) in {normalized(dest), normalized(label)}} for ref in references]
        if not matched:
            matched = [set(destinations)] if not quote else [set()]
        if (not quote or references) and (len(matched[0]) != 1 or any(match != matched[0] for match in matched)):
            return issue("ship_to_unresolved", questions=["Which approved ship-to should we use?"],
                         shipToOptions=destinations)
        ship_to = next(iter(matched[0]), None)
        try:
            requests = requested_lines(entry, proposal, quote)
        except (csv.Error, ValueError):
            return issue("line_extraction_needs_review", questions=["Please provide each item and quantity."])
        lines, unresolved = [], []
        for request in requests:
            item, qty = request["item"], request["quantity"]
            candidates = self.resolve_sku(customer, item)
            if (not candidates or candidates[0]["confidenceBps"] < policy.minMatchConfidenceBps
                or len(candidates) > 1 and candidates[0]["confidenceBps"] == candidates[1]["confidenceBps"]):
                unresolved.append({"item": item, "candidates": candidates,
                                   "question": f"What is the exact part number for {item}?"})
                continue
            match = candidates[0]
            sku = match["skuId"]
            line = {**match, "quantity": qty, "availableQuantity": min(qty, self.inventory[sku]),
                    "backorderQuantity": max(0, qty - self.inventory[sku])}
            if quote:
                priced = self.quote_line(line, request["targetUnitPriceCents"], policy)
                if priced is None:
                    return issue("vendor_terms_unavailable", skuId=sku)
                line.update(priced)
            else:
                contract = CONTRACT.get((customer, sku))
                line.update(unitPriceCents=contract or self.catalog[sku][2],
                            priceSource="contract" if contract else "price_list")
            lines.append(line)
        if unresolved:
            return issue("sku_clarification", clarifications=unresolved)
        if len({line["skuId"] for line in lines}) != len(lines):
            return issue("duplicate_sku", questions=["Please combine the quantities for each part."])
        subtotal = sum(line["quantity"] * line["unitPriceCents"] for line in lines)
        draft = {"customerId": customer, "customerVersion": self.customers[customer]["version"],
                 "shipToId": ship_to, "currency": "CAD", "subtotalCents": subtotal, "lines": lines}
        if quote:
            expires = today + timedelta(days=policy.expiryDays)
            return {**draft, "state": "quote", "expiresOn": expires.isoformat(),
                    "remindOn": (expires - timedelta(days=policy.reminderDaysBeforeExpiry)).isoformat(),
                    "marginException": any(line["marginException"] for line in lines)}
        credit = {"currentExposureCents": self.exposure[customer], "limitCents": limit,
                  "projectedExposureCents": self.exposure[customer] + subtotal, "onHold": hold}
        if hold or credit["projectedExposureCents"] > limit:
            return issue("credit_hold" if hold else "credit_limit_exceeded", credit=credit)
        return {**draft, "state": "sales_order", "credit": credit,
                "acknowledgement": {"status": "draft", "channel": entry.source,
                                    "recipient": self.customers[customer]["email"] if entry.source == "email" else None,
                                    "subject": "Order acknowledgement",
                                    "body": f"We received your order for {sum(row['quantity'] for row in lines)} units "
                                            f"for {destinations[ship_to]}. "
                                            f"{sum(row['backorderQuantity'] for row in lines)} units are on backorder."}}

    def quote_line(self, line, target, policy):
        sku, qty = line["skuId"], line["quantity"]
        _, category, list_price, substitute, volume_price = self.catalog[sku]
        offers = [offer for offer in QUOTES.get(sku, EXTRA_OFFERS.get(sku, []))
                  if offer[0] in self.procurement.vendors]
        if not offers:
            return None
        vendor, cost, lead, _ = min(offers, key=lambda offer: (offer[1], offer[2], offer[0]))
        floor = policy.marginFloorBps[category]
        minimum = (cost * 10_000 + (10_000 - floor) - 1) // (10_000 - floor)
        break_qty = 10 if qty >= 10 else 1
        price = target if target is not None else max(minimum, volume_price if break_qty == 10 else list_price)
        alternatives = []
        if line["backorderQuantity"] and substitute in self.catalog and self.inventory[substitute]:
            alternatives.append({"skuId": substitute, "availableQuantity": self.inventory[substitute]})
        return {"category": category, "unitPriceCents": price, "unitCostCents": cost,
                "volumeBreakQuantity": break_qty, "vendorId": vendor, "vendorLeadDays": lead,
                "leadDays": lead if line["backorderQuantity"] else 0, "substitutes": alternatives,
                "marginBps": (price - cost) * 10_000 // price, "marginFloorBps": floor,
                "marginException": price < minimum}

    def confirm(self, draft):
        for line in draft["lines"]:
            self.inventory[line["skuId"]] -= line["availableQuantity"]
        self.exposure[draft["customerId"]] += draft["subtotalCents"]
        self.orders[draft["id"]] = draft

    def reminders(self, today):
        date = today.isoformat()
        return [{"quoteId": row["id"], "customerId": row["customerId"], "dueOn": row["remindOn"],
                 "expiresOn": row["expiresOn"], "status": "draft",
                 "body": f"Quote {row['id']} expires on {row['expiresOn']}. Please contact us with any questions."}
                for row in self.quotes.values() if row["remindOn"] <= date < row["expiresOn"]]
