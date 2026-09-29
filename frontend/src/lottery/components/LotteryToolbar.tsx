import { jobProgressText } from "@/data";
import { useLottery } from "@/state";
import { IconSparkles } from "@/generation/components/icons";

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
      <span className="kicker">LOTTERY</span>
      <h2>抽奖控制台</h2>
      <button className="btn btn-primary" type="button" onClick={() => void generateAll()}>
        {!label && <IconSparkles />}
        {label || "全部生图"}
      </button>
      <button className="btn" type="button" onClick={() => void copyAll()}>
        复制全部
      </button>
    </div>
  );
}
