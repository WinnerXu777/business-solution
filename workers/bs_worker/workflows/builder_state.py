"""Optional single-host checkpoint journal for synthetic workflow runs."""

import json
import sqlite3
from collections import deque
from dataclasses import asdict
from pathlib import Path

from .builder_runner import MAX_THROTTLE_LIMIT, Draft, Loop, Run


def decode_values(values):
    return {key: Draft(value["text"]) if isinstance(value, dict) else value for key, value in values.items()}


class BuilderState:
    def __init__(self, directory):
        self.db = sqlite3.connect(Path(directory) / "workflow-runs.sqlite3", timeout=0)
        self.db.execute("PRAGMA locking_mode = EXCLUSIVE")
        with self.db:
            self.db.execute("CREATE TABLE IF NOT EXISTS builder_state (id INTEGER PRIMARY KEY, payload TEXT)")
            # Take the exclusive lock before allowing a second host to use the trigger store.
            self.db.execute("UPDATE builder_state SET payload = payload WHERE id = 1")

    def load(self, runner):
        row = self.db.execute("SELECT payload FROM builder_state WHERE id = 1").fetchone()
        if row is None:
            return
        data = json.loads(row[0])
        runner.versions = {tuple(key): definition for key, definition in data["versions"]}
        runner.releases = {tuple(key): version for key, version in data["releases"]}
        runner.quotas = data["quotas"]
        runner.throttles = {tuple(key): deque(times, maxlen=MAX_THROTTLE_LIMIT) for key, times in data["throttles"]}
        runner.tickets = {tuple(key) for key in data["tickets"]}
        for payload in data["runs"]:
            key = payload["scope"]["tenantId"], payload["id"]
            payload["values"] = decode_values(payload["values"])
            if payload["loop"]:
                payload["loop"]["initial"] = decode_values(payload["loop"]["initial"])
                payload["loop"] = Loop(**payload["loop"])
            run = Run(**payload)
            if data["uncertain"] == list(key):
                runner.fail(run, "interrupted_effect", data["effectAt"], "unknown")
            runner.runs[key] = run
        if data["uncertain"] is not None:
            self.save(runner)

    def save(self, runner, uncertain=None, at=None):
        data = {
            "versions": list(runner.versions.items()), "releases": list(runner.releases.items()),
            "runs": [asdict(run) for run in runner.runs.values()],
            "quotas": runner.quotas, "throttles": [(key, list(times)) for key, times in runner.throttles.items()],
            "tickets": list(runner.tickets), "uncertain": uncertain, "effectAt": at,
        }
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO builder_state VALUES (1, ?)",
                            (json.dumps(data, allow_nan=False),))

    def close(self):
        self.db.close()

