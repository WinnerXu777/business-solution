"""Tenant-scoped run journal and LangGraph checkpoint adapter."""

from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass, field
from threading import Lock
from typing import ContextManager, Protocol

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import InMemorySaver


@dataclass
class BotRun:
    id: str
    bot_id: str
    version: int
    envelope: dict
    fingerprint: str
    initial: dict
    status: str = "running"
    remaining_seconds: float = 0
    steps: dict = field(default_factory=dict)
    events: list[dict] = field(default_factory=list)
    pending: dict | None = None
    result: dict | None = None
    resume_value: dict | None = None
    cancelled: bool = False


class BotStore(Protocol):
    """Durable implementations lease a run and use a tenant-bound saver and journal."""

    def saver(self, tenant_id: str) -> BaseCheckpointSaver: ...
    def lease(self, tenant_id: str, run_id: str) -> ContextManager: ...
    def load(self, tenant_id: str, run_id: str) -> BotRun | None: ...
    def save(self, tenant_id: str, run: BotRun) -> None: ...
    def request_cancel(self, tenant_id: str, run_id: str) -> None: ...
    def cancellation_requested(self, tenant_id: str, run_id: str) -> bool: ...


class MemoryBotStore:
    def __init__(self):
        self._savers = {}
        self._runs = {}
        self._leases = {}
        self._cancellations = set()
        self._lock = Lock()

    def saver(self, tenant_id: str) -> BaseCheckpointSaver:
        with self._lock:
            if tenant_id not in self._savers:
                self._savers[tenant_id] = InMemorySaver()
            return self._savers[tenant_id]

    @contextmanager
    def lease(self, tenant_id: str, run_id: str):
        with self._lock:
            lease = self._leases.setdefault((tenant_id, run_id), Lock())
        with lease:
            yield

    def load(self, tenant_id: str, run_id: str) -> BotRun | None:
        # Replace complete snapshots so event readers never see a partial update.
        with self._lock:
            return deepcopy(self._runs.get((tenant_id, run_id)))

    def save(self, tenant_id: str, run: BotRun) -> None:
        if run.envelope["tenantId"] != tenant_id:
            raise ValueError("Tenant mismatch")
        with self._lock:
            self._runs[tenant_id, run.id] = deepcopy(run)

    def request_cancel(self, tenant_id: str, run_id: str) -> None:
        with self._lock:
            self._cancellations.add((tenant_id, run_id))

    def cancellation_requested(self, tenant_id: str, run_id: str) -> bool:
        with self._lock:
            return (tenant_id, run_id) in self._cancellations
