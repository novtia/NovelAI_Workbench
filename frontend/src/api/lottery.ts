import { call } from "./client";
import { normalizeBoard } from "@/data/lottery";
import type { DrawBatch, LotteryBoard } from "@/data/types";

export async function getBoard() {
  const data = await call<{ board: Record<string, unknown> }>("lottery_get_board");
  return normalizeBoard(data.board);
}

export async function saveBoard(body: Record<string, unknown>) {
  const data = await call<{ board: Record<string, unknown> }>("lottery_put_board", { body });
  return normalizeBoard(data.board) as LotteryBoard;
}

export async function listBatches() {
  const data = await call<{ batches: DrawBatch[] }>("lottery_list_batches");
  return data.batches;
}

export async function rollDraws(albumId: string, body: Record<string, unknown>) {
  const data = await call<{ batch: DrawBatch }>("lottery_draw", { body: { albumId, ...body } });
  return data.batch;
}

export async function verifyBatch(id: string) {
  return call<{ ok: boolean; poolHashMatch: boolean; drawsMatch: boolean }>("lottery_verify", { id });
}

export async function deleteBatch(id: string) {
  await call("lottery_delete_batch", { id });
}

export async function removeDraw(id: string, drawId: string) {
  const data = await call<{ batch: DrawBatch }>("lottery_remove_draw", { id, drawRef: drawId });
  return data.batch;
}
