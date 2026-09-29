import { Plus } from "lucide-react";
import { isSingleArtistAlbum } from "@/data";
import { useCommands, useCollection } from "@/state";

export function EmptyDropzone() {
  const { album } = useCollection();
  const { pickFiles } = useCommands();
  const single = isSingleArtistAlbum(album);
  return (
    <section className="empty visible">
      <div className="dropzone" onClick={pickFiles}>
        <div className="drop-mark">
          <Plus strokeWidth={1.6} />
        </div>
        <h2>拖入图片即可收藏</h2>
        <p>
          图片会进入「{album?.name || "收藏夹"}」。
          <br />
          {single ? "只接受含单个画师串的测试图。同一画师多张会单独成组显示。" : "列表只展示画面与底部 artist:name。"}
        </p>
        <p className="hint">支持批量拖入、粘贴、选择文件夹</p>
      </div>
    </section>
  );
}
