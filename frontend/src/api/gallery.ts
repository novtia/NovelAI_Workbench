import { call, callRaw } from "./client";
import type { Album, Artwork, BasketArtist } from "@/data/types";

export async function listAlbums() {
  const data = await call<{ albums: Album[] }>("gallery_list_albums");
  return data.albums;
}

export async function createAlbum(name: string) {
  const data = await call<{ album: Album }>("gallery_create_album", { name });
  return data.album;
}

export type GalleryView = { albumId: string; testSetId: string; presetId: string; version?: number };

export async function getView() {
  const data = await call<{ view: GalleryView }>("gallery_get_view");
  return data.view;
}

export async function putView(view: Partial<GalleryView>) {
  const data = await call<{ view: GalleryView }>("gallery_put_view", { view });
  return data.view;
}

export async function getBasket() {
  const data = await call<{ artists: BasketArtist[] }>("gallery_get_basket");
  return data.artists;
}

export async function addToBasket(names: string[]) {
  const data = await call<{ artists: BasketArtist[] }>("gallery_add_basket", { names });
  return data.artists;
}

export async function removeFromBasket(key: string) {
  const data = await call<{ artists: BasketArtist[] }>("gallery_remove_basket", { key });
  return data.artists;
}

export async function clearBasket() {
  const data = await call<{ artists: BasketArtist[] }>("gallery_clear_basket");
  return data.artists;
}

export async function createTestSet(name: string) {
  const data = await call<{ album: Album }>("gallery_create_test_set", { name });
  return data.album;
}

export async function renameAlbum(id: string, name: string) {
  const data = await call<{ album: Album }>("gallery_rename_album", { id, name });
  return data.album;
}

export async function deleteAlbum(id: string) {
  await call("gallery_delete_album", { id });
}

export async function restoreAlbum(id: string) {
  const data = await call<{ album: Album }>("gallery_restore_album", { id });
  return data.album;
}

export async function listItems(albumId: string) {
  const data = await call<{ items: Artwork[] }>("gallery_list_items", { albumId });
  return data.items;
}

export async function clearAlbum(albumId: string) {
  await call("gallery_clear_album", { albumId });
}

export async function hashExists(albumId: string, hash: string) {
  const data = await call<{ exists: boolean }>("gallery_has_hash", { albumId, hash });
  return data.exists;
}

/**
 * 导入图片的请求体：`u32le 头长度 | 头 JSON {albumId, meta, thumbLen} | 缩略图字节 | 原图字节`。
 * 对应 Rust 端 `gallery_import_item`。
 */
export async function packImport(
  albumId: string,
  file: Blob,
  meta: Record<string, unknown>,
  thumb?: Blob,
): Promise<Uint8Array> {
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const thumbBytes = thumb ? new Uint8Array(await thumb.arrayBuffer()) : new Uint8Array(0);
  const head = new TextEncoder().encode(JSON.stringify({ albumId, meta, thumbLen: thumbBytes.length }));
  const out = new Uint8Array(4 + head.length + thumbBytes.length + fileBytes.length);
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  out.set(thumbBytes, 4 + head.length);
  out.set(fileBytes, 4 + head.length + thumbBytes.length);
  return out;
}

export async function importItem(albumId: string, file: Blob, meta: Record<string, unknown>, thumb?: Blob) {
  const body = await packImport(albumId, file, meta, thumb);
  const data = await callRaw<{ item: Artwork }>("gallery_import_item", body);
  return data.item;
}

export async function moveItem(id: string, albumId: string) {
  const data = await call<{ item: Artwork }>("gallery_move_item", { id, albumId });
  return data.item;
}

export async function deleteItem(id: string) {
  await call("gallery_delete_item", { id });
}

export async function restoreItem(id: string) {
  const data = await call<{ item: Artwork }>("gallery_restore_item", { id });
  return data.item;
}
