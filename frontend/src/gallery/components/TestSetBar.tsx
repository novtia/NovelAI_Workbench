import { isSingleArtistAlbum } from "@/data";
import { IconPencil, IconTrash } from "@/generation/components/icons";
import { useCollection, useTestRun } from "@/state";

/** 单画师图库专用：测试集是画师的「皮肤」，切换只换图不改布局；选预设新建测试集并流式生成，可停止、可继续。 */
export function TestSetBar() {
  const { album, baseItems } = useCollection();
  const t = useTestRun();
  if (!isSingleArtistAlbum(album)) return null;

  const { progress, running, submitting } = t;
  const empty = !t.sets.length;
  const canStart = !running && !submitting && Boolean(t.preset) && baseItems.length > 0;

  return (
    <div className="g-testbar">
      <div className="tb-group">
        <label className="tb-field tb-set">
          <span>测试集</span>
          <select value={t.testSetId} onChange={(e) => t.selectTestSet(e.target.value)}>
            <option value="">默认（导入的原图）</option>
            {t.testSets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}（{s.count ?? 0}）
              </option>
            ))}
          </select>
        </label>
        {t.testSet && (
          <span className="tb-ops">
            <button type="button" className="icon-btn" title="重命名测试集" aria-label="重命名测试集" onClick={t.renameTestSet}>
              <IconPencil />
            </button>
            <button type="button" className="icon-btn" title="删除测试集" aria-label="删除测试集" onClick={() => void t.deleteTestSet()}>
              <IconTrash />
            </button>
          </span>
        )}
      </div>
      <span className="tb-sep" aria-hidden="true" />
      <div className="tb-group">
        <label className="tb-field tb-preset">
          <span>生图预设</span>
          <select value={t.presetId} disabled={running} onChange={(e) => t.setPresetId(e.target.value)}>
            <option value="">{empty ? "暂无预设，请先在生图室保存" : "请选择预设"}</option>
            {t.sets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-primary tb-run"
          disabled={!canStart}
          title="新建以预设命名的测试集，按图库顺序从第一位画师开始逐个生成皮肤图；没轮到的画师继续显示默认图"
          onClick={() => void t.start()}
        >
          生成测试图
        </button>
        {t.canResume && (
          <button
            type="button"
            className="btn tb-resume"
            title="只给这个测试集里还没有图的画师继续生成，不新建测试集"
            onClick={() => void t.resume()}
          >
            继续（剩 {progress?.missing ?? 0}）
          </button>
        )}
      </div>
      {progress && running && (
        <>
          <span className="tb-progress">
            生图 {progress.done}/{progress.total}
          </span>
          <button type="button" className="mini mini-danger" onClick={() => void t.cancel()}>
            停止
          </button>
        </>
      )}
      {progress && !running && progress.missing > 0 && (
        <span className={`tb-progress${progress.failed > 0 ? " is-warn" : ""}`}>
          已生成 {progress.done}/{progress.total}
          {progress.failed > 0 ? `，${progress.failed} 张失败` : ""}，其余显示默认图
        </span>
      )}
    </div>
  );
}
