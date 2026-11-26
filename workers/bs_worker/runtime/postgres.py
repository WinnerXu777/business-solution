"""Postgres-backed LangGraph checkpoints and bot journals."""

import json
from collections.abc import Sequence
from contextlib import contextmanager
from dataclasses import asdict
from typing import ContextManager, Protocol

from langgraph.checkpoint.base import (
    WRITES_IDX_MAP,
    BaseCheckpointSaver,
    CheckpointTuple,
    get_checkpoint_id,
    get_checkpoint_metadata,
)

from .store import BotRun


class Query(Protocol):
    def __call__(self, sql: str, params: tuple) -> Sequence[dict]: ...


class RuntimeExecutor(Protocol):
    """Transactions set app.tenant_id locally and return dict rows with decoded JSONB.

    Leases are held on a separate session across committed transactions. Queries may
    originate on LangGraph worker threads.
    """

    def transaction(self, tenant_id: str) -> ContextManager[Query]: ...
    def lease(self, tenant_id: str, run_id: str) -> ContextManager: ...


def _config(thread, namespace, checkpoint_id):
    return {"configurable": {
        "thread_id": thread, "checkpoint_ns": namespace, "checkpoint_id": checkpoint_id,
    }}


class PostgresCheckpointSaver(BaseCheckpointSaver[int]):
    def __init__(self, executor: RuntimeExecutor, tenant_id: str):
        super().__init__()
        self.executor = executor
        self.tenant_id = tenant_id

    @staticmethod
    def _coordinates(config):
        values = config["configurable"] if config else {}
        return values.get("thread_id"), values.get("checkpoint_ns"), get_checkpoint_id(config) if config else None

    def get_tuple(self, config):
        thread, namespace, checkpoint_id = self._coordinates(config)
        scoped = _config(thread, namespace or "", checkpoint_id)
        return next(self.list(scoped, limit=1), None)

    def list(self, config, *, filter=None, before=None, limit=None):
        thread, namespace, checkpoint_id = self._coordinates(config)
        before_id = get_checkpoint_id(before) if before else None
        clauses = ["tenant_id = %s"]
        params = [self.tenant_id]
        for value, predicate in (
            (thread, "thread_id = %s"), (namespace, "namespace = %s"),
            (checkpoint_id, "id = %s"), (before_id, "id < %s"),
        ):
            if value is not None:
                clauses.append(predicate)
                params.append(value)
        count = 0
        with self.executor.transaction(self.tenant_id) as query:
            rows = query(
                "SELECT * FROM runtime.checkpoints WHERE " + " AND ".join(clauses) + " ORDER BY id DESC",
                tuple(params),
            )
            results = []
            for row in rows:
                if limit is not None and count >= limit:
                    break
                metadata = self.serde.loads_typed((row["metadata_type"], bytes(row["metadata"])))
                if filter and any(metadata.get(key) != value for key, value in filter.items()):
                    continue
                thread, namespace, checkpoint_id = row["thread_id"], row["namespace"], row["id"]
                writes = query(
                    """SELECT task_id, channel, value_type, value FROM runtime.checkpoint_writes
                       WHERE tenant_id = %s AND thread_id = %s AND namespace = %s AND checkpoint_id = %s
                       ORDER BY task_path, task_id, idx""",
                    (self.tenant_id, thread, namespace, checkpoint_id),
                )
                checkpoint = self.serde.loads_typed((row["checkpoint_type"], bytes(row["checkpoint"])))
                results.append(CheckpointTuple(
                    _config(thread, namespace, checkpoint_id), checkpoint, metadata,
                    _config(thread, namespace, row["parent_id"]) if row["parent_id"] else None,
                    [(item["task_id"], item["channel"], self.serde.loads_typed(
                        (item["value_type"], bytes(item["value"])),
                    )) for item in writes],
                ))
                count += 1
        yield from results

    def put(self, config, checkpoint, metadata, new_versions):
        thread, namespace, parent_id = self._coordinates(config)
        namespace = namespace or ""
        checkpoint_id = checkpoint["id"]
        with self.executor.transaction(self.tenant_id) as query:
            query(
                """INSERT INTO runtime.checkpoints
                   (tenant_id, thread_id, namespace, id, parent_id, checkpoint_type, checkpoint, metadata_type, metadata)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (tenant_id, thread_id, namespace, id) DO NOTHING""",
                (self.tenant_id, thread, namespace, checkpoint_id, parent_id,
                 *self.serde.dumps_typed(checkpoint),
                 *self.serde.dumps_typed(get_checkpoint_metadata(config, metadata))),
            )
        return _config(thread, namespace, checkpoint_id)

    def put_writes(self, config, writes, task_id, task_path=""):
        thread, namespace, checkpoint_id = self._coordinates(config)
        with self.executor.transaction(self.tenant_id) as query:
            for index, (channel, value) in enumerate(writes):
                index = WRITES_IDX_MAP.get(channel, index)
                conflict = "DO NOTHING" if index >= 0 else (
                    "DO UPDATE SET value_type = EXCLUDED.value_type, value = EXCLUDED.value"
                )
                query(
                    """INSERT INTO runtime.checkpoint_writes
                       (tenant_id, thread_id, namespace, checkpoint_id, task_id, idx, task_path, channel, value_type, value)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                       ON CONFLICT (tenant_id, thread_id, namespace, checkpoint_id, task_id, idx) """ + conflict,
                    (self.tenant_id, thread, namespace or "", checkpoint_id, task_id, index, task_path, channel,
                     *self.serde.dumps_typed(value)),
                )

    def delete_thread(self, thread_id: str):
        with self.executor.transaction(self.tenant_id) as query:
            query("DELETE FROM runtime.checkpoint_writes WHERE tenant_id = %s AND thread_id = %s",
                  (self.tenant_id, thread_id))
            query("DELETE FROM runtime.checkpoints WHERE tenant_id = %s AND thread_id = %s",
                  (self.tenant_id, thread_id))


