import { invoke } from "@tauri-apps/api/core";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Rust 端 `DomainError` 序列化成 `{ error, status }`；Tauri 自身的错误（命令不存在等）是字符串。 */
function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e && typeof e === "object" && "error" in e) {
    const { error, status } = e as { error?: unknown; status?: unknown };
    const code = typeof status === "number" ? status : 500;
    return new ApiError(typeof error === "string" && error ? error : `请求失败 (${code})`, code);
  }
  if (typeof e === "string") return new ApiError(e || "请求失败", 500);
  if (e instanceof Error) return new ApiError(e.message || "请求失败", 500);
  return new ApiError("请求失败", 500);
}

/** 调用 Rust 命令。参数名用 camelCase，Tauri 会映射到 Rust 的 snake_case。 */
export async function call<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return (await invoke<T>(cmd, args)) as T;
  } catch (e) {
    throw toApiError(e);
  }
}

/** 请求体就是原始字节的命令（上传图片），其它信息只能放进字节里。 */
export async function callRaw<T = unknown>(cmd: string, body: Uint8Array): Promise<T> {
  try {
    return (await invoke<T>(cmd, body)) as T;
  } catch (e) {
    throw toApiError(e);
  }
}
