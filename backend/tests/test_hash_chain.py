from kernel.hashes import GENESIS_HASH, event_hash
from kernel.events import NewEvent
from kernel.store import EventStore


def test_hash_chain_appends(tmp_path):
    store = EventStore(tmp_path / "events.sqlite")
    e1 = NewEvent(
        aggregate_id="a1",
        aggregate_type="Album",
        version=1,
        event_type="AlbumRegistered",
        payload={"name": "默认收藏夹", "createdAt": 1, "order": 1},
        command_id="c1",
    )
    stored = store.append([e1], command_id="c1")
    assert len(stored) == 1
    assert stored[0].prev_hash == GENESIS_HASH
    assert stored[0].event_hash == event_hash(GENESIS_HASH, e1.hash_body())

    e2 = NewEvent(
        aggregate_id="a1",
        aggregate_type="Album",
        version=2,
        event_type="AlbumRenamed",
        payload={"name": "新名字"},
        command_id="c2",
    )
    stored2 = store.append([e2], command_id="c2")
    assert stored2[0].prev_hash == stored[0].event_hash

    again = store.append([e1], command_id="c1")
    assert again[0].event_id == stored[0].event_id
