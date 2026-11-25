"""Offline checks for the generated bindings."""

import json
import subprocess
import unittest
from pathlib import Path

from pydantic import TypeAdapter, ValidationError

from workers.bs_worker.contracts_v1 import DemoFixtures, ToolCall, ToolResult


class ContractTests(unittest.TestCase):
    def test_shared_fixtures_validate_with_pydantic(self):
        fixture = Path("packages/contracts/fixtures/demo.json")
        demo = DemoFixtures.model_validate_json(fixture.read_text(encoding="utf-8"))
        self.assertEqual(len(demo.workspaces), 2)
        self.assertEqual(len(demo.customers), 11)
        self.assertEqual(len(demo.skus), 26)

    def test_tool_correlation_accepts_only_the_declared_input(self):
        request = {
            "envelope": {
                "version": "v1",
                "tenantId": "tenant-rivetquay",
                "actor": {"id": "actor-reader", "kind": "person"},
                "source": "rest",
                "traceId": "trace-1",
                "correlationId": "correlation-1",
                "idempotencyKey": "key-1",
            },
            "tool": "order.read",
            "input": {"orderId": "ord-001"},
        }
        adapter = TypeAdapter(ToolCall)
        self.assertEqual(adapter.validate_json(json.dumps(request)).input.orderId, "ord-001")
        request["input"] = {"customerId": "cust-001"}
        with self.assertRaises(ValidationError):
            adapter.validate_python(request)

    def test_unknown_result_requires_a_reconciliation_id(self):
        adapter = TypeAdapter(ToolResult)
        value = {"state": "unknown", "message": "Delivery needs reconciliation."}
        with self.assertRaises(ValidationError):
            adapter.validate_python(value)
        self.assertEqual(adapter.validate_python({**value, "actionId": "action-1"}).state, "unknown")

    def test_worker_can_use_the_fake_gateway_over_stdio(self):
        from workers.bs_worker.contracts_v1 import ReadOrderRequest, ReadOrderResult

        request = ReadOrderRequest.model_validate({
            "envelope": {
                "version": "v1",
                "tenantId": "tenant-rivetquay",
                "actor": {"id": "actor-worker", "kind": "service"},
                "source": "worker",
                "traceId": "trace-worker",
                "correlationId": "correlation-worker",
                "idempotencyKey": "read-worker",
            },
            "tool": "order.read",
            "input": {"orderId": "ord-001"},
        })
        completed = subprocess.run(
            ["node", "packages/core/src/fake-gateway-stdio.ts"],
            input=request.model_dump_json() + "\n",
            text=True,
            capture_output=True,
            check=True,
            timeout=10,
        )
        result = TypeAdapter(ReadOrderResult).validate_json(completed.stdout)
        self.assertEqual(result.state, "ok")
        self.assertEqual(result.output.id, "ord-001")


if __name__ == "__main__":
    unittest.main()
