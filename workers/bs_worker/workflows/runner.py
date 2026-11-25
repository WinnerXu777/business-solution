"""Workflow runner seam and the process-local implementation."""

from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Protocol

from ..chat.gateway import Gateway, result_types
from ..contracts_v1 import CallEnvelope
from ..runtime.bots import denied, fingerprint, unknown
from .definition import (
    Action, ApprovalNode, Definition, Delay, StartInput, WIN_BACK, action_input,
    is_effect, preview, transition, validate_trigger,
)


class WorkflowConflict(ValueError):
    pass


class WorkflowQuota(WorkflowConflict):
    pass


class WorkflowRunner(Protocol):
    def publish(self, scope: dict, definition: Definition) -> dict: ...
    def definitions(self, scope: dict) -> list[dict]: ...
    def preview(self, scope: dict, definition_id: str, version: int, start: StartInput) -> list[dict]: ...
    def start(self, scope: dict, definition_id: str, version: int, start: StartInput, now: int) -> dict: ...
    def tick(self, scope: dict, run_id: str, now: int) -> dict: ...
    def approve(self, scope: dict, run_id: str, approval_id: str, now: int) -> dict: ...
    def replay(self, scope: dict, run_id: str, now: int) -> dict: ...
    def list_runs(self, scope: dict, dead_only: bool = False) -> list[dict]: ...
    def history(self, scope: dict, run_id: str) -> dict: ...


@dataclass
class WorkflowRun:
    id: str
    scope: dict
    definition: Definition
    material: str
    cursor: str | None
    values: dict
    status: str = "running"
    due_at: int | None = None
    approval: dict | None = None
    attempts: int = 0
    history: list[dict] = field(default_factory=list)
    result: dict | None = None
    replays: int = 0
    replayable: bool = False


ACTIVE = {"running", "delayed", "retrying", "pending_approval"}
DEAD = {"failed", "unknown"}


