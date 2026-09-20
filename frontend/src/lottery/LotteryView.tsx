import { AlbumSavePop } from "./components/AlbumSavePop";
import { LotterySkeleton } from "./skeleton/LotterySkeleton";

export function LotteryView() {
  return (
    <>
      <LotterySkeleton />
      <AlbumSavePop />
    </>
  );
}

export { LotteryView as default };
