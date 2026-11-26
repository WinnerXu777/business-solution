from datetime import date
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

Id = Annotated[str, StringConstraints(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$")]
Cents = Annotated[int, Field(ge=1, le=1_000_000_000)]
Quantity = Annotated[int, Field(ge=1, le=100_000)]
Channel = Literal["email", "voice", "sms"]
Role = Literal["reader", "operator", "approver", "admin"]
Route = Literal["native", "byo"]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class Line(Model):
    skuId: Id
    quantity: Quantity


class PricedLine(Line):
    unitCostCents: Cents


class Intake(Model):
    costCentre: Id
    needBy: date
    lines: list[Line] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def unique_skus(self):
        if len({line.skuId for line in self.lines}) != len(self.lines):
            raise ValueError("Use one line per SKU")
        return self


class PurchaseInput(Model):
    text: str = Field(min_length=1, max_length=2000)
    source: Literal["chat", "email"]
    sourceId: Id
    route: Route = "native"


class ReceiptInput(Model):
    id: Id
    lines: list[Line] = Field(min_length=1, max_length=20)


class BillInput(Model):
    id: Id
    vendorId: Id
    currency: Literal["CAD"]
    lines: list[PricedLine] = Field(min_length=1, max_length=20)


class CollectionsInput(Model):
    invoiceId: Id


class ReplyInput(CollectionsInput):
    replyId: Id
    text: str = Field(min_length=1, max_length=2000)
    route: Route = "native"


class PlanInput(CollectionsInput):
    installments: int = Field(ge=2, le=12)
    firstDueOn: date
    intervalDays: int = Field(ge=7, le=30)


class ApprovalInput(Model):
    approvalId: Id


class ProcurementPolicy(Model):
    budgetCents: dict[Id, Cents] = Field(min_length=1, max_length=100)
    authorityCents: dict[Role, Annotated[int, Field(ge=0, le=1_000_000_000)]]
    managerThroughCents: Cents
    financeThroughCents: Cents
    priceToleranceBps: int = Field(ge=0, le=1000)

    @model_validator(mode="after")
    def ordered_thresholds(self):
        if self.managerThroughCents >= self.financeThroughCents:
            raise ValueError("Finance threshold must exceed manager threshold")
        return self


class DunningRule(Model):
    daysBetween: int = Field(ge=1, le=90)
    channels: list[Channel] = Field(min_length=1, max_length=3)


Bucket = Literal["1-30", "31-60", "61-90", "91+"]


class CollectionsPolicy(Model):
    channelEnabled: dict[Channel, bool]
    cadence: dict[Bucket, DunningRule]
    escalationDays: int = Field(ge=31, le=365)
    maxPlanCents: Cents
    maxInstallments: int = Field(ge=2, le=12)
    maxPlanDays: int = Field(ge=14, le=365)

    @model_validator(mode="after")
    def complete_cadence(self):
        if set(self.cadence) != {"1-30", "31-60", "61-90", "91+"}:
            raise ValueError("Cadence must cover all past-due buckets")
        return self


class PolicyUpdate(Model):
    expectedVersion: int = Field(ge=1)
    procurement: ProcurementPolicy
    collections: CollectionsPolicy


class SalesInput(PurchaseInput):
    customer: str | None = Field(default=None, min_length=1, max_length=160)
    shipTo: str | None = Field(default=None, min_length=1, max_length=160)
    csv: str | None = Field(default=None, min_length=1, max_length=16_000)


class InvoiceDocument(Model):
    vendor: str = Field(min_length=1, max_length=160)
    invoiceNumber: Id
    invoiceDate: date
    poId: Id
    currency: Literal["CAD"]
    hstCents: int = Field(ge=0, le=1_000_000_000)
    totalCents: Cents
    lines: list[PricedLine] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def unique_skus(self):
        if len({line.skuId for line in self.lines}) != len(self.lines):
            raise ValueError("Use one line per SKU")
        return self


class InvoiceCaptureInput(PurchaseInput):
    source: Literal["email"]
    attachment: InvoiceDocument | None = None


class ServiceInput(PurchaseInput):
    conversationId: Id
    verifiedCustomerId: Id


class BotControl(Model):
    enabled: bool = True


BotId = Literal["pr-to-po", "collections", "order-entry", "quote", "ap-invoice", "customer-service"]
BOT_IDS = ("pr-to-po", "collections", "order-entry", "quote", "ap-invoice", "customer-service")


class OrderPolicy(Model):
    minMatchConfidenceBps: int = Field(default=8500, ge=8000, le=10_000)


class QuotePolicy(OrderPolicy):
    marginFloorBps: dict[Literal["ppe", "hardware"], Annotated[int, Field(ge=0, le=9500)]] = Field(
        default_factory=lambda: {"ppe": 3000, "hardware": 2500},
    )
    expiryDays: int = Field(default=14, ge=2, le=90)
    reminderDaysBeforeExpiry: int = Field(default=3, ge=1, le=89)

    @model_validator(mode="after")
    def validate_terms(self):
        if set(self.marginFloorBps) != {"ppe", "hardware"} or self.reminderDaysBeforeExpiry >= self.expiryDays:
            raise ValueError("Specify both margin floors and schedule reminders before expiry")
        return self


class ApPolicy(Model):
    hstBps: int = Field(default=1300, ge=0, le=10_000)
    hstToleranceCents: int = Field(default=1, ge=0, le=10)


class ServicePolicy(Model):
    returnWindowDays: int = Field(default=30, ge=1, le=365)
    acceptedConditions: list[Literal["unopened", "resalable"]] = Field(
        default_factory=lambda: ["unopened", "resalable"], min_length=1, max_length=2,
    )
    restockingFeeBps: int = Field(default=1500, ge=0, le=10_000)


class BotPolicies(Model):
    controls: dict[BotId, BotControl] = Field(default_factory=lambda: {bot: BotControl() for bot in BOT_IDS})
    orderEntry: OrderPolicy = Field(default_factory=OrderPolicy)
    quote: QuotePolicy = Field(default_factory=QuotePolicy)
    apInvoice: ApPolicy = Field(default_factory=ApPolicy)
    customerService: ServicePolicy = Field(default_factory=ServicePolicy)

    @model_validator(mode="after")
    def complete_controls(self):
        if set(self.controls) != set(BOT_IDS):
            raise ValueError("Specify controls for all six bots")
        return self


class AllPolicyUpdate(PolicyUpdate):
    bots: BotPolicies | None = None


DEFAULT_PROCUREMENT = ProcurementPolicy(
    budgetCents={"stock-toronto": 500_000},
    authorityCents={"reader": 0, "operator": 100_000, "approver": 500_000, "admin": 1_000_000},
    managerThroughCents=50_000, financeThroughCents=250_000, priceToleranceBps=200,
)
DEFAULT_COLLECTIONS = CollectionsPolicy(
    channelEnabled={"email": True, "voice": False, "sms": False},
    cadence={
        "1-30": DunningRule(daysBetween=7, channels=["email"]),
        "31-60": DunningRule(daysBetween=5, channels=["email", "sms"]),
        "61-90": DunningRule(daysBetween=4, channels=["email", "voice", "sms"]),
        "91+": DunningRule(daysBetween=3, channels=["email", "voice"]),
    },
    escalationDays=91, maxPlanCents=500_000, maxInstallments=4, maxPlanDays=90,
)
