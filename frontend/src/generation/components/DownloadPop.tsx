import { closeStudioMenus, useStudio } from "@/state";

export function DownloadPop() {
  const { pop, popPos, downloadCurrent } = useStudio();
  const open = pop === "download";
  return (
    <div
      className={`pop-panel album-pop download-pop${open ? " open" : ""}`}
      id="st-download-pop"
      style={open ? { left: popPos.left, top: popPos.top } : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="pop-h">下载</div>
      <button
        type="button"
        onClick={() => {
          closeStudioMenus();
          void downloadCurrent("original");
        }}
      >
        <span>原图（带原数据）</span>
        <span className="sub">完整 PNG，含生成参数</span>
      </button>
      <button
        type="button"
        onClick={() => {
          closeStudioMenus();
          void downloadCurrent("clean");
        }}
      >
        <span>图片（不带数据）</span>
        <span className="sub">去掉隐写和元数据</span>
      </button>
    </div>
  );
}
