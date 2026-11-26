"""A SQL-boundary fake shared by repository and worker restart tests."""

import json
import re
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path
from pickle import dumps, loads
from threading import RLock


class FakeRuntimeExecutor:
    def __init__(self, path=None):
        self.path = Path(path) if path else None
        self.tables = loads(self.path.read_bytes()) if self.path and self.path.exists() else {}
        self.lock = RLock()
        self.leases = {}

    @contextmanager
    def transaction(self, tenant_id):
        with self.lock:
            before = deepcopy(self.tables)
            try:
                yield lambda sql, params: self.query(tenant_id, " ".join(sql.split()), params)
                if self.path and before != self.tables:
                    temporary = self.path.with_suffix(".tmp")
                    temporary.write_bytes(dumps(self.tables))
                    temporary.replace(self.path)
            except BaseException:
                self.tables = before
                raise

    @contextmanager
    def lease(self, tenant_id, run_id):
        with self.lock:
            lease = self.leases.setdefault((tenant_id, run_id), RLock())
        with lease:
            yield

    def query(self, tenant_id, sql, params):
        assert params[0] == tenant_id
        table = re.search(r"runtime\.([a-z_]+)", sql)[1]
        rows = self.tables.setdefault(table, {})
        if sql.startswith("INSERT"):
            columns = sql.split("(", 1)[1].split(")", 1)[0].split(", ")
            row = dict(zip(columns, params, strict=True))
            if "body" in row:
                row["body"] = json.loads(row["body"])
            primary = sql.split("ON CONFLICT (", 1)[1].split(")", 1)[0].split(", ")
            key = tuple(row[column] for column in primary)
            if key not in rows:
                if table == "bot_runs":
                    row["cancel_requested"] = False
                rows[key] = row
            elif "DO UPDATE" in sql:
                rows[key].update(row)
            return []
        if sql.startswith("UPDATE"):
            assert table == "bot_runs" and "cancel_requested = true" in sql
            if params in rows:
                rows[params]["cancel_requested"] = True
            return []
        predicates = re.findall(r"([a-z_]+) (=|<) %s", sql)
        filters = list(zip(predicates, params, strict=True))
        selected = [
            key for key, row in rows.items()
            if all(row[column] == value if op == "=" else row[column] < value
                   for (column, op), value in filters)
        ]
        if sql.startswith("DELETE"):
            for key in selected:
                del rows[key]
            return []
        assert sql.startswith("SELECT")
        result = [rows[key] for key in selected]
        if "ORDER BY id DESC" in sql:
            result.sort(key=lambda row: row["id"], reverse=True)
        if "ORDER BY cursor" in sql:
            result.sort(key=lambda row: row["cursor"])
        if "ORDER BY task_path" in sql:
            result.sort(key=lambda row: (row["task_path"], row["task_id"], row["idx"]))
        return deepcopy(result)
