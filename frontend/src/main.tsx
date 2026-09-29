import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// 长时间把标签页丢在后台时，浏览器会把它回收并在下次打开时重新加载。
// 共享锁会阻止这种回收，页面上的生图记录才不会被清掉。
if (navigator.locks) {
  void navigator.locks.request("workbench-keep", { mode: "shared" }, () => new Promise(() => {}));
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
