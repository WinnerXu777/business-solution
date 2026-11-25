import unittest

from workers.bs_worker.chat.gateway import fake_gateway_stdio
from workers.bs_worker.workflows.definition import Definition, StartInput
from workers.bs_worker.workflows.runner import LocalWorkflowRunner, WorkflowConflict, WorkflowQuota
from workers.tests.automation.test_worker import envelope


def order_definition(version=1, order_id="ord-001", event=False):
    trigger = {"id": "trigger", "kind": "trigger", "trigger": "manual", "next": "condition"}
    if event:
        trigger.update(trigger="event", name="orders.updated")
    return Definition.model_validate({
        "id": "order-check", "version": version, "nodes": [
            trigger,
            {"id": "condition", "kind": "condition", "left": {"ref": "enabled"}, "equals": True,
             "next": "map", "otherwise": None},
            {"id": "map", "kind": "mapping", "values": {"target": order_id}, "next": "read"},
            {"id": "read", "kind": "action", "action": {"tool": "order.read", "orderId": {"ref": "target"}},
             "next": "wait"},
            {"id": "wait", "kind": "delay", "milliseconds": 20, "next": "retry"},
            {"id": "retry", "kind": "action", "action": {"tool": "order.read", "orderId": {"ref": "target"}},
             "maxAttempts": 3, "backoffMs": 10},
        ],
    })


scope = envelope("test", source="workflow")
manual = StartInput.model_validate({"trigger": {"kind": "manual"}, "values": {"enabled": True}})
failure = {"state": "failed", "code": "unavailable", "message": "Pre-dispatch failure.", "retryable": True}


