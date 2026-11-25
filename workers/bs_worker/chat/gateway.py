"""Validate line-delimited gateway requests and results."""

import json
import subprocess
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

from pydantic import TypeAdapter

from .. import contracts_v1 as contracts

request_type = TypeAdapter(contracts.ToolCall)
result_types = {
    "llm.complete": TypeAdapter(contracts.CompleteLlmResult),
    "order.read": TypeAdapter(contracts.ReadOrderResult),
    "purchase.order.draft": TypeAdapter(contracts.DraftPurchaseOrderResult),
    "purchase.order.approve": TypeAdapter(contracts.ApprovePurchaseOrderResult),
    "message.preview": TypeAdapter(contracts.PreviewMessageResult),
    "collections.email.send": TypeAdapter(contracts.SendEmailResult),
    "collections.sms.send": TypeAdapter(contracts.SendSmsResult),
    "collections.voice.send": TypeAdapter(contracts.SendVoiceResult),
    "workflow.template.run": TypeAdapter(contracts.RunWorkflowTemplateResult),
}

Gateway = Callable[[str, dict, dict], dict]


def gateway_client(exchange: Callable[[dict], Any]) -> Gateway:
    def call(tool: str, envelope: dict, inputs: dict) -> dict:
        request = request_type.validate_python({"tool": tool, "envelope": envelope, "input": inputs})
        response = exchange(request.model_dump(mode="json"))
        return result_types[tool].validate_python(response).model_dump(mode="json")

    return call


@contextmanager
def fake_gateway_stdio() -> Iterator[Gateway]:
    with subprocess.Popen(
        ["node", "packages/core/src/fake-gateway-stdio.ts"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8",
    ) as process:
        def exchange(request: dict) -> dict:
            process.stdin.write(json.dumps(request) + "\n")
            process.stdin.flush()
            return json.loads(process.stdout.readline())

        try:
            yield gateway_client(exchange)
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
