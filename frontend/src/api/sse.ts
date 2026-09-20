export function connectJobStream(onEvent: (payload: Record<string, unknown>) => void) {
  const es = new EventSource("/api/nai/jobs/stream");
  es.onmessage = (ev) => {
    try {
      onEvent(JSON.parse(ev.data) as Record<string, unknown>);
    } catch {
      /* ignore */
    }
  };
  return () => es.close();
}
