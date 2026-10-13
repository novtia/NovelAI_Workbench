import { useSession } from "@/state";
import { HistoryBoard } from "./components/HistoryBoard";

export function HistoryView() {
  const view = useSession((s) => s.view);
  return (
    <section className={`view${view === "history" ? " active" : ""}`} id="view-history">
      <HistoryBoard />
    </section>
  );
}

export { HistoryView as default };
