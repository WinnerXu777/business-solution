"""Run and resume registered LangGraph bots through a bounded tool gateway."""

from collections.abc import Callable
from contextvars import ContextVar
from copy import deepcopy
from dataclasses import dataclass
from hashlib import sha256
import json
from time import monotonic
from typing import Any

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.types import Command

from ..chat.gateway import Gateway, request_type, result_types
from ..contracts_v1 import Approval, CallEnvelope
from .store import BotRun, BotStore

dispatch_timeout_ms = ContextVar("bot_dispatch_timeout_ms", default=None)


class RunStopped(Exception):
    """The fixture host cancelled before dispatching the current tool."""


class BudgetExceeded(Exception):
    pass


class OutcomeUnknown(Exception):
    pass


class RunConflict(ValueError):
    pass


def fingerprint(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return sha256(encoded.encode()).hexdigest()


def denied(code: str) -> dict:
    return {"state": "denied", "code": code, "message": code.replace("_", " ")}


def failed(message: str) -> dict:
    return {"state": "failed", "code": "unavailable", "message": message, "retryable": False}


def unknown(action_id: str) -> dict:
    return {"state": "unknown", "actionId": action_id, "message": "Reconcile the action outcome."}


@dataclass(frozen=True)
class BotDefinition:
    id: str
    version: int
    graph_factory: Callable[[Callable, BaseCheckpointSaver], Any]
    allowed_tools: frozenset[str]
    max_actions: int
    max_seconds: float

    def __post_init__(self):
        if not self.id or self.version < 1 or self.max_actions < 1 or self.max_seconds <= 0:
            raise ValueError("Invalid bot definition bounds")
        if self.allowed_tools - result_types.keys():
            raise ValueError("Unregistered tool in bot definition")

    def describe(self) -> dict:
        return {
            "id": self.id, "version": self.version, "allowedTools": sorted(self.allowed_tools),
            "maxActions": self.max_actions, "maxSeconds": self.max_seconds,
        }


class BotRegistry:
    def __init__(self, *definitions: BotDefinition):
        self._definitions = {}
        for definition in definitions:
            key = definition.id, definition.version
            if key in self._definitions:
                raise ValueError("Duplicate bot version")
            self._definitions[key] = definition

    def get(self, bot_id: str, version: int) -> BotDefinition:
        return self._definitions[bot_id, version]

    def list(self) -> list[dict]:
        return [self._definitions[key].describe() for key in sorted(self._definitions)]


class BotRuntime:
    def __init__(
        self, registry: BotRegistry, store: BotStore, gateway: Gateway, clock=monotonic,
    ):
        self.registry = registry
        self.store = store
        self.gateway = gateway
        self.clock = clock

    def start(
        self, run_id: str, bot_id: str, version: int, envelope: dict, inputs: dict,
        emit: Callable | None = None,
    ) -> BotRun:
        definition = self.registry.get(bot_id, version)
        scope = CallEnvelope.model_validate(envelope).model_dump()
        tenant = scope["tenantId"]
        material = fingerprint([bot_id, version, inputs, scope["source"], scope["idempotencyKey"]])
        with self.store.lease(tenant, run_id):
            prior = self.store.load(tenant, run_id)
            if prior:
                if prior.envelope["actor"] != scope["actor"]:
                    raise KeyError(run_id)
                if prior.fingerprint != material:
                    raise RunConflict("Run key already bound to different input")
                if prior.status == "running":
                    return self._advance(prior, emit)
                return prior
            run = BotRun(
                run_id, bot_id, version, scope, material, deepcopy(inputs),
                remaining_seconds=definition.max_seconds,
            )
            self._event(run, emit, "started")
            return self._advance(run, emit)

    def resume(
        self, run_id: str, decision: dict, approval_id: str,
        emit: Callable | None = None,
    ) -> BotRun:
        decision = CallEnvelope.model_validate(decision).model_dump()
        tenant = decision["tenantId"]
        with self.store.lease(tenant, run_id):
            run = self.store.load(tenant, run_id)
            if not run:
                raise KeyError(run_id)
            if run.resume_value:
                if run.resume_value["actor"] != decision["actor"] or run.resume_value["approvalId"] != approval_id:
                    raise KeyError(run_id)
                return self._advance(run, emit) if run.status == "running" else run
            if run.status != "pending_approval":
                raise RunConflict("Run is not waiting for approval")
            approval = run.pending["approval"]
            if (
                decision["actor"] != {"id": approval["approverId"], "kind": "person"}
                or decision["actor"]["id"] == approval["requestedBy"]
                or approval_id != approval["id"]
            ):
                raise KeyError(run_id)
            # Only the gateway can authorize execution. The decision scopes the approver.
            run.resume_value = {"envelope": decision, "actor": decision["actor"], "approvalId": approval_id}
            run.status = "running"
            self._event(run, emit, "resumed")
            return self._advance(run, emit)

    def cancel(self, run_id: str, scope: dict, emit: Callable | None = None) -> BotRun:
        tenant = scope["tenantId"]
        run = self._owned_run(run_id, scope)
        if run.status in {"running", "pending_approval"}:
            self.store.request_cancel(tenant, run_id)
        with self.store.lease(tenant, run_id):
            run = self._owned_run(run_id, scope)
            if run.status in {"running", "pending_approval"}:
                # A journaled call with no outcome needs reconciliation.
                unresolved = next((step for step in run.steps.values() if "result" not in step), None)
                if unresolved:
                    self._finish(run, emit, unknown(unresolved["key"]))
                else:
                    self._cancel(run, emit)
            return run

    def stream(self, run_id: str, scope: dict, after: int = 0):
        run = self._owned_run(run_id, scope)
        yield from (event for event in run.events if event["id"] > after)

    def _owned_run(self, run_id, scope):
        run = self.store.load(scope["tenantId"], run_id)
        if not run or run.envelope["actor"] != scope["actor"]:
            raise KeyError(run_id)
        return run

    def _event(self, run, emit, kind, **fields):
        event = {"id": len(run.events) + 1, "kind": kind, "runId": run.id, **fields}
        run.events.append(event)
        self.store.save(run.envelope["tenantId"], run)
        if emit:
            emit(deepcopy(event))

    def _finish(self, run, emit, result):
        run.result = result
        run.pending = None
        run.status = {"ok": "completed"}.get(result["state"], result["state"])
        self._event(run, emit, "settled", status=run.status)

    def _cancel(self, run, emit):
        run.cancelled = True
        run.status = "cancelled"
        run.pending = None
        run.result = failed("Bot run cancelled.")
        self._event(run, emit, "cancelled")

    def _advance(self, run, emit):
        tenant = run.envelope["tenantId"]
        definition = self.registry.get(run.bot_id, run.version)
        deadline = self.clock() + run.remaining_seconds

        def check_cancel():
            if self.store.cancellation_requested(tenant, run.id):
                raise RunStopped

        def remaining():
            check_cancel()
            run.remaining_seconds = max(0, deadline - self.clock())
            if run.remaining_seconds == 0:
                raise BudgetExceeded

        def call(step_id, tool, inputs, *, approver=False):
            check_cancel()
            if tool not in definition.allowed_tools:
                raise ValueError("Tool unavailable to this bot")
            if approver and not run.resume_value:
                raise ValueError("Approver context missing")
            scope = run.resume_value["envelope"] if approver else run.envelope
            # Stable across restart and legacy inbox retries. Never supplied by tool output.
            seed = run.resume_value["approvalId"] if approver else run.id
            key = fingerprint([tenant, seed, tool, step_id])
            envelope = {**scope, "idempotencyKey": key}
            call_input = request_type.validate_python({
                "tool": tool, "envelope": envelope, "input": inputs,
            }).model_dump(mode="json")
            material = fingerprint([tool, inputs, approver])
            prior = run.steps.get(step_id)
            if prior:
                if prior["fingerprint"] != material or "result" not in prior:
                    raise OutcomeUnknown(prior["key"])
                return deepcopy(prior["result"])
            remaining()
            if len(run.steps) >= definition.max_actions:
                raise BudgetExceeded
            step = {"tool": tool, "fingerprint": material, "key": key}
            run.steps[step_id] = step
            self._event(run, emit, "step_started", stepId=step_id, tool=tool)
            timeout = dispatch_timeout_ms.set(max(1, int(run.remaining_seconds * 1000)))
            try:
                response = self.gateway(tool, envelope, call_input["input"])
                # Results are typed data. No result can select a runtime tool or identity.
                result = result_types[tool].validate_python(response).model_dump(mode="json")
            except RunStopped:
                step["result"] = failed("Dispatch cancelled.")
                self._event(run, emit, "step_settled", stepId=step_id, state="cancelled")
                raise
            except Exception as exc:
                raise OutcomeUnknown(key) from exc
            finally:
                dispatch_timeout_ms.reset(timeout)
            step["result"] = result
            run.remaining_seconds = max(0, deadline - self.clock())
            self._event(run, emit, "step_settled", stepId=step_id, state=result["state"])
            return deepcopy(result)

        config = {"configurable": {"thread_id": run.id}, "recursion_limit": 32}
        try:
            check_cancel()
            graph = definition.graph_factory(call, self.store.saver(tenant))
            snapshot = graph.get_state(config)
            # The approval node restarts from its beginning. Its tool outcome is journaled.
            if snapshot.interrupts:
                value = Command(resume=run.resume_value["envelope"]) if run.resume_value else None
                state = graph.invoke(value, config=config) if value else snapshot.values
            elif snapshot.next:
                state = graph.invoke(None, config=config)
            elif snapshot.values:
                state = snapshot.values
            else:
                state = graph.invoke({**run.initial, "envelope": run.envelope}, config=config)
            snapshot = graph.get_state(config)
            if snapshot.interrupts:
                pending = snapshot.interrupts[0].value
                approval = Approval.model_validate(pending["approval"]).model_dump()
                if approval["tenantId"] != tenant or approval["requestedBy"] != run.envelope["actor"]["id"]:
                    raise ValueError("Approval scope mismatch")
                remaining()
                run.pending = pending
                run.resume_value = None
                run.status = "pending_approval"
                self._event(run, emit, "approval_required", approvalId=approval["id"])
            else:
                result = state["result"]
                run.remaining_seconds = max(0, deadline - self.clock())
                self._finish(run, emit, result)
        except RunStopped:
            self._cancel(run, emit)
        except BudgetExceeded:
            self._finish(run, emit, failed("Bot action or time budget exhausted."))
        except OutcomeUnknown as exc:
            self._finish(run, emit, unknown(str(exc)))
        except Exception:
            self._finish(run, emit, failed("Bot could not complete the run."))
        return run
