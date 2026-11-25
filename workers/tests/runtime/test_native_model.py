import unittest

from workers.bs_worker.chat.gateway import fake_gateway_stdio
from workers.bs_worker.chat.graph import NATIVE_CHAT
from workers.bs_worker.runtime.bots import BotRegistry, BotRuntime
from workers.bs_worker.runtime.native_model import ModelBinding, NativeModel
from workers.bs_worker.runtime.store import MemoryBotStore
from workers.tests.automation.test_worker import chat


class NativeModelTests(unittest.TestCase):
    def test_native_inference_and_governed_proposals_are_separate(self):
        request = chat("native", "Draft fictional pr-001", {
            "tool": "purchase.order.draft", "input": {"requestId": "pr-001"},
        })
        model_requests = []
        gateway_tools = []

        def post(path, headers, payload, timeout_ms):
            model_requests.append((path, headers, payload, timeout_ms))
            return {
                "choices": [{
                    "message": {"role": "assistant", "content": "Fictional completion."},
                    "finish_reason": "stop",
                }],
                "usage": {"prompt_tokens": 4, "completion_tokens": 2},
            }

        def resolve(tenant):
            if tenant == "tenant-rivetquay":
                return ModelBinding("fictional-worker-key", "fictional-bot-chat")
            return None

        with fake_gateway_stdio() as fake:
            def gateway(tool, scope, inputs):
                gateway_tools.append(tool)
                return fake(tool, scope, inputs)

            registry = BotRegistry(NATIVE_CHAT)
            runtime = BotRuntime(registry, MemoryBotStore(), gateway, model=NativeModel(resolve, post))
            run = runtime.start("native", NATIVE_CHAT.id, 1, request["envelope"], request)
            self.assertEqual(run.status, "pending_approval")
            self.assertEqual(gateway_tools, ["purchase.order.draft"])
            self.assertEqual(len(model_requests), 1)
            path, headers, payload, timeout = model_requests[0]
            self.assertEqual(path, "/llm/v1/chat/completions")
            self.assertEqual(headers["authorization"], "Bearer fictional-worker-key")
            self.assertEqual(payload["model"], "fictional-bot-chat")
            self.assertEqual(payload["tool_choice"], "none")
            self.assertTrue(0 < timeout <= 10_000)
            plain = chat("plain-native", "Synthetic general question", None)
            reply = runtime.start("plain-native", NATIVE_CHAT.id, 1, plain["envelope"], plain)
            self.assertEqual(reply.result["output"]["reply"], "Fictional completion.")
            self.assertEqual(gateway_tools, ["purchase.order.draft"])

            foreign = {
                **plain, "envelope": {**plain["envelope"], "tenantId": "tenant-spoolharbour"},
            }
            denied = runtime.start("foreign-native", NATIVE_CHAT.id, 1, foreign["envelope"], foreign)
            self.assertEqual(denied.result["code"], "forbidden")
            self.assertEqual(len(model_requests), 2)
