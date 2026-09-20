import { request } from "./client";
import { normalizeBoard } from "@/data/lottery";
import type { DrawBatch, LotteryBoard } from "@/data/types";

export async function getBoard() {
  const data = await request<{ board: Record<string, unknown> }>("/api/lottery/board");
  return normalizeBoard(data.board);
}

export async function saveBoard(body: Record<string, unknown>) {
  const data = await request<{ board: Record<string, unknown> }>("/api/lottery/board", {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return normalizeBoard(data.board) as LotteryBoard;
}

export async function listBatches() {
  const data = await request<{ batches: DrawBatch[] }>("/api/lottery/batches");
  return data.batches;
}

export async function rollDraws(albumId: string, body: Record<string, unknown>) {
  const data = await request<{ batch: DrawBatch }>("/api/lottery/draws", {
    method: "POST",
    body: JSON.stringify({ albumId, ...body }),
  });
  return data.batch;
}

export async function verifyBatch(id: string) {
  return request<{ ok: boolean; poolHashMatch: boolean; drawsMatch: boolean }>(`/api/lottery/batches/${id}/verify`, {
    method: "POST",
  });
}

export async function deleteBatch(id: string) {
  await request(`/api/lottery/batches/${id}`, { method: "DELETE" });
}

export async function removeDraw(id: string, drawId: string) {
  const data = await request<{ batch: DrawBatch }>(
    `/api/lottery/batches/${encodeURIComponent(id)}/draws/${encodeURIComponent(drawId)}`,
    { method: "DELETE" },
  );
  return data.batch;
}
