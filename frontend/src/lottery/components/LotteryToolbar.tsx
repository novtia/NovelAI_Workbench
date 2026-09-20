import { Sparkles } from "lucide-react";
import { jobProgressText } from "@/data";
import { useLottery } from "@/state";

export function LotteryToolbar() {
  const { generateAll, copyAll, lotteryJobs } = useLottery();
  const run = lotteryJobs.find((j) => j.status === "running");
  const label = lotteryJobs.length
    ? run
      ? `后台 ${jobProgressText(run)} · ${lotteryJobs.length}`
      : `后台排队 ${lotteryJobs.length}`
    : null;

  return (
    <div className="l-toolbar">
      <h2>抽奖控制台</h2>
      <button className="btn btn-primary" type="button" onClick={() => void generateAll()}>
        {!label && <Sparkles strokeWidth={1.8} />}
        {label || "全部生图"}
      </button>
      <button className="btn" type="button" onClick={() => void copyAll()}>
        复制全部
      </button>
    </div>
  );
}
