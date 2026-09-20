from __future__ import annotations

import json
from collections import defaultdict
from typing import Callable

from kernel.events import StoredEvent
from kernel.hashes import GENESIS_HASH, event_hash
from kernel.store import EventStore


class EventHub:
    def __init__(self):
        self._subs: list[Callable[[StoredEvent], None]] = []

    def on(self, fn: Callable[[StoredEvent], None]) -> None:
        self._subs.append(fn)

    def emit(self, events: list[StoredEvent]) -> None:
        for event in events:
            for fn in list(self._subs):
                fn(event)


class Projector:
    def handle(self, event: StoredEvent, conn) -> None:
        raise NotImplementedError


class UnitOfWork:
    def __init__(self, store: EventStore, projectors: list[Projector], hub: EventHub):
        self.store = store
        self.projectors = projectors
        self.hub = hub

    def commit(self, aggregate, *, command_id: str | None = None) -> list[StoredEvent]:
        pending = list(aggregate.pending)
        if not pending:
            return []

        def after(stored: list[StoredEvent], conn) -> None:
            for event in stored:
                for projector in self.projectors:
                    projector.handle(event, conn)

        stored = self.store.append(pending, command_id=command_id, after=after)
        aggregate.pending.clear()
        self.hub.emit(stored)
        return stored

    def load(self, cls, aggregate_id: str):
        agg = cls(aggregate_id)
        agg.rehydrate(self.store.load_stream(aggregate_id))
        return agg


def verify_chain(store: EventStore) -> dict:
    events = store.load_all()
    prev = GENESIS_HASH
    errors: list[str] = []
    for event in events:
        if event.prev_hash != prev:
            errors.append(f"seq {event.global_seq}: prev_hash mismatch")
        body = {
            "aggregate_id": event.aggregate_id,
            "aggregate_type": event.aggregate_type,
            "causation_id": event.causation_id,
            "command_id": event.command_id,
            "correlation_id": event.correlation_id,
            "event_id": event.event_id,
            "event_type": event.event_type,
            "occurred_at": event.occurred_at,
            "payload": event.payload,
            "version": event.version,
        }
        expected = event_hash(event.prev_hash, body)
        if expected != event.event_hash:
            errors.append(f"seq {event.global_seq}: event_hash mismatch")
        prev = event.event_hash
    return {
        "ok": not errors,
        "events": len(events),
        "head": prev if events else GENESIS_HASH,
        "errors": errors[:50],
        "truncated": len(errors) > 50,
    }


def referenced_hashes(store: EventStore) -> set[str]:
    hashes: set[str] = set()
    for event in store.load_all():
        payload = event.payload or {}
        for key in ("blobHash", "thumbHash", "previewHash", "poolHash"):
            value = payload.get(key)
            if isinstance(value, str) and len(value) == 64:
                hashes.add(value.lower())
        items = payload.get("items")
        if isinstance(items, list):
            for item in items:
                if not isinstance(item, dict):
                    continue
                for key in ("blobHash", "thumbHash"):
                    value = item.get(key)
                    if isinstance(value, str) and len(value) == 64:
                        hashes.add(value.lower())
    return hashes
