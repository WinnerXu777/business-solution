"""Process-local execution of the typed builder catalog through a governed relay."""

import json
from collections import deque
from copy import deepcopy
from dataclasses import dataclass, field
from hashlib import sha256

from ..contracts_v1 import CallEnvelope
from .builder_definition import ID, WRITES, migration_prefix, validate_definition, validate_inputs
from .errors import WorkflowConflict, WorkflowQuota

ACTIVE = {"running", "delayed", "waiting", "task", "approval", "checkpoint"}
MAX_THROTTLE_LIMIT = 1000


def fingerprint(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return sha256(encoded.encode()).hexdigest()


@dataclass(frozen=True)
class Draft:
    text: str


@dataclass
class Loop:
    node: dict
    items: list
    initial: dict
    index: int = 0


@dataclass
class Run:
    id: str
    scope: dict
    definition: dict
    fingerprint: str
    cursor: str | None
    values: dict
    status: str = "running"
    due: int | None = None
    pending: dict | None = None
    binding: dict | None = None
    loop: Loop | None = None
    history: list[dict] = field(default_factory=list)
    error: str | None = None

    def view(self):
        return deepcopy({
            "id": self.id, "definitionId": self.definition["id"], "version": self.definition["version"],
            "nodeId": self.cursor, "status": self.status, "dueAt": self.due, "pending": self.pending,
            "error": self.error, "history": self.history,
        })

    def log(self, kind, now, **details):
        self.history.append({"kind": kind, "at": now, "nodeId": self.cursor, **details})


def resolve(value, values):
    return values[value["ref"]] if isinstance(value, dict) else value


def split(tenant, definition, node, key):
    material = fingerprint([tenant, definition, node, key])
    return int(material[:16], 16) % 100


def loop_step(run, body):
    loop = run.loop
    run.values = loop.initial.copy()
    if loop.index == len(loop.items):
        run.loop = None
        return loop.node["next"]
    run.values[loop.node["item"]] = loop.items[loop.index]
    return body


def control(run, node):
    """Pure graph operations. Return the next cursor or the normal continuation."""
    kind = node["kind"]
    values = run.values
    get = lambda key: resolve(node[key], values)
    if kind == "branch":
        return node["next"] if get("left") == node["equals"] else node["otherwise"]
    if kind == "switch":
        return next((case["next"] for case in node["cases"] if case["equals"] == get("value")), node["otherwise"])
    if kind == "mapping":
        run.values = {**values, **{key: resolve(value, values) for key, value in node["values"].items()}}
    if kind == "ab-split":
        bucket = split(run.scope["tenantId"], run.definition["id"], node["id"], get("key"))
        return node["next"] if bucket < node["aPercent"] else node["otherwise"]
    if kind == "loop":
        items = get("items")
        if len(items) > node["maxItems"]:
            raise ValueError("Loop exceeds maxItems")
        run.loop = Loop(node, items, values)
        return loop_step(run, node["body"])
    if kind == "loop-end":
        run.loop.index += 1
        return loop_step(run, run.loop.node["body"])
    return node["next"]


def operation(node, values):
    kind = node["kind"]
    if kind == "message":
        names = ("recipientId", "sourceId", "body")
        result = {key: resolve(node[key], values) for key in names if key in node}
        if isinstance(result.get("body"), Draft):
            result["body"] = result["body"].text
            result["untrustedDraft"] = True
        result.update(channel=node["channel"], purpose=node["purpose"])
        ids = ("recipientId", "sourceId")
    elif kind == "http":
        result = {key: node[key] for key in ("connector", "operation")}
        result["recordId"] = resolve(node["recordId"], values)
        ids = ("recordId",)
    else:
        field = "subjectId" if kind == "create-record" else "recordId"
        result = {field: resolve(node[field], values), "recordType": node["recordType"],
                  "summary": resolve(node["summary"], values)}
        ids = (field,)
    if any(not ID.fullmatch(result[key]) for key in ids):
        raise ValueError("Expected valid record identifiers")
    return result


def preview(definition, values, tenant):
    run = Run("preview", {"tenantId": tenant}, definition, "", definition["nodes"][0]["id"],
              validate_inputs(definition, values).copy())
    nodes = {node["id"]: node for node in definition["nodes"]}
    plan = []
    while run.cursor is not None:
        node = nodes[run.cursor]
        kind = node["kind"]
        step = {"nodeId": run.cursor, "kind": kind}
        if kind in WRITES:
            step.update(input=operation(node, run.values), approvalRequired=True)
            if "output" in node:
                run.values[node["output"]] = "fixture-preview-record"
        if kind == "llm-draft":
            step["prompt"] = resolve(node["prompt"], run.values)
            run.values[node["output"]] = Draft("Fictional preview draft for review.")
        if kind == "human-task":
            step.update(role=node["role"], title=resolve(node["title"], run.values), dueMs=node["dueMs"])
        if kind == "wait-for-event":
            step.update(event=node["event"], timeoutMs=node["timeoutMs"])
        plan.append(step)
        run.cursor = control(run, node)
    return {"plan": plan, "receipts": []}


class BuilderRunner:
    """Serial commands. Only the host may attest roles, events and approvals."""

    def __init__(self, relay, connectors=(), *, active_limit=16, run_limit=100, before_effect=None):
        self.relay = relay
        self.connectors = frozenset(tuple(pair) for pair in connectors)
        self.active_limit = active_limit
        self.run_limit = run_limit
        self.before_effect = before_effect
        self.versions = {}
        self.releases = {}
        self.runs = {}
        self.quotas = {}
        self.throttles = {}
        self.tickets = set()

    def publish(self, scope, definition):
        validate_definition(definition, self.connectors)
        key = scope["tenantId"], definition["id"], definition["version"]
        if key in self.versions:
            if fingerprint(self.versions[key]) != fingerprint(definition):
                raise WorkflowConflict("Published versions are immutable")
        else:
            self.versions[key] = deepcopy(definition)
        return deepcopy(self.versions[key])

    def release(self, scope, definitionId, version):
        self.versions[scope["tenantId"], definitionId, version]
        self.releases[scope["tenantId"], definitionId] = version
        return {"definitionId": definitionId, "version": version}

    def start(self, scope, definitionId, trigger, values, key, now, version=None):
        scope = CallEnvelope.model_validate(scope).model_dump()
        tenant = scope["tenantId"]
        if not isinstance(key, str) or not ID.fullmatch(key):
            raise ValueError("Stable run key required")
        identity = [tenant, definitionId, trigger, key]
        if trigger == "manual":
            identity.append(scope["actor"])
        run_id = fingerprint(identity)
        prior = self.runs.get((tenant, run_id))
        if prior:
            if prior.scope["actor"] != scope["actor"]:
                raise KeyError(run_id)
            pinned = prior.definition["version"] if version is None else version
            # The original material persists separately from the migrated definition.
            if fingerprint([trigger, values]) != prior.fingerprint or (
                version is not None and pinned != prior.history[0]["version"]
            ):
                raise WorkflowConflict("Run key already bound to different input")
            return prior.view()
        if version is None:
            version = self.releases[tenant, definitionId]
        definition = self.versions[tenant, definitionId, version]
        if trigger != definition["nodes"][0]["trigger"]:
            raise ValueError("Trigger does not match definition")
        validate_inputs(definition, values)
        active = sum(run.status in ACTIVE for (owner, _), run in self.runs.items() if owner == tenant)
        if active >= self.active_limit:
            raise WorkflowQuota("Tenant active run limit reached")
        window = now // 60_000
        prior_window, count = self.quotas.get(tenant, (window, 0))
        if window > prior_window:
            count = 0
        if count >= self.run_limit:
            raise WorkflowQuota("Tenant run quota reached")
        self.quotas[tenant] = max(window, prior_window), count + 1
        run = Run(run_id, scope, definition, fingerprint([trigger, values]), definition["nodes"][0]["id"],
                  deepcopy(values))
        self.runs[tenant, run_id] = run
        run.log("started", now, version=version)
        return self.advance(run, now)

    def find(self, scope, runId, owner=True):
        run = self.runs[scope["tenantId"], runId]
        if owner and run.scope["actor"] != scope["actor"]:
            raise KeyError(runId)
        return run

    def read(self, scope, runId):
        return self.find(scope, runId).view()

    def recover(self):
        return [
            {"scope": run.scope, "run": run.view()} for run in self.runs.values()
            if run.status in ACTIVE and run.due is not None
        ]

    def inbox(self, scope, roles, now):
        if scope["actor"]["kind"] != "person":
            return []
        actor, tenant = scope["actor"]["id"], scope["tenantId"]
        return [
            {"runId": run.id, "kind": run.status, "pending": deepcopy(run.pending)}
            for (owner, _), run in self.runs.items()
            if owner == tenant and run.due is not None and now < run.due and (
                (run.status == "task" and run.pending["role"] in roles)
                or (run.status == "approval" and run.pending["approverId"] == actor)
            )
        ]

    def migrate(self, scope, runId, fromVersion, toVersion, now):
        run = self.find(scope, runId)
        new = self.versions[scope["tenantId"], run.definition["id"], toVersion]
        if run.status != "checkpoint" or run.definition["version"] != fromVersion or fromVersion == toVersion:
            raise WorkflowConflict("Migration requires the expected version at a checkpoint")
        try:
            compatible = (
                new["inputs"] == run.definition["inputs"]
                and fingerprint(migration_prefix(new, run.cursor)) == fingerprint(migration_prefix(run.definition, run.cursor))
            )
        except ValueError:
            compatible = False
        if not compatible:
            raise WorkflowConflict("Checkpoint prefix or input contract changed")
        run.definition = new
        run.log("migrated", now, fromVersion=fromVersion, toVersion=toVersion)
        return run.view()

    def tick(self, scope, runId, now):
        run = self.find(scope, runId)
        if run.status == "checkpoint":
            return self.resume(run, "next", now)
        if run.due is None or now < run.due:
            return run.view()
        if run.status in {"waiting", "task"}:
            return self.resume(run, "onTimeout", now)
        if run.status == "approval":
            return self.fail(run, "approval_expired", now, "denied")
        if run.status == "delayed":
            if run.pending:
                return self.advance(run, now)
            return self.resume(run, "next", now)
        return run.view()

    def event(self, scope, runId, event, key, now):
        run = self.find(scope, runId, owner=False)
        if run.status != "waiting" or (event, key) != (run.pending["event"], run.pending["key"]):
            raise KeyError(runId)
        if now < run.pending["since"]:
            return run.view()
        return self.resume(run, "next" if now < run.due else "onTimeout", now)

    def task(self, scope, runId, taskId, roles, now):
        run = self.find(scope, runId, owner=False)
        if (
            run.status != "task" or run.pending["id"] != taskId
            or scope["actor"]["kind"] != "person" or run.pending["role"] not in roles
        ):
            raise KeyError(runId)
        return self.resume(run, "next" if now < run.due else "onTimeout", now)

    def approve(self, scope, runId, approvalId, now):
        run = self.find(scope, runId, owner=False)
        if (
            run.status != "approval" or approvalId != run.pending["id"]
            or scope["actor"] != {"kind": "person", "id": run.pending["approverId"]}
        ):
            raise KeyError(runId)
        if now >= run.due:
            return self.fail(run, "approval_expired", now, "denied")
        node = self.node(run)
        try:
            signed = self.effect(
                run, node, "sign", operation(node, run.values), now,
                approvalId=approvalId, decision=scope, binding=run.binding,
            )
        except Exception:
            return self.fail(run, "approval_outcome_unknown", now, "unknown")
        if signed.get("state") != "ok":
            if signed.get("state") == "unknown":
                return self.fail(run, "approval_outcome_unknown", now, "unknown")
            raise WorkflowConflict("Approval was not signed")
        try:
            material = operation(node, run.values)
            result = self.effect(run, node, "execute", material, now, approvalId=approvalId, binding=run.binding)
            if result.get("state") != "ok":
                return self.rejected(run, result, now)
            if "output" in node:
                record_id = result.get("id")
                if not isinstance(record_id, str) or not ID.fullmatch(record_id):
                    return self.fail(run, "effect_outcome_unknown", now, "unknown")
                run.values[node["output"]] = record_id
        except Exception:
            return self.fail(run, "effect_outcome_unknown", now, "unknown")
        return self.resume(run, "next", now)

    @staticmethod
    def node(run):
        return next(node for node in run.definition["nodes"] if node["id"] == run.cursor)

    def resume(self, run, edge, now):
        run.log("resumed", now, edge=edge)
        run.cursor = self.node(run)[edge]
        return self.advance(run, now)

    def effect(self, run, node, phase, material, now, **extras):
        key = fingerprint([run.id, node["id"], run.loop.index if run.loop else None, phase])
        scope = {**run.scope, "source": "workflow", "idempotencyKey": key}
        if self.before_effect is not None:
            self.before_effect((scope["tenantId"], run.id), now)
        return self.relay({
            "scope": scope, "kind": node["kind"], "phase": phase, "input": deepcopy(material), **extras,
        })

    @staticmethod
    def fail(run, error, now, status="failed"):
        run.status, run.error = status, error
        run.pending = run.due = None
        run.binding = None
        run.log("settled", now, state=status)
        return run.view()

    def rejected(self, run, result, now):
        state = result.get("state")
        if state not in {"denied", "failed", "unknown"}:
            state = "unknown"
        return self.fail(run, "effect_" + state, now, state)

    def advance(self, run, now):
        run.status, run.due, run.pending = "running", None, None
        run.binding = None
        while run.cursor is not None:
            node = self.node(run)
            kind = node["kind"]
            try:
                if kind == "checkpoint":
                    run.status = "checkpoint"
                elif kind == "delay":
                    run.status, run.due = "delayed", now + node["milliseconds"]
                elif kind == "wait-for-event":
                    key = resolve(node["key"], run.values)
                    run.status, run.due = "waiting", now + node["timeoutMs"]
                    run.pending = {"key": key, "event": node["event"], "since": now}
                elif kind == "human-task":
                    run.status, run.due = "task", now + node["dueMs"]
                    run.pending = {
                        "role": node["role"], "title": resolve(node["title"], run.values), "dueAt": run.due,
                        "id": fingerprint([run.id, run.cursor, run.loop.index if run.loop else None]),
                    }
                elif kind == "throttle":
                    bucket = (run.scope["tenantId"], run.definition["id"], node["bucket"])
                    calls = self.throttles.setdefault(bucket, deque(maxlen=MAX_THROTTLE_LIMIT))
                    limit, window = node["limit"], node["windowMs"]
                    if len(calls) >= limit and calls[-limit] > now - window:
                        run.status, run.due = "delayed", calls[-limit] + window
                        run.pending = {"throttle": node["bucket"]}
                    else:
                        calls.append(now)
                elif kind == "llm-draft":
                    prompt = resolve(node["prompt"], run.values)
                    result = self.effect(run, node, "read", {"model": node["model"], "prompt": prompt}, now)
                    text = result.get("text")
                    if result.get("state") != "ok" or not isinstance(text, str) or not 1 <= len(text) <= 4000:
                        return self.rejected(run, result, now)
                    run.values[node["output"]] = Draft(text)
                elif kind in WRITES:
                    material = operation(node, run.values)
                    result = self.effect(run, node, "prepare", material, now)
                    if result.get("state") != "pending_approval":
                        return self.rejected(run, result, now)
                    ticket = result.get("approval", {})
                    ticket_id = ticket.get("id")
                    ticket_key = run.scope["tenantId"], ticket_id
                    approver = ticket.get("approverId")
                    if (
                        not isinstance(ticket_id, str) or not ID.fullmatch(ticket_id) or ticket_key in self.tickets
                        or not isinstance(approver, str) or not ID.fullmatch(approver)
                        or approver == run.scope["actor"]["id"]
                        or type(ticket.get("expiresAt")) is not int or ticket["expiresAt"] <= now
                    ):
                        return self.fail(run, "invalid_approval", now, "denied")
                    self.tickets.add(ticket_key)
                    run.status, run.due = "approval", ticket["expiresAt"]
                    run.binding = deepcopy(result.get("binding"))
                    run.pending = {
                        "id": ticket_id, "approverId": approver, "expiresAt": run.due,
                        "operation": kind, "input": material,
                        **({"review": result["review"]} if "review" in result else {}),
                    }
                if run.status != "running":
                    run.log(run.status, now)
                    return run.view()
                run.log("node_completed", now)
                run.cursor = control(run, node)
            except (ValueError, KeyError):
                return self.fail(run, "invalid_node_input", now)
            except Exception:
                return self.fail(run, "relay_outcome_unknown", now, "unknown")
        run.log("settled", now, state="completed")
        run.status = "completed"
        return run.view()