class PostgresBotStore:
    def __init__(self, executor: RuntimeExecutor):
        self.executor = executor

    def saver(self, tenant_id):
        return PostgresCheckpointSaver(self.executor, tenant_id)

    @contextmanager
    def lease(self, tenant_id, run_id):
        with self.executor.lease(tenant_id, run_id):
            yield

    def load(self, tenant_id, run_id):
        with self.executor.transaction(tenant_id) as query:
            params = (tenant_id, run_id)
            rows = query("SELECT body FROM runtime.bot_runs WHERE tenant_id = %s AND run_id = %s FOR SHARE", params)
            if not rows:
                return None
            steps = query("SELECT step_id, body FROM runtime.bot_steps WHERE tenant_id = %s AND run_id = %s", params)
            events = query(
                "SELECT body FROM runtime.bot_events WHERE tenant_id = %s AND run_id = %s ORDER BY cursor",
                params,
            )
            return BotRun(**rows[0]["body"], steps={row["step_id"]: row["body"] for row in steps},
                          events=[row["body"] for row in events])

    def save(self, tenant_id, run):
        if run.envelope["tenantId"] != tenant_id:
            raise ValueError("Tenant mismatch")
        body = asdict(run)
        steps = body.pop("steps")
        events = body.pop("events")
        encode = lambda value: json.dumps(value, allow_nan=False)
        with self.executor.transaction(tenant_id) as query:
            query(
                """INSERT INTO runtime.bot_runs (tenant_id, run_id, session_id, actor_kind, actor_id, body)
                   VALUES (%s, %s, %s, %s, %s, %s::jsonb)
                   ON CONFLICT (tenant_id, run_id) DO UPDATE SET body = EXCLUDED.body""",
                (tenant_id, run.id, run.session_id, run.envelope["actor"]["kind"],
                 run.envelope["actor"]["id"], encode(body)),
            )
            for step_id, step in steps.items():
                query(
                    """INSERT INTO runtime.bot_steps (tenant_id, run_id, step_id, body)
                       VALUES (%s, %s, %s, %s::jsonb)
                       ON CONFLICT (tenant_id, run_id, step_id) DO UPDATE SET body = EXCLUDED.body""",
                    (tenant_id, run.id, step_id, encode(step)),
                )
            for event in events:
                query(
                    """INSERT INTO runtime.bot_events (tenant_id, run_id, cursor, body)
                       VALUES (%s, %s, %s, %s::jsonb)
                       ON CONFLICT (tenant_id, run_id, cursor) DO NOTHING""",
                    (tenant_id, run.id, event["id"], encode(event)),
                )

    def session(self, tenant_id, actor, session_id):
        with self.executor.transaction(tenant_id) as query:
            rows = query(
                """SELECT body FROM runtime.bot_runs
                   WHERE tenant_id = %s AND actor_kind = %s AND actor_id = %s AND session_id = %s
                   ORDER BY ordinal""",
                (tenant_id, actor["kind"], actor["id"], session_id),
            )
            return [BotRun(**row["body"]) for row in rows]

    def request_cancel(self, tenant_id, run_id):
        with self.executor.transaction(tenant_id) as query:
            query("UPDATE runtime.bot_runs SET cancel_requested = true WHERE tenant_id = %s AND run_id = %s",
                  (tenant_id, run_id))

    def cancellation_requested(self, tenant_id, run_id):
        with self.executor.transaction(tenant_id) as query:
            rows = query("SELECT cancel_requested FROM runtime.bot_runs WHERE tenant_id = %s AND run_id = %s",
                         (tenant_id, run_id))
            return bool(rows and rows[0]["cancel_requested"])
