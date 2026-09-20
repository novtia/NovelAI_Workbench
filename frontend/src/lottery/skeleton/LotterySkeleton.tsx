import { PoolSidebar } from "../components/PoolSidebar";
import { LotteryToolbar } from "../components/LotteryToolbar";
import { LotteryConsole } from "../components/LotteryConsole";
import { PresetBar } from "../components/PresetBar";
import { BatchList } from "../components/BatchList";
import { useSession } from "@/state";

export function LotterySkeleton() {
  const view = useSession((s) => s.view);
  return (
    <section className={`view${view === "lottery" ? " active" : ""}`} id="view-lottery">
      <PoolSidebar />
      <div className="l-main">
        <LotteryToolbar />
        <div className="l-scroll">
          <LotteryConsole />
          <PresetBar />
          <BatchList />
        </div>
      </div>
    </section>
  );
}
