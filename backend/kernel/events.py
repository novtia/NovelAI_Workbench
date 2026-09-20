from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from kernel.clock import new_id, now_ms


@dataclass(slots=True)
class NewEvent:
    aggregate_id: str
    aggregate_type: str
    version: int
    event_type: str
    payload: dict[str, Any]
    occurred_at: int = field(default_factory=now_ms)
    event_id: str = field(default_factory=new_id)
    causation_id: str | None = None
    correlation_id: str | None = None
    command_id: str | None = None

    def hash_body(self) -> dict[str, Any]:
        return {
            "aggregate_id": self.aggregate_id,
            "aggregate_type": self.aggregate_type,
            "causation_id": self.causation_id,
            "command_id": self.command_id,
            "correlation_id": self.correlation_id,
            "event_id": self.event_id,
            "event_type": self.event_type,
            "occurred_at": self.occurred_at,
            "payload": self.payload,
            "version": self.version,
        }


@dataclass(slots=True)
class StoredEvent:
    global_seq: int
    event_id: str
    aggregate_id: str
    aggregate_type: str
    version: int
    event_type: str
    payload: dict[str, Any]
    occurred_at: int
    causation_id: str | None
    correlation_id: str | None
    command_id: str | None
    prev_hash: str
    event_hash: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "globalSeq": self.global_seq,
            "eventId": self.event_id,
            "aggregateId": self.aggregate_id,
            "aggregateType": self.aggregate_type,
            "version": self.version,
            "eventType": self.event_type,
            "payload": self.payload,
            "occurredAt": self.occurred_at,
            "causationId": self.causation_id,
            "correlationId": self.correlation_id,
            "commandId": self.command_id,
            "prevHash": self.prev_hash,
            "eventHash": self.event_hash,
        }


class AggregateRoot:
    aggregate_type: str = ""

    def __init__(self, aggregate_id: str):
        self.id = aggregate_id
        self.version = 0
        self.pending: list[NewEvent] = []

    def record(
        self,
        event_type: str,
        payload: dict[str, Any],
        *,
        command_id: str | None = None,
        causation_id: str | None = None,
        correlation_id: str | None = None,
    ) -> NewEvent:
        event = NewEvent(
            aggregate_id=self.id,
            aggregate_type=self.aggregate_type,
            version=self.version + 1,
            event_type=event_type,
            payload=payload,
            command_id=command_id,
            causation_id=causation_id,
            correlation_id=correlation_id,
        )
        self.apply(event)
        self.pending.append(event)
        return event

    def apply(self, event: NewEvent | StoredEvent) -> None:
        self.version = event.version
        handler: Callable[[dict[str, Any]], None] | None = getattr(
            self, f"_on_{event.event_type}", None
        )
        if handler:
            handler(event.payload)

    def rehydrate(self, events: list[StoredEvent]) -> None:
        for event in events:
            self.apply(event)
