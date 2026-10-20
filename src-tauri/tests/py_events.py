"""列出某类聚合的事件（排查用）。python py_events.py <库> <aggregate_type> [最多条数]"""
import sqlite3
import sys

conn = sqlite3.connect(sys.argv[1])
limit = int(sys.argv[3]) if len(sys.argv) > 3 else 50
for seq, et, payload in conn.execute(
    "SELECT global_seq, event_type, payload_json FROM events WHERE aggregate_type=? ORDER BY global_seq", (sys.argv[2],)
):
    print(seq, et, payload[:700])
    limit -= 1
    if limit <= 0:
        break
