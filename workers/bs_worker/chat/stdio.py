"""Keep chat checkpoints in one worker and relay tools to its owning gateway."""

import json
import sys

from langgraph.types import Command

from ..workflows.runner import run_win_back
from .gateway import gateway_client
from .graph import build_graph


def _write(value: dict) -> None:
    print(json.dumps(value), flush=True)


def _tool_call(request: dict) -> dict:
    _write({"toolCall": request})
    return json.loads(sys.stdin.readline())


def main() -> None:
    gateway = gateway_client(_tool_call)
    graph = build_graph(gateway)
    for line in sys.stdin:
        try:
            command = json.loads(line)
            if command["kind"] == "workflow":
                result = run_win_back(gateway, command["envelope"], command["mode"], command["approvalId"])
                _write({"result": result})
                continue
            config = {"configurable": {"thread_id": command["threadId"]}}
            if command["kind"] == "chat":
                state = graph.invoke({
                    "envelope": command["envelope"],
                    "chat": command["chat"],
                    "proposal": command["proposal"],
                    "pending": None,
                    "result": None,
                }, config=config)
            elif command["kind"] == "resume":
                state = graph.invoke(Command(resume=command["envelope"]), config=config)
            else:
                raise ValueError("Unknown command")
            if state.get("__interrupt__"):
                pending = state["__interrupt__"][0].value
                _write({"result": {"state": "pending_approval", "approval": pending["approval"]}, "pending": pending})
            else:
                _write({"result": state["result"]})
        except Exception:
            # Protocol errors contain no prompts, message bodies or identities.
            _write({"error": "Fixture worker could not complete the request."})


if __name__ == "__main__":
    main()
