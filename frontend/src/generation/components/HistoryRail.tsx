import { previewUrl, writeStudioShotDrag } from "@/data";
import { pushToast, useStudio } from "@/state";
import { IconHistPlay, IconTrash } from "./icons";

export function HistoryRail() {
  const { session, current, showShot, clearSession } = useStudio();
  return (
    <aside className="hist">
      <div className="hist-head">
        历史
        <IconHistPlay />
        <span className="hist-n">{session.length}</span>
      </div>
      <div className="hist-grid">
        {session.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`thumb${current?.id === item.id ? " on" : ""}`}
            title={item.name || "生成结果"}
            draggable
            onClick={() => showShot(item)}
            onDragStart={(e) => {
              if (!e.dataTransfer) return;
              writeStudioShotDrag(e.dataTransfer, {
                id: item.id,
                blobHash: item.blobHash,
                url: item.url || previewUrl(item),
                name: item.name,
              });
            }}
          >
            <img src={item.thumbUrl || previewUrl(item)} alt="" loading="lazy" decoding="async" draggable={false} />
          </button>
        ))}
      </div>
      <div className="hist-foot">
        <button
          className="ico danger"
          type="button"
          title="清空本次会话"
          onClick={() => {
            clearSession();
            pushToast("已清空会话历史");
          }}
        >
          <IconTrash />
        </button>
      </div>
    </aside>
  );
}
