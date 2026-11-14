import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initLogger } from "./lib/logger";
import { pushToast } from "./state/toast";

initLogger({
  onShortcutBlocked: () => pushToast("请先在「设置 -> 系统」启用调试模式", "warn"),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
