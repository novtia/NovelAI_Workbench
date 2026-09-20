import { isListed } from "@/data";
import { useLottery } from "@/state";
import { PoolEmpty } from "./PoolEmpty";
import { PoolSearch } from "./PoolSearch";
import { PoolSection } from "./PoolSection";

export function PoolSidebar() {
  const { pool, active, pinnedCount, visible, pinned, restoreExcluded } = useLottery();
  const pinnedRows = visible.filter((p) => isListed(pinned, p));
  const restRows = visible.filter((p) => !isListed(pinned, p));

  return (
    <aside className="l-side">
      <div className="l-side-head">
        <span className="pane-title">画师池</span>
        <span className="pool-n">
          {pinnedCount ? `${active.length} / ${pool.length} 人 · 基底 ${pinnedCount}` : `${active.length} / ${pool.length} 人`}
        </span>
      </div>
      <PoolSearch />
      <div className="pool-list">
        {!pool.length && (
          <PoolEmpty>
            当前收藏夹还没有画师。
            <br />
            导入带画师串的图片后，这里会出现可抽的画师池。
          </PoolEmpty>
        )}
        {pool.length > 0 && !visible.length && <PoolEmpty>没有匹配的画师。</PoolEmpty>}
        <PoolSection title={pinnedRows.length ? `基底 · ${pinnedRows.length}` : undefined} artists={pinnedRows} />
        <PoolSection title={pinnedRows.length ? "抽奖池" : undefined} artists={restRows} />
      </div>
      <div className="l-side-foot">
        <button className="btn" type="button" onClick={restoreExcluded}>
          恢复全部
        </button>
      </div>
      <p className="l-side-hint">图钉固定为基底画师，每条抽奖必出并占名额。点画师名可暂时排除；右侧 ≤ 限制抽中后的权重上限。</p>
    </aside>
  );
}
