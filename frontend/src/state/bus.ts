type Handler = (payload: unknown) => void;
const map = new Map<string, Set<Handler>>();

export function on(event: string, handler: Handler) {
  if (!map.has(event)) map.set(event, new Set());
  map.get(event)!.add(handler);
  return () => {
    map.get(event)?.delete(handler);
  };
}

export function emit(event: string, payload?: unknown) {
  for (const handler of map.get(event) || []) handler(payload);
}
