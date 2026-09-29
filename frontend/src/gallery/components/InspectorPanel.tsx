import { asMeta, charCaptions, negativeText, promptText, sourceLabel } from "@/data";
import { useCommands, useCollection } from "@/state";
import { ArtistHoverTrigger } from "@/ui/ArtistHover";
import { IconCopy, IconX } from "@/generation/components/icons";

export function InspectorPanel() {
  const { openItem, albums } = useCollection();
  const { closeInspector, copyArtists, copyPrompt, generateFrom, moveOpenItem, deleteOpenItem } = useCommands();
  const item = openItem;
  const p = asMeta(item?.params);
  const size =
    p.width && p.height
      ? `${p.width} × ${p.height}`
      : item?.width && item?.height
        ? `${item.width} × ${item.height}`
        : "—";
  const chars = item ? charCaptions(item) : [];

  return (
    <aside className={`inspector${item ? " open" : ""}`} id="inspector" aria-hidden={!item}>
      <div className="insp-inner">
        <div className="insp-head">
          <span className="pane-title">图片详情</span>
          <button className="icon-btn" type="button" title="复制画师串" aria-label="复制画师串" onClick={() => void copyArtists(item)}>
            <IconCopy />
          </button>
          <button className="icon-btn" type="button" title="关闭" aria-label="关闭" onClick={closeInspector}>
            <IconX />
          </button>
        </div>
        <div className="insp-body">
          {item && (
            <>
              <div className="preview">
                <img src={item.imageUrl} alt="" width={item.width || undefined} height={item.height || undefined} />
              </div>
              <div className="artist-row">
                {(item.artists || []).length
                  ? item.artists.map((n) => (
                      <ArtistHoverTrigger className="chip" name={n} key={n}>
                        artist:{n}
                      </ArtistHoverTrigger>
                    ))
                  : <span className="chip">未识别画师</span>}
              </div>
              <dl className="meta-grid">
                <dt>文件</dt>
                <dd>{item.name}</dd>
                <dt>模型</dt>
                <dd>{p.model || "—"}</dd>
                <dt>来源</dt>
                <dd>{p.software || "—"}</dd>
                <dt>分辨率</dt>
                <dd>{size}</dd>
                <dt>步数</dt>
                <dd>{p.steps ?? "—"}</dd>
                <dt>Sampler</dt>
                <dd>{p.sampler || "—"}</dd>
                <dt>CFG</dt>
                <dd>{p.scale ?? "—"}</dd>
                <dt>Seed</dt>
                <dd>{p.seed ?? "—"}</dd>
                <dt>解析</dt>
                <dd>{sourceLabel(p.source)}</dd>
              </dl>
              <div className="move-row">
                <label htmlFor="move-album">收藏夹</label>
                <select id="move-album" value={item.albumId} onChange={(e) => void moveOpenItem(e.target.value)}>
                  {albums.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="block">
                <div className="block-head">
                  <span>Prompt</span>
                </div>
                <pre className="prompt">{promptText(item) || "—"}</pre>
              </div>
              <div className="block">
                <div className="block-head">
                  <span>Negative</span>
                </div>
                <pre className="prompt">{negativeText(item) || "—"}</pre>
              </div>
              {chars.map((c, i) => {
                const center = c.centers?.[0];
                const pos = center ? ` · (${Number(center.x).toFixed(2)}, ${Number(center.y).toFixed(2)})` : "";
                return (
                  <div className="block" key={i}>
                    <div className="block-head">
                      <span>
                        角色 {i + 1}
                        {pos}
                      </span>
                    </div>
                    <pre className="prompt">{c.char_caption || ""}</pre>
                  </div>
                );
              })}
            </>
          )}
        </div>
        <div className="insp-foot">
          <button className="btn" type="button" onClick={() => void copyPrompt(item)}>
            复制 Prompt
          </button>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => {
              if (item) generateFrom(item);
            }}
          >
            用此参数生图
          </button>
          <button className="btn btn-danger" type="button" onClick={() => void deleteOpenItem()}>
            删除
          </button>
        </div>
      </div>
    </aside>
  );
}
