import { useLottery } from "@/state";

export function PoolSearch() {
  const { query, setQuery } = useLottery();
  return (
    <input
      className="search"
      type="search"
      value={query}
      onChange={(e) => setQuery(e.target.value)}
      placeholder="搜索画师…"
      autoComplete="off"
    />
  );
}
