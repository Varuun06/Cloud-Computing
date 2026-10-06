"""Minimal thread-safe JSON-file repository.

Each microservice owns its own data file (database-per-service pattern), so no
service can read another service's data directly - it must go through its API.
Pass file=None for a purely in-memory store (used by the tests).
"""
import copy
import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class JsonStore:
    def __init__(self, file: Optional[Path], prefix: str, seed: list, start_at: int = 1):
        self.file = Path(file) if file else None
        self.prefix = prefix
        self._lock = threading.Lock()

        if self.file and self.file.exists():
            self._items = json.loads(self.file.read_text(encoding="utf-8"))
        else:
            self._items = copy.deepcopy(seed)
            self._persist()

        numbers = [int(i["id"][len(prefix):]) for i in self._items if i["id"][len(prefix):].isdigit()]
        self._next = max(numbers, default=start_at - 1) + 1

    def all(self) -> list:
        with self._lock:
            return copy.deepcopy(self._items)

    def get(self, item_id: str) -> Optional[dict]:
        with self._lock:
            item = self._find(item_id)
            return copy.deepcopy(item) if item else None

    def insert(self, data: dict) -> dict:
        with self._lock:
            now = _now()
            item = {"id": f"{self.prefix}{self._next}", **data, "created_at": now, "updated_at": now}
            self._next += 1
            self._items.append(item)
            self._persist()
            return copy.deepcopy(item)

    def update(self, item_id: str, changes: dict) -> Optional[dict]:
        with self._lock:
            item = self._find(item_id)
            if item is None:
                return None
            item.update(changes)
            item["updated_at"] = _now()
            self._persist()
            return copy.deepcopy(item)

    def delete(self, item_id: str) -> Optional[dict]:
        with self._lock:
            item = self._find(item_id)
            if item is None:
                return None
            self._items.remove(item)
            self._persist()
            return item

    def _find(self, item_id: str) -> Optional[dict]:
        return next((i for i in self._items if i["id"] == item_id), None)

    def _persist(self) -> None:
        if self.file is None:
            return
        self.file.parent.mkdir(parents=True, exist_ok=True)
        self.file.write_text(json.dumps(self._items, indent=2), encoding="utf-8")
