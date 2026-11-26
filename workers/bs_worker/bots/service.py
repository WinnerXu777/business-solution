"""Fixture host and tenant-scoped service for the niche bots."""

from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path
from threading import RLock

from ..contracts_v1 import CallEnvelope
from ..runtime.bots import BotRegistry, BotRuntime, fingerprint
from ..runtime.store import MemoryBotStore
from .agents import definitions
from .collections import Collections
from .intake import INTAKE_MODELS, Intake
from .metrics import BotMetrics
from .models import (
    AllPolicyUpdate, ApprovalInput, BillInput, BotPolicies, CollectionsInput, PlanInput, PurchaseInput,
    ReceiptInput, ReplyInput, DEFAULT_COLLECTIONS, DEFAULT_PROCUREMENT,
)
from .procurement import Procurement


FIXTURES = Path(__file__).resolve().parents[3] / "packages/contracts/fixtures/demo.json"
FIXTURE_LOCAL_OFFSET = timezone(timedelta(hours=-5))
FIXTURE_HOLIDAYS = {date(2026, 11, 11), date(2026, 12, 25), date(2026, 12, 28)}
MODELS = {
    "purchase": PurchaseInput, "dunning": CollectionsInput, "reply": ReplyInput, "plan": PlanInput,
    "policy-update": AllPolicyUpdate, "receipt": ReceiptInput, "match": BillInput,
    "resume": ApprovalInput, "approve-draft": ApprovalInput, "approve-plan": ApprovalInput,
    **INTAKE_MODELS,
}
RUNS = {"purchase": "pr-to-po", "dunning": "collections", "reply": "collections", "plan": "collections",
        **{bot: bot for bot in INTAKE_MODELS}}
ROLE_PERMISSIONS = {
    "policy": {"admin"}, "policy-schema": {"admin"}, "policy-update": {"admin"},
    "ap-exceptions": {"operator", "approver", "admin"}, "service-queue": {"operator", "approver", "admin"},
    **{name: {"operator", "admin"} for name in (*RUNS, "receipt", "match")},
    **{name: {"approver", "admin"} for name in ("resume", "approve-draft", "approve-plan")},
}


def fixture_local_time(now):
    return now.astimezone(FIXTURE_LOCAL_OFFSET)


def fixture_can_contact(customer, invoice, channel, now):
    # TODO-verify Ontario/Canada assumptions. These are explicit synthetic approvals
    # for verified corporate contacts, no guarantee, verified balance and complete history.
    if customer["tenantId"] != "tenant-rivetquay" or invoice["tenantId"] != customer["tenantId"]:
        return False
    local = fixture_local_time(now)
    return (
        local.date().month in {11, 12} and local.year == 2026
        and local.weekday() < 5 and local.date() not in FIXTURE_HOLIDAYS and 9 <= local.hour < 17
        and customer["id"] in {"cust-002", "cust-008"}
        and channel in {"email", "voice", "sms"}
    )


class Workspace:
    def __init__(self, fixtures, tenant, local_time, can_contact):
        self.version = 1
        self.procurement_policy = DEFAULT_PROCUREMENT
        self.collections_policy = DEFAULT_COLLECTIONS
        self.bots_policy = BotPolicies()
        self.procurement = Procurement(fixtures, tenant)
        self.collections = Collections(fixtures, tenant, local_time, can_contact)
        self.intake = Intake(fixtures, tenant, self.procurement)
        self.metrics = BotMetrics()

    def policies(self):
        return {
            "version": self.version, "procurement": self.procurement_policy.model_dump(),
            "collections": self.collections_policy.model_dump(), "bots": self.bots_policy.model_dump(),
        }


class Conflict(ValueError):
    pass


