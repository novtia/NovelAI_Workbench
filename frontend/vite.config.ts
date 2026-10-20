import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
// Tauri 的 devUrl 固定指向这个端口（见 src-tauri/tauri.conf.json），端口被占用时必须报错而不是悄悄换端口。
const webPort = Number(process.env.WORKBENCH_WEB_PORT) || 5174;

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
  // 让 Tauri 的终端输出不被 Vite 清屏。
  clearScreen: false,
  resolve: {
    alias: {
      "@": path.join(root, "src"),
    },
  },
  server: {
    host: "127.0.0.1",
    // 5173 常被本机 GameViewerServer 以 0.0.0.0 独占，绑定会报 EACCES，所以默认用 5174。
    port: webPort,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          query: ["@tanstack/react-query"],
        },
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