class LocalWorkflowRunner:
    """One serialized command at a time. A durable runner persists transitions before relay."""

    def __init__(
        self, gateway: Gateway, *, active_limit=16, action_limit=128,
        policy: Callable[[dict, str, dict], bool] | None = None,
    ):
        self.gateway = gateway
        self.policy = policy
        self.active_limit = active_limit
        self.action_limit = action_limit
        self._definitions = {}
        self._runs = {}
        self._windows = {}
        self._approvals = {}

    def publish(self, scope, definition):
        key = scope["tenantId"], definition.id, definition.version
        if definition.id == WIN_BACK.id or key in self._definitions:
            raise WorkflowConflict("Published versions are immutable")
        self._definitions[key] = definition.model_copy(deep=True)
        return definition.model_dump(mode="json")

    def definitions(self, scope):
        definitions = [WIN_BACK, *(value for key, value in self._definitions.items() if key[0] == scope["tenantId"])]
        return [value.model_dump(mode="json") for value in sorted(definitions, key=lambda item: (item.id, item.version))]

    def _definition(self, scope, definition_id, version):
        if (definition_id, version) == (WIN_BACK.id, WIN_BACK.version):
            return WIN_BACK
        return self._definitions[scope["tenantId"], definition_id, version]

    def preview(self, scope, definition_id, version, start):
        return preview(self._definition(scope, definition_id, version), start)

    def _admit(self, tenant):
        if sum(run.status in ACTIVE for (owner, _), run in self._runs.items() if owner == tenant) >= self.active_limit:
            raise WorkflowQuota("Tenant active run limit reached")

    def start(self, scope, definition_id, version, start, now):
        scope = CallEnvelope.model_validate(scope).model_dump()
        definition = self._definition(scope, definition_id, version)
        validate_trigger(definition, start.trigger)
        tenant = scope["tenantId"]
        trigger_key = start.trigger.key
        identity = [tenant, definition_id, start.trigger.kind, start.trigger.name]
        if trigger_key is None:
            identity.extend([scope["actor"], scope["idempotencyKey"]])
        else:
            identity.append(trigger_key)
        run_id = fingerprint(identity)
        material = fingerprint([definition_id, version, start.model_dump(mode="json")])
        prior = self._runs.get((tenant, run_id))
        if prior:
            if prior.scope["actor"] != scope["actor"]:
                raise KeyError(run_id)
            if prior.material != material:
                raise WorkflowConflict("Run key already bound to different input")
            return self._view(prior)
        self._admit(tenant)
        run = WorkflowRun(run_id, scope, definition, material, definition.nodes[0].id, dict(start.values))
        self._runs[tenant, run_id] = run
        self._event(run, now, "started")
        return self._advance(run, now)

    def _find(self, scope, run_id, *, approval=False):
        run = self._runs[scope["tenantId"], run_id]
        expected = {"id": run.approval["approverId"], "kind": "person"} if approval and run.approval else run.scope["actor"]
        if scope["actor"] != expected:
            raise KeyError(run_id)
        return run

    def tick(self, scope, run_id, now):
        run = self._find(scope, run_id)
        if run.status in {"delayed", "retrying"} and now >= run.due_at:
            return self._advance(run, now)
        return self._view(run)

    def approve(self, scope, run_id, approval_id, now):
        run = self._find(scope, run_id, approval=True)
        approval = run.approval
        if (
            not approval or approval["id"] != approval_id
            or scope["actor"]["id"] == run.scope["actor"]["id"]
            or run.status != "pending_approval"
        ):
            raise KeyError(run_id)
        # The host signs through the gateway before submitting the decision.
        self._event(run, now, "resumed", approvalId=approval_id)
        return self._advance(run, now)

    def replay(self, scope, run_id, now):
        run = self._find(scope, run_id)
        if not run.replayable or run.status != "failed" or run.replays >= 1:
            raise WorkflowConflict("Run cannot be replayed")
        self._admit(scope["tenantId"])
        run.replays += 1
        run.attempts = 0
        self._event(run, now, "replayed")
        return self._advance(run, now)

    def list_runs(self, scope, dead_only=False):
        return [
            self._view(run, history=False) for run in reversed(self._runs.values())
            if run.scope["tenantId"] == scope["tenantId"] and run.scope["actor"] == scope["actor"]
            and (not dead_only or run.status in DEAD)
        ]

    def history(self, scope, run_id):
        return self._view(self._find(scope, run_id))

    def _event(self, run, now, kind, **details):
        run.history.append({
            "id": len(run.history) + 1, "at": now, "kind": kind, "nodeId": run.cursor, **details,
        })

    def _view(self, run, history=True):
        view = {
            "id": run.id, "definitionId": run.definition.id, "version": run.definition.version,
            "status": run.status, "nodeId": run.cursor, "dueAt": run.due_at,
            "approval": run.approval if run.status == "pending_approval" else None,
            "result": run.result, "replayable": run.replayable and run.replays < 1,
        }
        if history:
            view["history"] = run.history
        return deepcopy(view)

    def _settle(self, run, now, result, replayable=False):
        run.result = result
        run.replayable = replayable
        run.status = "completed" if result is None or result["state"] == "ok" else result["state"]
        if run.status in DEAD:
            self._event(run, now, "dead_lettered", state=run.status)
        self._event(run, now, "settled", state=run.status)

    def _retry(self, run, node, now, result):
        retryable = result["state"] == "failed" and result["retryable"]
        if retryable and run.attempts < node.maxAttempts:
            run.status = "retrying"
            run.due_at = now + node.backoffMs * 2 ** (run.attempts - 1)
            run.result = result
            self._event(run, now, "retry_scheduled", dueAt=run.due_at)
        else:
            self._settle(run, now, result, replayable=retryable)
        return self._view(run)

    def _call(self, run, node, inputs, phase, now):
        tool = node.action.tool
        action_key = fingerprint([run.scope["tenantId"], run.id, node.id, phase])
        scope = {**run.scope, "idempotencyKey": action_key}
        window = (scope["tenantId"], now // 60_000)
        if self._windows.get(window, 0) >= self.action_limit:
            return denied("quota_exceeded")
        self._windows = {key: count for key, count in self._windows.items() if key[1] >= window[1]}
        self._windows[window] = self._windows.get(window, 0) + 1
        self._event(run, now, "dispatch", tool=tool, phase=phase, attempt=run.attempts)
        try:
            if self.policy and not self.policy(scope, tool, deepcopy(inputs)):
                return denied("forbidden")
            result = result_types[tool].validate_python(self.gateway(tool, scope, inputs)).model_dump(mode="json")
            if result["state"] == "ok":
                output = result["output"]
                if tool == "order.read" and (
                    output["id"] != inputs["orderId"] or output["tenantId"] != scope["tenantId"]
                ):
                    return denied("not_found")
                if tool == "workflow.template.run" and (
                    output["templateId"] != inputs["templateId"]
                    or any(item["tenantId"] != scope["tenantId"] for item in output["previews"])
                ):
                    return unknown(action_key)
            return result
        except Exception:
            return unknown(action_key)

    def _advance(self, run, now):
        nodes = {node.id: node for node in run.definition.nodes}
        run.status = "running"
        run.due_at = None
        run.replayable = False
        while run.cursor is not None:
            node = nodes[run.cursor]
            try:
                if isinstance(node, Delay):
                    run.cursor = node.next
                    run.due_at = now + node.milliseconds
                    run.status = "delayed"
                    self._event(run, now, "delayed", delayNodeId=node.id, dueAt=run.due_at)
                    return self._view(run)
                if isinstance(node, ApprovalNode):
                    action = nodes[node.next]
                    run.attempts += 1
                    result = self._call(run, action, action_input(action, run.values), "prepare", now)
                    if result["state"] != "pending_approval":
                        if result["state"] == "ok":
                            result = denied("invalid_approval")
                        return self._retry(run, action, now, result)
                    approval = result["approval"]
                    approval_key = approval["tenantId"], approval["id"]
                    if (
                        approval["tenantId"] != run.scope["tenantId"]
                        or approval["requestedBy"] != run.scope["actor"]["id"]
                        or approval["tool"] != action.action.tool
                        or approval["subjectId"] != action.action.templateId
                        or approval["state"] != "pending"
                        or self._approvals.get(approval_key, run.id) != run.id
                    ):
                        self._settle(run, now, denied("invalid_approval"))
                        return self._view(run)
                    self._approvals[approval_key] = run.id
                    run.approval = approval
                    run.cursor = node.next
                    run.attempts = 0
                    run.result = None
                    run.status = "pending_approval"
                    self._event(run, now, "approval_required", approvalId=approval["id"])
                    return self._view(run)
                if isinstance(node, Action):
                    run.attempts += 1
                    inputs = action_input(node, run.values, run.approval["id"] if is_effect(node) else None)
                    result = self._call(run, node, inputs, "execute", now)
                    if result["state"] != "ok":
                        if result["state"] == "pending_approval":
                            result = denied("invalid_approval")
                        return self._retry(run, node, now, result)
                    run.result = result
                    run.approval = None
                    run.attempts = 0
                self._event(run, now, "node_completed", nodeKind=node.kind)
                run.cursor, run.values = transition(node, run.values)
            except (ValueError, KeyError):
                self._settle(run, now, {
                    "state": "failed", "code": "invalid_input",
                    "message": "Workflow node input is invalid.", "retryable": False,
                })
                return self._view(run)
        self._settle(run, now, run.result)
        return self._view(run)


def run_win_back(gateway: Gateway, envelope: dict, mode: str, approval_id: str | None = None) -> dict:
    """Original fixture adapter for callers using the shared tool result directly."""
    if mode == "preview" and approval_id is not None:
        raise ValueError("Preview does not take an approval")
    plan = preview(WIN_BACK, StartInput.model_validate({"trigger": {"kind": "manual"}}))
    action = plan[-1]
    return gateway(action["tool"], envelope, {**action["input"], "mode": mode, "approvalId": approval_id})
