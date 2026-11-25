import unittest
from copy import deepcopy
from tempfile import TemporaryDirectory

from workers.bs_worker.workflows.builder_definition import validate_definition
from workers.bs_worker.workflows.builder_runner import BuilderRunner, preview, split
from workers.bs_worker.workflows.builder_state import BuilderState
from workers.bs_worker.workflows.errors import WorkflowConflict, WorkflowQuota


def identity(actor="actor-operator", tenant="tenant-rivetquay"):
    return {
        "version": "v1", "tenantId": tenant, "actor": {"kind": "person", "id": actor},
        "source": "workflow", "traceId": "trace-1", "correlationId": "correlation-1",
        "idempotencyKey": "key-1",
    }


scope = identity()
approver = identity("actor-approver")
foreign = identity(tenant="tenant-spoolharbour")


def definition(*nodes, inputs=None, version=1, trigger="manual", name="demo"):
    return {
        "id": name, "version": version, "inputs": inputs or {},
        "nodes": [{"id": "trigger", "kind": "trigger", "trigger": trigger, "next": nodes[0]["id"]}, *nodes],
    }


def node(id, kind, **fields):
    return {"id": id, "kind": kind, **fields}


def record(id, kind="create-record", record_id="ord-004", next=None):
    field = {"create-record": "subjectId", "update-record": "recordId"}[kind]
    return node(id, kind, **{field: record_id}, recordType="order-hold", summary="Fictional review",
                output="record", next=next)


class Relay:
    def __init__(self):
        self.calls = []
        self.signed = set()
        self.revoked = False
        self.unknown = False

    def __call__(self, call):
        self.calls.append(deepcopy(call))
        if call["kind"] == "llm-draft":
            return {"state": "ok", "text": "Fictional draft"}
        phase = call["phase"]
        if phase == "prepare":
            return {"state": "pending_approval", "approval": {
                "id": call["scope"]["idempotencyKey"], "approverId": "actor-approver", "expiresAt": 1000,
            }}
        if phase == "sign":
            self.signed.add(call["approvalId"])
            return {"state": "ok"}
        assert phase == "execute" and call["approvalId"] in self.signed
        return {"state": "unknown" if self.unknown else "denied" if self.revoked else "ok", "id": "fixture-hold"}