class WorkflowTests(unittest.TestCase):
    def test_preview_version_pin_retry_dead_letter_and_safe_replay(self):
        with fake_gateway_stdio() as fixture:
            calls = []
            revived = False

            def gateway(tool, scope, inputs):
                calls.append((scope["idempotencyKey"], inputs["orderId"]))
                if len(calls) > 1 and not revived:
                    return failure
                return fixture(tool, scope, inputs)

            runner = LocalWorkflowRunner(gateway)
            runner.publish(scope, order_definition())
            plan = runner.preview(scope, "order-check", 1, manual)
            self.assertEqual(plan, runner.preview(scope, "order-check", 1, manual))
            self.assertEqual([step["kind"] for step in plan], [
                "trigger", "condition", "mapping", "action", "delay", "action",
            ])
            self.assertEqual(calls, [])
            run = runner.start(scope, "order-check", 1, manual, 100)
            run_id = run["id"]
            self.assertEqual((run["status"], run["dueAt"]), ("delayed", 120))
            runner.publish(scope, order_definition(2, "ord-002"))
            with self.assertRaises(WorkflowConflict):
                runner.publish(scope, order_definition())
            self.assertEqual(runner.tick(scope, run_id, 119)["status"], "delayed")
            self.assertEqual(runner.tick(scope, run_id, 120)["dueAt"], 130)
            self.assertEqual(runner.tick(scope, run_id, 130)["dueAt"], 150)
            dead = runner.tick(scope, run_id, 150)
            self.assertTrue(dead["replayable"])
            self.assertEqual(runner.list_runs(scope, dead_only=True)[0]["id"], run_id)
            revived = True
            replayed = runner.replay(scope, run_id, 200)
            self.assertEqual((replayed["status"], replayed["version"]), ("completed", 1))
            self.assertEqual([order_id for _, order_id in calls], ["ord-001"] * 5)
            self.assertEqual(len({key for key, _ in calls[1:]}), 1)
            self.assertNotEqual(calls[0][0], calls[1][0])
            self.assertEqual(runner.list_runs(scope, dead_only=True), [])
            with self.assertRaises(WorkflowConflict):
                runner.replay(scope, run_id, 210)

    def test_changed_permission_and_suppression_stop_waiting_runs(self):
        with fake_gateway_stdio() as fixture:
            permitted = True
            sent = []

            def gateway(tool, scope, inputs):
                if tool == "workflow.template.run" and inputs["approvalId"]:
                    sent.append(True)
                    return {"state": "denied", "code": "suppressed", "message": "Audience changed."}
                return fixture(tool, scope, inputs)

            runner = LocalWorkflowRunner(gateway, policy=lambda *_: permitted)
            runner.publish(scope, order_definition())
            run = runner.start(scope, "order-check", 1, manual, 100)
            permitted = False
            self.assertEqual(runner.tick(scope, run["id"], 120)["result"]["code"], "forbidden")
            permitted = True
            win_back = StartInput.model_validate({"trigger": {"kind": "manual"}})
            waiting = runner.start(scope, "win-back-v1", 1, win_back, 150)
            self.assertEqual(waiting["status"], "pending_approval")
            self.assertEqual(sent, [])
            approver = envelope("sign", "actor-approver", "workflow")
            settled = runner.approve(approver, waiting["id"], waiting["approval"]["id"], 160)
            self.assertEqual(settled["result"]["code"], "suppressed")
            self.assertFalse(settled["replayable"])

    def test_receipt_deduplication_tenant_quota_and_unknown_hold(self):
        def fixture(*_):
            raise TimeoutError

        runner = LocalWorkflowRunner(fixture, active_limit=1)
        runner.publish(scope, order_definition(event=True))
        skipped = StartInput.model_validate({
            "trigger": {"kind": "event", "name": "orders.updated", "key": "event-1"},
            "values": {"enabled": False},
        })
        first = runner.start(scope, "order-check", 1, skipped, 0)
        self.assertEqual(first, runner.start(envelope("different"), "order-check", 1, skipped, 1))
        enabled = skipped.model_copy(update={"values": {"enabled": True}})
        with self.assertRaises(WorkflowConflict):
            runner.start(scope, "order-check", 1, enabled, 1)
        other = {**scope, "tenantId": "tenant-spoolharbour"}
        self.assertEqual(runner.list_runs(other), [])
        with self.assertRaises(KeyError):
            runner.history(other, first["id"])
        with self.assertRaises(KeyError):
            runner.preview(other, "order-check", 1, skipped)
        runner.publish(scope, Definition.model_validate({
            "id": "timed", "version": 1, "nodes": [
                {"id": "t", "kind": "trigger", "trigger": "schedule", "name": "daily", "next": "d"},
                {"id": "d", "kind": "delay", "milliseconds": 50, "next": "a"},
                {"id": "a", "kind": "action", "action": {"tool": "order.read", "orderId": "ord-001"}},
            ],
        }))
        for index in [1, 2]:
            receipt = StartInput.model_validate({
                "trigger": {"kind": "schedule", "name": "daily", "key": f"day-{index}"},
            })
            if index == 1:
                waiting = runner.start(scope, "timed", 1, receipt, 0)
            else:
                with self.assertRaises(WorkflowQuota):
                    runner.start(scope, "timed", 1, receipt, 0)
        dead = runner.tick(scope, waiting["id"], 50)
        self.assertEqual(dead["status"], "unknown")
        self.assertFalse(dead["replayable"])
        with self.assertRaises(WorkflowConflict):
            runner.replay(scope, waiting["id"], 51)

    def test_rejects_unsupported_tools_cycles_and_approval_bypass(self):
        for nodes in [
            [{"id": "a", "kind": "action", "action": {"tool": "raw.send"}}],
            [{"id": "a", "kind": "delay", "milliseconds": 1, "next": "trigger"}],
            [{"id": "a", "kind": "action", "action": {"tool": "workflow.template.run", "templateId": "win-back-v1"}}],
        ]:
            with self.subTest(nodes=nodes), self.assertRaises(ValueError):
                Definition.model_validate({
                    "id": "invalid", "version": 1, "nodes": [
                        {"id": "trigger", "kind": "trigger", "trigger": "manual", "next": "a"}, *nodes,
                    ],
                })
