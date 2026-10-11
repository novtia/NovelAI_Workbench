import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
// start.ps1 选好端口后写进环境变量；单独 npm run dev 时仍用原来的默认值。
const apiPort = Number(process.env.WORKBENCH_PORT) || 8766;
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
  resolve: {
    alias: {
      "@": path.join(root, "src"),
    },
  },
  server: {
    host: "127.0.0.1",
    // 5173 常被本机 GameViewerServer 以 0.0.0.0 独占，绑定会报 EACCES。
    port: webPort,
    // 启动脚本已经确认过这个端口能绑定；不要再悄悄换端口，否则和打印出来的地址对不上。
    strictPort: Boolean(process.env.WORKBENCH_WEB_PORT),
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
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
