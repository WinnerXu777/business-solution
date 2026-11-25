"""Keep fixture runtime state and relay typed calls to its owning gateway."""

import json
import sys

from ..runtime.bots import BotRegistry, BotRuntime, RunConflict, RunStopped, dispatch_timeout_ms
from ..runtime.store import MemoryBotStore
from ..workflows.definition import Definition, StartInput
from ..workflows.runner import LocalWorkflowRunner, WorkflowConflict, WorkflowQuota, run_win_back
from .gateway import gateway_client
from .graph import CHAT


def _write(value: dict) -> None:
    print(json.dumps(value, allow_nan=False), flush=True)


def _tool_call(request: dict) -> dict:
    message = {"toolCall": request}
    if (timeout := dispatch_timeout_ms.get()) is not None:
        message["timeoutMs"] = timeout
    _write(message)
    response = json.loads(sys.stdin.readline())
    if response.get("control") == "cancel":
        raise RunStopped
    return response


def _emit(event: dict) -> None:
    _write({"event": event})


def _bot_view(run) -> dict:
    return {
        "id": run.id, "botId": run.bot_id, "version": run.version,
        "status": run.status, "result": run.result, "pending": run.pending,
    }


def _legacy_view(run) -> dict:
    if run.pending:
        return {"result": {"state": "pending_approval", "approval": run.pending["approval"]}, "pending": run.pending}
    return {"result": run.result}


def dispatch(command, gateway, bots, workflows):
    kind = command["kind"]
    scope = command.get("envelope")
    run_id = command.get("runId")
    if kind in {"chat", "bot-start"}:
        run = bots.start(
            command.get("threadId", run_id), command.get("botId", CHAT.id),
            command.get("version", CHAT.version), scope,
            {"chat": command["chat"], "proposal": command["proposal"]},
            _emit if kind == "bot-start" else None,
        )
        return _bot_view(run) if kind == "bot-start" else _legacy_view(run)
    if kind in {"resume", "bot-resume"}:
        run = bots.resume(
            command.get("threadId", run_id), scope, command["approvalId"],
            _emit if kind == "bot-resume" else None,
        )
        return _bot_view(run) if kind == "bot-resume" else _legacy_view(run)
    if kind == "bot-cancel":
        return _bot_view(bots.cancel(run_id, scope, _emit))
    if kind == "bot-list":
        return bots.registry.list()
    if kind == "workflow":
        return {"result": run_win_back(gateway, scope, command["mode"], command["approvalId"])}
    if kind == "workflow-definitions":
        return workflows.definitions(scope)
    if kind == "workflow-publish":
        return workflows.publish(scope, Definition.model_validate(command["definition"]))
    if kind in {"workflow-preview", "workflow-start"}:
        start = StartInput.model_validate(command["input"])
        args = scope, command["definitionId"], command["version"], start
        return workflows.preview(*args) if kind == "workflow-preview" else workflows.start(*args, command["now"])
    if kind == "workflow-runs":
        return workflows.list_runs(scope, command["deadOnly"])
    if kind == "workflow-history":
        return workflows.history(scope, run_id)
    if kind == "workflow-tick":
        return workflows.tick(scope, run_id, command["now"])
    if kind == "workflow-approve":
        return workflows.approve(scope, run_id, command["approvalId"], command["now"])
    if kind == "workflow-replay":
        return workflows.replay(scope, run_id, command["now"])
    raise ValueError("Unknown command")


def main() -> None:
    gateway = gateway_client(_tool_call)
    bots = BotRuntime(BotRegistry(CHAT), MemoryBotStore(), gateway)
    workflows = LocalWorkflowRunner(gateway)
    for line in sys.stdin:
        try:
            value = dispatch(json.loads(line), gateway, bots, workflows)
            _write({"reply": value})
        except KeyError:
            _write({"rejected": "not_found"})
        except WorkflowQuota:
            _write({"rejected": "quota_exceeded"})
        except (RunConflict, WorkflowConflict):
            _write({"rejected": "conflict"})
        except ValueError:
            _write({"rejected": "invalid_input"})
        except Exception:
            _write({"error": "Fixture worker could not complete the request."})


if __name__ == "__main__":
    main()
