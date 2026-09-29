import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

/** 标签页闲置后热更新连接会断开；Vite 默认在页面重新可见时整页刷新。这里改成只重连、不刷新。 */
function keepPageOnReconnect() {
  return {
    name: "keep-page-on-reconnect",
    apply: "serve" as const,
    transform(code: string, id: string) {
      if (!id.replace(/\\/g, "/").includes("vite/dist/client/client.mjs")) return null;
      const next = code.replace(
        /await waitForSuccessfulPing\(url\.href\);\s*location\.reload\(\);/,
        'await waitForSuccessfulPing(url.href); console.info("[vite] reconnected, page kept");',
      );
      return next === code ? null : next;
    },
  };
}

export default defineConfig({
  plugins: [react(), keepPageOnReconnect()],
  resolve: {
    alias: {
      "@": path.join(root, "src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8766",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
