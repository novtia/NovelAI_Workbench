import { listen } from "@tauri-apps/api/event";
import { call } from "./client";

/**
 * 任务事件流：先订阅 `jobs-event`，再拉一次快照（等价于原来 SSE 连上后的第一条 snapshot），
 * 这样快照和订阅之间不会漏事件。返回取消订阅函数。
 */
export function connectJobStream(onEvent: (payload: Record<string, unknown>) => void) {
  let closed = false;
  let unlisten: (() => void) | null = null;

  void listen<Record<string, unknown>>("jobs-event", (ev) => {
    if (!closed) onEvent(ev.payload);
  })
    .then(async (off) => {
      if (closed) {
        off();
        return;
      }
      unlisten = off;
      const snapshot = await call<Record<string, unknown>>("nai_jobs_snapshot");
      if (!closed) onEvent(snapshot);
    })
    .catch(() => {
      /* 事件通道不可用时忽略，任务列表仍可手动刷新 */
    });

  return () => {
    closed = true;
    unlisten?.();
    unlisten = null;
  };
}
