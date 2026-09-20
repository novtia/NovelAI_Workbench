import { accountLabel } from "@/data";
import { openStudioPop, pushToast, useStudio } from "@/state";
import { IconBolt, IconBrand, IconMenu, IconPlus } from "./icons";

export function StudioHeader() {
  const { status, clearSession } = useStudio();
  return (
    <header className="left-head">
      <span className="brand" title="生图室">
        <IconBrand />
      </span>
      <div className="account-wrap">
        <button
          className="account"
          id="st-account"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            openStudioPop("token", e.currentTarget);
          }}
        >
          <span>{accountLabel(status)}</span>
          <IconBolt />
          <svg className="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <button
          className="head-plus"
          type="button"
          title="新会话"
          onClick={() => {
            clearSession();
            pushToast("已清空本次预览", "ok");
          }}
        >
          <IconPlus />
        </button>
      </div>
      <button
        className="icon-ghost"
        id="st-menu"
        type="button"
        title="Token 与账号"
        onClick={(e) => {
          e.stopPropagation();
          openStudioPop("token", e.currentTarget);
        }}
      >
        <IconMenu />
      </button>
    </header>
  );
}
