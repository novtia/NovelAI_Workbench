import { useCommands, useCollection } from "@/state";
import { ImageDetail } from "@/ui/ImageDetail";

export function InspectorPanel() {
  const { openItem, albums, testSet } = useCollection();
  const { closeInspector, generateFrom, moveOpenItem, deleteOpenItem } = useCommands();
  const item = openItem;

  return (
    <ImageDetail
      id="inspector"
      item={item ?? null}
      onClose={closeInspector}
      onGenerate={() => item && generateFrom(item)}
      onDelete={() => void deleteOpenItem()}
      albumId="move-album"
      album={
        item ? (
          <select id="move-album" value={item.albumId} onChange={(e) => void moveOpenItem(e.target.value)}>
            {testSet && item.albumId === testSet.id && (
              <option value={testSet.id} disabled>
                测试集 · {testSet.name}
              </option>
            )}
            {albums.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        ) : null
      }
    />
  );
}
