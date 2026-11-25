"""Line-based fixture service. The Node host supplies verified scope and simulated tools."""

import json
import sys

from pydantic import ValidationError

from ..chat.gateway import gateway_client
from ..runtime.bots import RunConflict
from .agents import preview_template
from .service import Conflict, FixtureBots


def send(value):
    print(json.dumps(value, allow_nan=False), flush=True)


def exchange(message):
    send(message)
    return json.loads(sys.stdin.readline())


def main():
    gateway = gateway_client(lambda call: exchange({"toolCall": call, "template": preview_template.get()}))
    host = FixtureBots(gateway, lambda scope, key: exchange({"sign": {"scope": scope, "id": key}})["signed"])
    for line in sys.stdin:
        try:
            send({"reply": host.dispatch(**json.loads(line))})
        except PermissionError:
            send({"error": "forbidden"})
        except KeyError:
            send({"error": "not_found"})
        except (Conflict, RunConflict):
            send({"error": "conflict"})
        except (ValidationError, ValueError, TypeError):
            send({"error": "invalid_input"})
        except Exception:
            send({"error": "unavailable"})


if __name__ == "__main__":
    main()
