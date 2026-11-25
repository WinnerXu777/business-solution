import unittest

from langgraph.types import Command

from workers.bs_worker.chat.gateway import fake_gateway_stdio
from workers.bs_worker.chat.graph import build_graph
from workers.bs_worker.workflows.runner import run_win_back


def envelope(key, actor="actor-operator", source="chat"):
    return {
        "version": "v1", "tenantId": "tenant-rivetquay",
        "actor": {"id": actor, "kind": "person"}, "source": source,
        "traceId": "trace-1", "correlationId": "correlation-1", "idempotencyKey": key,
    }


def chat(session_id, content, proposal):
    return {
        "envelope": envelope(session_id),
        "chat": {
            "sessionId": session_id, "turns": [{"role": "user", "content": content}],
            "orderId": None, "audioFixtureId": None,
            "route": {"kind": "native", "providerId": "fixture-native", "fixtureMode": True},
        },
        "proposal": proposal,
    }


class WorkerTests(unittest.TestCase):
    def test_order_read_goes_through_stdio_gateway(self):
        with fake_gateway_stdio() as gateway:
            graph = build_graph(gateway)
            config = {"configurable": {"thread_id": "order-1"}}
            result = graph.invoke(chat("order-1", "Check ord-001", {
                "tool": "order.read", "input": {"orderId": "ord-001"},
            }), config=config)["result"]["output"]
            self.assertEqual(result["order"]["id"], "ord-001")
            self.assertEqual(result["reply"], "Order ord-001 is fulfilled.")

    def test_purchase_order_interrupt_requires_a_separate_designated_approver(self):
        with fake_gateway_stdio() as gateway:
            graph = build_graph(gateway)
            proposal = {"tool": "purchase.order.draft", "input": {"requestId": "pr-001"}}
            for session_id, approver in [("wrong", "actor-operator"), ("right", "actor-approver")]:
                config = {"configurable": {"thread_id": session_id}}
                state = graph.invoke(chat(session_id, "Draft pr-001", proposal), config=config)
                self.assertEqual(state["__interrupt__"][0].value["approval"]["state"], "pending")
                result = graph.invoke(
                    Command(resume=envelope("approve-" + session_id, actor=approver)), config=config,
                )["result"]
                self.assertEqual(result["state"], "ok" if session_id == "right" else "denied")

    def test_runner_preview_is_read_only_and_requires_approval_for_run(self):
        with fake_gateway_stdio() as gateway:
            scope = envelope("preview-1", source="workflow")
            preview = run_win_back(gateway, scope, "preview")
            self.assertEqual(preview, run_win_back(gateway, scope, "preview"))
            self.assertEqual(preview["output"]["receipts"], [])
            self.assertEqual(
                [target["customerId"] for target in preview["output"]["previews"]],
                ["cust-008", "cust-009"],
            )
            run = run_win_back(gateway, envelope("run-1", source="workflow"), "run")
            self.assertEqual(run["state"], "pending_approval")
