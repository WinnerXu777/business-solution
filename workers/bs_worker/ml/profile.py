"""Deterministic profiling from CRM recency and scoped evidence."""

from datetime import date

from ..contracts_v1 import ContractModel, DateValue, Id, RunProfileOutput

ARTIFACT_ID = "fixture-recency-profile-v1"
INACTIVITY_CUTOFF = date(2026, 6, 1)


class ProfileCustomer(ContractModel):
    id: Id
    lastOrderOn: DateValue
    outreachAllowed: bool


def profile(customer: ProfileCustomer, supporting_orders: list[str]) -> RunProfileOutput:
    inactive = date.fromisoformat(customer.lastOrderOn) < INACTIVITY_CUTOFF
    segment = ("win_back" if customer.outreachAllowed else "abstain") if inactive else "active"
    return RunProfileOutput(
        customerId=customer.id,
        segment=segment,
        evidenceIds=list(dict.fromkeys([customer.id, *supporting_orders])),
        artifactId=ARTIFACT_ID,
        reviewRequired=True,
    )