class FixtureBots:
    def __init__(self, gateway, sign, *, now=None, local_time=fixture_local_time,
                 can_contact=fixture_can_contact, fixtures=None):
        fixtures = fixtures if fixtures is not None else json.loads(FIXTURES.read_text(encoding="utf-8"))
        self.now = now or (lambda: datetime.fromisoformat(fixtures["asOf"]))
        self.local_time = local_time
        self.sign = sign
        self.workspaces = {
            row["id"]: Workspace(fixtures, row["id"], local_time, can_contact)
            for row in fixtures["workspaces"]
        }
        self.runtime = BotRuntime(BotRegistry(*definitions(self)), MemoryBotStore(), gateway)
        self.lock = RLock()

    def workspace(self, scope):
        return self.workspaces[scope["tenantId"]]

    def dispatch(self, command, scope, role, target=None, body=None):
        scope = CallEnvelope.model_validate(scope).model_dump()
        if role not in ROLE_PERMISSIONS.get(command, {"reader", "operator", "approver", "admin"}):
            raise PermissionError
        if command in {"resume", "approve-draft", "approve-plan", "policy-update"} and scope["actor"]["kind"] != "person":
            raise PermissionError
        model = MODELS.get(command)
        inputs = model.model_validate_json(json.dumps(body)) if model else None
        with self.lock:
            return deepcopy(self._dispatch(command, scope, role, target, inputs))

    def _dispatch(self, command, scope, role, target, inputs):
        workspace = self.workspace(scope)
        procurement, collections = workspace.procurement, workspace.collections
        if command in RUNS:
            return self._start(command, scope, role, inputs, workspace)
        if command == "definitions":
            return self.runtime.registry.list()
        if command == "metrics":
            return workspace.metrics.report()
        if command == "ap-exceptions":
            return list(workspace.intake.ap.exceptions.values())
        if command == "service-queue":
            return list(workspace.intake.service.queue.values())
        if command == "quote-reminders":
            return workspace.intake.sales.reminders(self.local_time(self.now()).date())
        if command == "run":
            run = self.runtime.store.load(scope["tenantId"], target)
            if not run or run.envelope["actor"] != scope["actor"]:
                raise KeyError(target)
            return bot_view(run, workspace)
        if command == "resume":
            run = self.runtime.store.load(scope["tenantId"], target)
            if not run:
                raise KeyError(target)
            if target in workspace.intake.approvals:
                workspace.intake.resume(self, target, scope, inputs.approvalId)
            else:
                run = self.runtime.resume(target, scope, inputs.approvalId)
            view = bot_view(run, workspace)
            workspace.metrics.observe(view, self.now())
            return view
        if command == "policy":
            return workspace.policies()
        if command == "policy-schema":
            return AllPolicyUpdate.model_json_schema()
        if command == "policy-update":
            if inputs.expectedVersion != workspace.version:
                raise Conflict("Policy version changed")
            workspace.procurement_policy = inputs.procurement
            workspace.collections_policy = inputs.collections
            if inputs.bots is not None:
                workspace.bots_policy = inputs.bots
            workspace.version += 1
            return workspace.policies()
        if command == "exceptions":
            return list(procurement.exceptions.values())
        if command == "matches":
            procurement.orders[target]
            return [result for result in procurement.matches.values() if result["orderId"] == target]
        if command == "receipt":
            return procurement.receipt(target, inputs)
        if command == "match":
            return procurement.match(target, inputs, workspace.procurement_policy)
        if command == "approve-draft":
            result = self._approve_draft(procurement, target, inputs.approvalId, scope["actor"]["id"], workspace.version)
            workspace.metrics.local_approved(inputs.approvalId, self.now())
            return result
        if command == "timeline":
            collections.customers[target]
            return collections.events.get(target, [])
        if command in {"promise", "payment-plan", "approve-plan"}:
            collections.invoices[target]
            if command == "promise":
                return collections.promises[target]
            if command == "payment-plan":
                return collections.plans[target]
            result = collections.approve_plan(
                target, inputs.approvalId, scope["actor"]["id"], workspace.version, self.now(),
            )
            workspace.metrics.local_approved(inputs.approvalId, self.now())
            return result
        raise KeyError(command)

    def _start(self, command, scope, role, inputs, workspace):
        if RUNS[command] == "collections":
            workspace.collections.invoices[inputs.invoiceId]
        run_id = fingerprint([scope["tenantId"], scope["actor"], scope["idempotencyKey"]])
        request_fingerprint = fingerprint([command, inputs.model_dump(mode="json")])
        prior = self.runtime.store.load(scope["tenantId"], run_id)
        if prior:
            if prior.initial["requestFingerprint"] != request_fingerprint:
                raise Conflict("Run key is already bound to different input")
            return bot_view(prior, workspace)
        if not workspace.bots_policy.controls[RUNS[command]].enabled:
            raise PermissionError
        started = self.now()
        run = self.runtime.start(run_id, RUNS[command], 1, scope, {
            "command": command, "input": inputs.model_dump(mode="json"), "role": role,
            "inputJson": inputs.model_dump_json(), "localRunId": run_id,
            "requestFingerprint": request_fingerprint,
        })
        view = bot_view(run, workspace)
        workspace.metrics.observe(view, self.now(), started=started)
        return view

    def _approve_draft(self, domain, request_id, approval_id, actor, version):
        draft = domain.drafts[request_id]
        if draft.get("approvalId") != approval_id or draft.get("approverId") != actor or draft["requestedBy"] == actor:
            raise KeyError(request_id)
        order_id = "po-local-" + fingerprint([domain.tenant, approval_id])
        if order_id in domain.orders:
            return {"id": order_id, "draft": domain.orders[order_id], "status": "approved_fixture"}
        if datetime.fromisoformat(draft["expiresAt"]) <= self.now() or draft["policyVersion"] != version:
            raise Conflict("Draft approval is stale")
        domain.orders[order_id] = draft
        return {"id": order_id, "draft": draft, "status": "approved_fixture"}

def bot_view(run, workspace):
    return {
        "id": run.id, "botId": run.bot_id, "version": run.version,
        "status": run.status, "result": run.result, "pending": run.pending,
        **workspace.intake.view(run.id),
    }
