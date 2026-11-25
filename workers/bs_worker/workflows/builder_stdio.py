"""Private line protocol for the workflow builder API host."""

import json
import sys

from .builder_definition import validate_definition
from .builder_runner import BuilderRunner, preview
from .builder_state import BuilderState
from .errors import WorkflowConflict, WorkflowQuota


def send(message):
    print(json.dumps(message, ensure_ascii=True, allow_nan=False), flush=True)


def relay(request):
    send({"effect": request})
    return json.loads(sys.stdin.readline())


def main():
    options = json.loads(sys.argv[1])
    directory = options.pop("state_directory", None)
    state = BuilderState(directory) if directory is not None else None
    runner = BuilderRunner(relay, **options)
    if state:
        state.load(runner)
        runner.before_effect = lambda key, at: state.save(runner, uncertain=key, at=at)

    def simulate(scope, definition, values):
        validate_definition(definition, runner.connectors)
        return preview(definition, values, scope["tenantId"])

    def definition(scope, definitionId, version):
        return runner.versions[scope["tenantId"], definitionId, version]

    commands = {
        "preview": simulate, "definition": definition, "publish": runner.publish,
        "release": runner.release, "start": runner.start, "read": runner.read, "tick": runner.tick,
        "event": runner.event, "task": runner.task, "approve": runner.approve, "migrate": runner.migrate,
        "inbox": runner.inbox, "recover": runner.recover,
    }
    read_only = {"preview", "definition", "read", "inbox", "recover"}
    try:
        for line in sys.stdin:
            data = json.loads(line)
            kind = data.pop("kind")
            try:
                result = {"reply": commands[kind](**data)}
            except WorkflowQuota:
                result = {"code": "quota_exceeded"}
            except WorkflowConflict:
                result = {"code": "conflict"}
            except KeyError:
                result = {"code": "not_found"}
            except (TypeError, ValueError):
                result = {"code": "invalid_input"}
            if state and kind not in read_only:
                state.save(runner)
            send(result)
    finally:
        if state:
            state.close()


if __name__ == "__main__":
    main()

