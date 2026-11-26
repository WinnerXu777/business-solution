"""Tenant-local, idempotent run observations for the bot dashboard."""

from dataclasses import dataclass
from datetime import datetime
from statistics import mean

from .models import BOT_IDS


@dataclass
class Observation:
    bot: str
    started: datetime
    settled: datetime | None = None
    escalated: bool = False
    approval_id: str | None = None
    approved: bool = False
    handled: bool = False


class BotMetrics:
    def __init__(self):
        self.runs: dict[str, Observation] = {}
        self.approvals: dict[str, Observation] = {}

    def observe(self, view, now, *, started=None):
        row = self.runs.setdefault(view["id"], Observation(view["botId"], started or now))
        result = view["result"] or {}
        output = result.get("output", {})
        state = output.get("state")
        if view["pending"]:
            row.approval_id = view["pending"]["approval"]["id"]
        elif state == "pending_approval":
            row.approval_id = output.get("approvalId", output.get("id"))
        if row.approval_id:
            self.approvals[row.approval_id] = row
        if view["status"] not in {"running", "pending_approval"} and state != "pending_approval":
            row.settled = row.settled or now
            row.handled = state != "duplicate"
            row.escalated = state in {"exception", "staff_review"} or view["status"] == "unknown" or (
                state == "held" and output.get("reason") in {"dispute", "reconcile_promise_balance", "reconcile_delivery"}
            )
            row.approved = row.approval_id is not None and view["status"] == "completed"

    def local_approved(self, approval_id, now):
        if row := self.approvals.get(approval_id):
            row.approved = row.handled = True
            row.settled = row.settled or now

    def report(self):
        metrics = []
        for bot in BOT_IDS:
            rows = [row for row in self.runs.values() if row.bot == bot]
            requested = sum(row.approval_id is not None for row in rows)
            approved = sum(row.approved for row in rows)
            times = [max(0, (row.settled - row.started).total_seconds() * 1000)
                     for row in rows if row.settled is not None and row.handled]
            metrics.append({
                "botId": bot, "handled": sum(row.handled for row in rows),
                "escalated": sum(row.escalated for row in rows),
                "approvalRequested": requested, "approved": approved,
                "approvalRate": approved / requested if requested else None,
                "averageCycleTimeMs": round(mean(times)) if times else None,
            })
        return metrics
