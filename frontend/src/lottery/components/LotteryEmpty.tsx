export function LotteryEmpty() {
  return (
    <p className="lottery-empty">
      从画师池随机抽 min~max 位画师，基底画师每条必出并占名额。权重落在最小~最大之间并加总到目标和。每次抽奖会追加一批，可删整批或其中一条。
    </p>
  );
}
