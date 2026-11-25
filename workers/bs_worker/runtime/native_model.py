"""Transport adapter for the Native LLM API. Resolve credentials from the run scope."""

from collections.abc import Callable
from dataclasses import dataclass


@dataclass(frozen=True)
class ModelBinding:
    service_key: str
    model_alias: str


class NativeModel:
    def __init__(self, resolve: Callable[[str], ModelBinding | None], post: Callable):
        self.resolve = resolve
        self.post = post

    def __call__(self, tenant_id: str, inputs: dict, timeout_ms: int) -> dict:
        binding = self.resolve(tenant_id)
        if not binding or not binding.service_key or not binding.model_alias:
            return {"state": "denied", "code": "forbidden", "message": "Model binding unavailable."}
        result = self.post(
            "/llm/v1/chat/completions",
            {"authorization": f"Bearer {binding.service_key}", "content-type": "application/json"},
            {
                "model": binding.model_alias,
                "messages": inputs["turns"],
                "max_completion_tokens": inputs["maxOutputTokens"],
                "stream": False,
                "tool_choice": "none",
            },
            timeout_ms,
        )
        choice = result["choices"][0]
        message = choice["message"]
        text = message["content"]
        if (
            message["role"] != "assistant" or message.get("tool_calls")
            or choice["finish_reason"] not in {"stop", "length"}
            or not isinstance(text, str) or not text.strip()
        ):
            raise ValueError("Invalid model reply")
        usage = result["usage"]
        return {
            "state": "ok",
            "output": {
                "text": text, "model": binding.model_alias, "route": inputs["route"],
                "inputTokens": usage["prompt_tokens"], "outputTokens": usage["completion_tokens"],
            },
        }
