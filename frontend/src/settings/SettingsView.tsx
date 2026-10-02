import { useMemo, useState } from "react";
import { DEFAULT_SETTINGS, type SectionId } from "@/data/settings";
import { confirmDialog } from "@/state/confirm";
import { useSettingsStore } from "@/state/settingsStore";
import { pushToast } from "@/state/toast";
import { SECTIONS, allItems, findSection, matchesQuery } from "./catalog";
import { Card, SettingRow } from "./controls";
import { LotteryApplyPanel, SystemPanel, TokenPanel } from "./panels";

export function SettingsView() {
  const [active, setActive] = useState<SectionId>("appearance");
  const [query, setQuery] = useState("");
  const reset = useSettingsStore((s) => s.reset);
  const settings = useSettingsStore((s) => s.settings);
  const ready = useSettingsStore((s) => s.ready);

  const q = query.trim();
  const section = findSection(active);

  const results = useMemo(() => (q ? allItems().filter((e) => matchesQuery(e, q)) : []), [q]);
  const grouped = useMemo(() => {
    const map = new Map<string, typeof results>();
    for (const r of results) {
      const list = map.get(r.section.id) || [];
      list.push(r);
      map.set(r.section.id, list);
    }
    return [...map.entries()];
  }, [results]);

  const changedCount = (id: SectionId) => {
    const cur = settings[id] as Record<string, unknown>;
    const def = defaultsOf(id);
    return Object.keys(def).filter((k) => cur[k] !== def[k]).length;
  };

  const resetSection = async (id: SectionId) => {
    const title = findSection(id).title;
    if (!(await confirmDialog(`把「${title}」的所有选项恢复为默认值？`, { title: "恢复默认", confirmText: "恢复" }))) return;
    void reset(id).then(() => pushToast(`「${title}」已恢复默认`));
  };

  return (
    <section className="view active s-view" id="view-settings">
      <aside className="s-side">
        <div className="s-side-head">
          <span className="pane-no">設</span>
          <h2 className="pane-title">设置</h2>
        </div>
        <input
          className="search s-search"
          type="search"
          placeholder="搜索设置项…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
        />
        <nav className="s-nav" aria-label="设置分类">
          {SECTIONS.map((s) => {
            const n = changedCount(s.id);
            return (
              <button
                key={s.id}
                type="button"
                className={`s-nav-item${!q && active === s.id ? " active" : ""}`}
                onClick={() => {
                  setActive(s.id);
                  setQuery("");
                }}
              >
                <span className="s-nav-glyph">{s.glyph}</span>
                <span className="s-nav-title">{s.title}</span>
                {n ? <span className="s-nav-n" title={`${n} 项已修改`}>{n}</span> : null}
              </button>
            );
          })}
        </nav>
        <div className="s-side-foot">
          {ready ? "修改即时生效，并自动保存到本机服务。" : "正在读取已保存的设置…"}
        </div>
      </aside>

      <div className="s-main">
        {q ? (
          <>
            <header className="s-head">
              <div>
                <h2 className="s-title">搜索结果</h2>
                <p className="s-desc">
                  「{q}」共 {results.length} 项
                </p>
              </div>
            </header>
            <div className="s-scroll">
              {grouped.length === 0 ? <div className="g-nomatch">没有匹配的设置项</div> : null}
              {grouped.map(([id, list]) => (
                <Card key={id} title={findSection(id as SectionId).title}>
                  {list.map((r) => (
                    <SettingRow key={`${r.item.section}.${r.item.key}`} item={r.item} />
                  ))}
                </Card>
              ))}
            </div>
          </>
        ) : (
          <>
            <header className="s-head">
              <div>
                <h2 className="s-title">{section.title}</h2>
                <p className="s-desc">{section.desc}</p>
              </div>
              <button type="button" className="btn" onClick={() => resetSection(section.id)} disabled={!changedCount(section.id)}>
                恢复本分类默认
              </button>
            </header>
            <div className="s-scroll" key={section.id}>
              {section.groups.map((g) => (
                <Card key={g.title} title={g.title}>
                  {g.custom === "token" ? <TokenPanel /> : null}
                  {g.items.map((item) => (
                    <SettingRow key={`${item.section}.${item.key}`} item={item} />
                  ))}
                  {g.custom === "lotteryApply" ? <LotteryApplyPanel /> : null}
                </Card>
              ))}
              {section.extra === "system" ? <SystemPanel /> : null}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function defaultsOf(id: SectionId): Record<string, unknown> {
  return DEFAULT_SETTINGS[id] as Record<string, unknown>;
}

export default SettingsView;
