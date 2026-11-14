import { useState } from "react";
import {
  ArrowLeft,
  ExternalLink,
  Globe,
  RefreshCw,
} from "lucide-react";
import { mediaApi } from "@/api";
import { normalizeWebUrl } from "@/data";
import { pushToast, useSession, useTabs } from "@/state";

export function WebPageView() {
  const activeTab = useTabs((s) => s.tabs.find((t) => t.id === s.activeId));
  const setView = useSession((s) => s.setView);
  const [reloadKey, setReloadKey] = useState(0);

  const webUrl = normalizeWebUrl(activeTab?.webUrl || "");
  const webTitle = activeTab?.webTitle || webUrl || "网页";

  async function handleOpenExternal() {
    if (!webUrl) return;
    try {
      await mediaApi.openExternalUrl(webUrl);
    } catch {
      window.open(webUrl, "_blank", "noopener,noreferrer");
    }
    pushToast("已在系统浏览器打开");
  }

  return (
    <section className="view active" id="view-web">
      <div className="w-page">
        <div className="w-bar">
          <div className="w-bar-left">
            <button
              type="button"
              className="btn w-back-btn"
              title="切换当前标签回媒体导航首页"
              onClick={() => setView("media")}
            >
              <ArrowLeft />
              <span>媒体导航</span>
            </button>
            <span className="w-title" title={webTitle}>
              <Globe className="w-title-ico" />
              {webTitle}
            </span>
          </div>

          <div className="w-addr" title={webUrl}>
            <span className="w-addr-text">{webUrl || "未指定网址"}</span>
          </div>

          <div className="w-bar-right">
            <button
              type="button"
              className="btn w-icon-btn"
              title="重新加载页面"
              onClick={() => setReloadKey((k) => k + 1)}
            >
              <RefreshCw />
              <span>刷新</span>
            </button>
            <button
              type="button"
              className="btn w-icon-btn"
              title="若目标站点限制内嵌 (X-Frame-Options)，可在系统默认浏览器中打开"
              onClick={() => void handleOpenExternal()}
            >
              <ExternalLink />
              <span>外部浏览器打开</span>
            </button>
          </div>
        </div>

        <div className="w-body">
          {webUrl ? (
            <iframe
              key={`${webUrl}-${reloadKey}`}
              className="w-frame"
              src={webUrl}
              title={webTitle}
              referrerPolicy="no-referrer-when-downgrade"
              allow="clipboard-read; clipboard-write; fullscreen"
            />
          ) : (
            <div className="w-empty">
              <p>未指定有效的网页地址。</p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setView("media")}
              >
                返回媒体导航
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export { WebPageView as default };
