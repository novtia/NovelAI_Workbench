import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { extractArtists } from "@/data";
import type { Artwork } from "@/data/types";
import type { HistoryShot } from "@/data/history";
import { deleteHistoryShots, loadShotParams, pushToast, saveShotsToAlbum, useAlbumsQuery } from "@/state";
import { ImageDetail } from "@/ui/ImageDetail";

function textOf(value: unknown) {
  const text = value == null ? "" : String(value);
  return text && text !== "undefined" ? text : "";
}

/** 历史图没有收藏夹条目，按生图参数拼一份和图库详情相同的视图。 */
function asArtwork(shot: HistoryShot): Artwork {
  const meta = shot.meta || {};
  const parsed = extractArtists(String(meta.prompt || meta.artistLine || ""));
  const listed = Array.isArray(meta.artists) ? meta.artists.map((n) => String(n)).filter(Boolean) : [];
  const names = parsed.names.length ? parsed.names : listed;
  return {
    id: shot.itemId,
    albumId: "",
    addedAt: shot.createdAt,
    name: textOf(meta.name) || "nai.png",
    mime: "image/png",
    size: 0,
    hash: shot.blobHash,
    width: shot.width,
    height: shot.height,
    artists: names,
    artistLine: parsed.line || names.map((n) => `artist:${n}`).join(", "),
    params: { ...meta, artistChain: parsed.chain || meta.artistChain },
    imageUrl: shot.url,
    thumbUrl: shot.thumbUrl,
  };
}

export function HistoryDetail({ shot, onClose }: { shot: HistoryShot | null; onClose: () => void }) {
  const albums = useAlbumsQuery().data || [];
  const [picked, setPicked] = useState("");
  const qc = useQueryClient();
  const target = albums.some((a) => a.id === picked) ? picked : albums[0]?.id || "";
  const item = shot ? asArtwork(shot) : null;

  async function save() {
    if (!shot?.blobHash) {
      pushToast("这张图没有可保存的文件", "warn");
      return;
    }
    if (!target) {
      pushToast("还没有收藏夹", "warn");
      return;
    }
    await saveShotsToAlbum(qc, [shot], target, albums.find((a) => a.id === target)?.name);
  }

  async function remove() {
    if (!shot) return;
    if (await deleteHistoryShots(qc, [shot])) onClose();
  }

  return (
    <ImageDetail
      item={item}
      onClose={onClose}
      onGenerate={() => shot && loadShotParams(shot)}
      onDelete={() => void remove()}
      albumId="hist-album"
      album={
        <>
          <select id="hist-album" value={target} onChange={(e) => setPicked(e.target.value)} disabled={!albums.length}>
            {albums.length ? (
              albums.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))
            ) : (
              <option value="">没有收藏夹</option>
            )}
          </select>
          <button className="mini" type="button" onClick={() => void save()}>
            存入
          </button>
        </>
      }
    />
  );
}
