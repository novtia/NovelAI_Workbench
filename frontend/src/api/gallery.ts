import { request } from "./client";
import type { Album, Artwork, BasketArtist } from "@/data/types";

export async function listAlbums() {
  const data = await request<{ albums: Album[] }>("/api/albums");
  return data.albums;
}

export async function createAlbum(name: string) {
  const data = await request<{ album: Album }>("/api/albums", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return data.album;
}

export type GalleryView = { albumId: string; testSetId: string; presetId: string; version?: number };

export async function getView() {
  const data = await request<{ view: GalleryView }>("/api/gallery/view");
  return data.view;
}

export async function putView(view: Partial<GalleryView>) {
  const data = await request<{ view: GalleryView }>("/api/gallery/view", {
    method: "PUT",
    body: JSON.stringify(view),
  });
  return data.view;
}

export async function getBasket() {
  const data = await request<{ artists: BasketArtist[] }>("/api/artist-basket");
  return data.artists;
}

export async function addToBasket(names: string[]) {
  const data = await request<{ artists: BasketArtist[] }>("/api/artist-basket", {
    method: "POST",
    body: JSON.stringify({ names }),
  });
  return data.artists;
}

export async function removeFromBasket(key: string) {
  const data = await request<{ artists: BasketArtist[] }>(`/api/artist-basket/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
  return data.artists;
}

export async function clearBasket() {
  const data = await request<{ artists: BasketArtist[] }>("/api/artist-basket", { method: "DELETE" });
  return data.artists;
}

export async function createTestSet(name: string) {
  const data = await request<{ album: Album }>("/api/test-sets", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return data.album;
}

export async function renameAlbum(id: string, name: string) {
  const data = await request<{ album: Album }>(`/api/albums/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
  return data.album;
}

export async function deleteAlbum(id: string) {
  await request(`/api/albums/${id}`, { method: "DELETE" });
}

export async function restoreAlbum(id: string) {
  const data = await request<{ album: Album }>(`/api/albums/${id}/restore`, { method: "POST" });
  return data.album;
}

export async function listItems(albumId: string) {
  const data = await request<{ items: Artwork[] }>(`/api/albums/${albumId}/items`);
  return data.items;
}

export async function clearAlbum(albumId: string) {
  await request(`/api/albums/${albumId}/items`, { method: "DELETE" });
}

export async function hashExists(albumId: string, hash: string) {
  const data = await request<{ exists: boolean }>(`/api/albums/${albumId}/hashes/${hash}`);
  return data.exists;
}

export async function importItem(albumId: string, file: Blob, meta: Record<string, unknown>, thumb?: Blob) {
  const form = new FormData();
  form.append("file", file, (file as File).name || "image.png");
  if (thumb) form.append("thumb", thumb, "thumb.webp");
  form.append("meta", JSON.stringify(meta));
  const data = await request<{ item: Artwork }>(`/api/albums/${albumId}/items`, { method: "POST", body: form });
  return data.item;
}

export async function moveItem(id: string, albumId: string) {
  const data = await request<{ item: Artwork }>(`/api/items/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ albumId }),
  });
  return data.item;
}

export async function deleteItem(id: string) {
  await request(`/api/items/${id}`, { method: "DELETE" });
}

export async function restoreItem(id: string) {
  const data = await request<{ item: Artwork }>(`/api/items/${id}/restore`, { method: "POST" });
  return data.item;
}
