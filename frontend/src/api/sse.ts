import { listen } from "@tauri-apps/api/event";
import { call } from "./client";
import { createLogger } from "@/lib/logger";

const log = createLogger("stream");

/**
 * 任务事件流：先订阅 `jobs-event`，再拉一次快照（等价于原来 SSE 连上后的第一条 snapshot），
 * 这样快照和订阅之间不会漏事件。返回取消订阅函数。
 */
export function connectJobStream(onEvent: (payload: Record<string, unknown>) => void) {
  let closed = false;
  let unlisten: (() => void) | null = null;
  log.debug("connectJobStream.init");

  void listen<Record<string, unknown>>("jobs-event", (ev) => {
    if (closed) return;
    const p = ev.payload;
    const type = String(p?.type || "");
    if (type === "job" && p.job && typeof p.job === "object") {
      const j = p.job as { id?: string; status?: string; source?: string; progress?: { text?: string }; error?: string };
      log.debug("recv.job", {
        id: j.id,
        status: j.status,
        source: j.source,
        text: j.progress?.text,
        error: j.error,
      });
    } else if (type === "preview") {
      if (typeof p.text === "string" || p.final) {
        log.debug("recv.preview", { id: p.id, text: p.text, step: p.step, final: p.final });
      }
    } else if (type === "removed") {
      log.debug("recv.removed", { ids: p.ids });
    }
    onEvent(p);
  })
    .then(async (off) => {
      if (closed) {
        off();
        return;
      }
      unlisten = off;
      const snapshot = await call<Record<string, unknown>>("nai_jobs_snapshot");
      if (!closed) {
        const jobs = Array.isArray(snapshot?.jobs)
          ? (snapshot.jobs as Array<{ id?: string; status?: string; source?: string; progress?: { text?: string } }>)
          : [];
        const active = jobs.filter((j) => j.status === "queued" || j.status === "running");
        log.debug("snapshot", {
          total: jobs.length,
          active: active.map((j) => ({ id: j.id, status: j.status, source: j.source, text: j.progress?.text })),
        });
        onEvent(snapshot);
      }
    })
    .catch((err) => {
      log.warn("connectJobStream.error", err);
    });

  return () => {
    closed = true;
    log.debug("connectJobStream.close");
    unlisten?.();
    unlisten = null;
  };
}
