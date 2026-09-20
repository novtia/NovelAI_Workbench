import { useEffect, useRef } from "react";
import { useLottery } from "@/state";
import { BatchCard } from "./BatchCard";
import { LotteryEmpty } from "./LotteryEmpty";

export function BatchList() {
  const { batches, scrollTo, setScrollTo } = useLottery();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!scrollTo || !root.current) return;
    const el = root.current.querySelector(`[data-batch="${CSS.escape(scrollTo)}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    setScrollTo("");
  }, [scrollTo, batches, setScrollTo]);

  return (
    <div className="lot-batches" ref={root}>
      {!batches.length ? <LotteryEmpty /> : batches.map((batch) => <BatchCard key={batch.id} batch={batch} />)}
    </div>
  );
}