class BuilderTests(unittest.TestCase):
    def setUp(self):
        self.relay = Relay()
        self.runner = BuilderRunner(self.relay, [("fixture", "lookup")])

    def start(self, graph, values=None, key="first", now=0):
        self.runner.publish(scope, graph)
        self.runner.release(scope, graph["id"], graph["version"])
        return self.runner.start(scope, graph["id"], graph["nodes"][0]["trigger"], values or {}, key, now)

    def test_branch_switch_mapping_ab_and_loop_with_typed_approved_io(self):
        graph = definition(
            node("map", "mapping", values={"selected": {"ref": "active"}}, next="branch"),
            node("branch", "branch", left={"ref": "selected"}, equals=True, next="switch", otherwise=None),
            node("switch", "switch", value="fixture", cases=[{"equals": "fixture", "next": "ab"}], otherwise=None),
            node("ab", "ab-split", key="cust-008", aPercent=100, next="loop", otherwise=None),
            node("loop", "loop", items={"ref": "list"}, item="item", maxItems=2, body="create", next=None),
            record("create", record_id={"ref": "item"}, next="update"),
            record("update", kind="update-record", record_id={"ref": "record"}, next="fetch"),
            node("fetch", "http", connector="fixture", operation="lookup", recordId={"ref": "record"}, output="info", next="end"),
            node("end", "loop-end", loop="loop"), inputs={"active": "boolean", "list": "string-list"},
        )
        fixture = {"active": True, "list": ["ord-001", "ord-004"]}
        rendered = preview(validate_definition(graph, self.runner.connectors), fixture, scope["tenantId"])
        self.assertEqual(rendered["receipts"], [])
        self.assertEqual(len([item for item in rendered["plan"] if item["kind"] == "http"]), 2)
        self.assertEqual(self.relay.calls, [])
        run = self.start(graph, fixture)
        self.assertEqual(run["status"], "approval")
        approvals = []
        for _ in range(6):
            approvals.append(run["pending"]["id"])
            run = self.runner.approve(approver, run["id"], approvals[-1], 10)
        self.assertEqual(run["status"], "completed")
        self.assertEqual(len(set(approvals)), 6)
        self.assertEqual(split("tenant", "flow", "ab", "cust-008"), split("tenant", "flow", "ab", "cust-008"))
        self.assertIn(split("tenant", "flow", "ab", "cust-008"), range(100))
        overflow = self.runner.start(scope, "demo", "manual", {**fixture, "list": ["a", "b", "c"]}, "overflow", 0)
        self.assertEqual(overflow["error"], "invalid_node_input")
        skipped = self.runner.start(scope, "demo", "manual", {**fixture, "active": False}, "skipped", 0)
        self.assertEqual(skipped["status"], "completed")

    def test_wait_task_timeout_delay_and_tenant_throttle(self):
        graph = definition(
            node("throttle", "throttle", bucket="fixture", limit=1, windowMs=100, next="wait"),
            node("wait", "wait-for-event", event="approval.decided", key="ord-001", timeoutMs=20, next="task", onTimeout=None),
            node("task", "human-task", role="purchasing", title="Check SKU", dueMs=10, next="delay", onTimeout=None),
            node("delay", "delay", milliseconds=30, next=None),
        )
        first = self.start(graph)
        second = self.runner.start(scope, "demo", "manual", {}, "second", 1)
        self.assertEqual((first["status"], second["status"], second["dueAt"]), ("waiting", "delayed", 100))
        with self.assertRaises(KeyError):
            self.runner.event(foreign, first["id"], "approval.decided", "ord-001", 10)
        with self.assertRaises(KeyError):
            self.runner.event(scope, first["id"], "approval.decided", "wrong", 10)
        task = self.runner.event(scope, first["id"], "approval.decided", "ord-001", 10)
        self.assertEqual(task["dueAt"], 20)
        self.assertEqual(self.runner.inbox(approver, ["purchasing"], 11)[0]["runId"], first["id"])
        with self.assertRaises(KeyError):
            self.runner.task(approver, first["id"], task["pending"]["id"], ["sales"], 19)
        delayed = self.runner.task(approver, first["id"], task["pending"]["id"], ["purchasing"], 19)
        self.assertEqual(delayed["dueAt"], 49)
        self.assertEqual(self.runner.tick(scope, first["id"], 49)["status"], "completed")
        waiting = self.runner.tick(scope, second["id"], 100)
        self.assertEqual(waiting["dueAt"], 120)
        self.assertEqual(self.runner.event(scope, second["id"], "approval.decided", "ord-001", 120)["status"], "completed")
        self.runner.publish(foreign, graph)
        self.runner.release(foreign, "demo", 1)
        self.assertEqual(self.runner.start(foreign, "demo", "manual", {}, "first", 0)["status"], "waiting")

    def test_draft_requires_separate_review_and_execute_rechecks_policy(self):
        for channel in ("email", "sms", "voice"):
            with self.subTest(channel=channel):
                graph = definition(
                    node("draft", "llm-draft", model="fixture-chat", prompt="Synthetic account facts", output="draft", next="send"),
                    node("send", "message", channel=channel, purpose="transactional", sourceId="ord-001",
                         recipientId="cust-008", body={"ref": "draft"}, next=None),
                    name=channel,
                )
                run = self.start(graph)
                material = run["pending"]["input"]
                self.assertEqual(material["body"], "Fictional draft")
                self.assertIs(material["untrustedDraft"], True)
                with self.assertRaises(KeyError):
                    self.runner.approve(scope, run["id"], run["pending"]["id"], 10)
                self.relay.revoked = channel == "sms"
                self.relay.unknown = channel == "voice"
                result = self.runner.approve(approver, run["id"], run["pending"]["id"], 10)
                self.assertEqual(result["status"], {"email": "completed", "sms": "denied", "voice": "unknown"}[channel])
                prepare, sign, execute = self.relay.calls[-3:]
                self.assertEqual(prepare["input"], sign["input"])
                self.assertEqual(sign["input"], execute["input"])

    def test_versions_rollback_migration_idempotency_and_quotas(self):
        self.runner = BuilderRunner(self.relay, active_limit=1, run_limit=2)
        initial = definition(
            node("save", "checkpoint", next="done"),
            node("done", "mapping", values={"note": "one"}, next=None),
        )
        first = self.start(initial)
        v2 = deepcopy(initial)
        v2["version"] = 2
        v2["nodes"][2]["values"]["note"] = "two"
        self.runner.publish(scope, v2)
        self.runner.release(scope, "demo", 2)
        moved = self.runner.migrate(scope, first["id"], 1, 2, 0)
        self.assertEqual(moved["version"], 2)
        self.assertEqual(self.runner.start(scope, "demo", "manual", {}, "first", 0, version=1), moved)
        with self.assertRaises(WorkflowConflict):
            self.runner.start(scope, "demo", "manual", {}, "first", 0, version=2)
        v3 = deepcopy(v2)
        v3["version"] = 3
        v3["nodes"][0]["id"] = "changed-prefix"
        self.runner.publish(scope, v3)
        with self.assertRaises(WorkflowConflict):
            self.runner.migrate(scope, first["id"], 2, 3, 0)
        with self.assertRaises(WorkflowQuota):
            self.runner.start(scope, "demo", "manual", {}, "other", 1)
        reverted = self.runner.migrate(scope, first["id"], 2, 1, 0)
        self.assertEqual(reverted["version"], 1)
        self.runner.tick(scope, first["id"], 10)
        self.runner.release(scope, "demo", 1)
        other = self.runner.start(scope, "demo", "manual", {}, "second", 10)
        self.assertEqual(other["version"], 1)
        self.runner.tick(scope, other["id"], 10)
        with self.assertRaises(WorkflowConflict):
            self.runner.migrate(scope, other["id"], 1, 2, 10)
        with self.assertRaises(WorkflowQuota):
            self.runner.start(scope, "demo", "manual", {}, "third", 10)

    def test_schema_and_graph_fail_closed(self):
        message = node("msg", "message", channel="email", purpose="marketing", sourceId="ord-001",
                       recipientId={"ref": "missing"}, next=None)
        for graph in (
            definition(message),
            definition(node("delay", "delay", milliseconds=True, next=None)),
            definition(node("delay", "delay", milliseconds=1, next="trigger")),
            definition(node("delay", "delay", milliseconds=1, next=None), node("extra", "checkpoint", next=None)),
            definition(node("fetch", "http", connector="fixture", operation="other", recordId="ord-001", output="result", next=None)),
            definition(node("end", "loop-end", loop="trigger")),
        ):
            with self.subTest(graph=graph), self.assertRaises(ValueError):
                validate_definition(graph, self.runner.connectors)

    def test_interrupted_effect_holds_receipt_for_reconciliation(self):
        with TemporaryDirectory() as directory:
            state = BuilderState(directory)
            waiting = self.start(definition(record("hold")))
            self.runner.before_effect = lambda key, at: state.save(self.runner, uncertain=key, at=at)
            self.assertEqual(self.runner.approve(approver, waiting["id"], waiting["pending"]["id"], 10)["status"], "completed")
            # Simulate process loss after dispatch and before committing the outcome.
            state.close()
            restarted = BuilderRunner(self.relay)
            state = BuilderState(directory)
            try:
                state.load(restarted)
                run = restarted.start(scope, "demo", "manual", {}, "first", 20)
                self.assertEqual((run["status"], run["error"]), ("unknown", "interrupted_effect"))
                self.assertEqual(len(self.relay.calls), 3)
            finally:
                state.close()

