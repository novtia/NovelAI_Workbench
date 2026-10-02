import { MODEL_LABEL, MODE_LABEL, PRESET_LABEL, QUALITY_LABEL, SAMPLER_LABEL } from "@/data/studio";
import type { SectionId, Settings } from "@/data/settings";

export type Option = { value: string | number | boolean; label: string };

export type Control =
  | { kind: "switch" }
  | { kind: "segmented"; options: Option[] }
  | { kind: "select"; options: Option[] }
  | { kind: "slider"; min: number; max: number; step: number; unit?: string; digits?: number };

export type SettingItem = {
  section: SectionId;
  key: string;
  label: string;
  hint?: string;
  /** 搜索用的额外关键词 */
  keywords?: string;
  control: Control;
  /** 依赖别的设置时置灰 */
  disabledWhen?: (s: Settings) => boolean;
  /** 需要重启/刷新页面才完全生效的说明 */
  note?: string;
};

export type SettingGroup = { title: string; items: SettingItem[]; custom?: "token" | "lotteryApply" };

export type SectionMeta = {
  id: SectionId;
  title: string;
  glyph: string;
  desc: string;
  groups: SettingGroup[];
  /** 该分区末尾附加的自定义面板 */
  extra?: "system";
};

const opts = (map: Record<string, string>): Option[] => Object.entries(map).map(([value, label]) => ({ value, label }));

export const SECTIONS: SectionMeta[] = [
  {
    id: "appearance",
    title: "外观",
    glyph: "色",
    desc: "主题、字体、动效与提示时长。",
    groups: [
      {
        title: "主题与字体",
        items: [
          {
            section: "appearance",
            key: "theme",
            label: "主题",
            hint: "深色为整页滤镜反相实现，图片保持原色；浏览器较老时可能略耗显卡。",
            keywords: "dark light 暗色 深色 夜间 浅色 跟随系统",
            control: {
              kind: "segmented",
              options: [
                { value: "light", label: "宣纸" },
                { value: "dark", label: "墨夜" },
                { value: "auto", label: "跟随系统" },
              ],
            },
          },
          {
            section: "appearance",
            key: "font",
            label: "界面字体",
            hint: "宋体更有书卷气，黑体在小字号下更清晰。",
            keywords: "font 字体 宋体 黑体",
            control: {
              kind: "segmented",
              options: [
                { value: "serif", label: "宋体" },
                { value: "sans", label: "黑体" },
              ],
            },
          },
          {
            section: "appearance",
            key: "sidebarLabels",
            label: "侧栏显示文字标签",
            hint: "关闭后侧栏只剩汉字图标，更紧凑。",
            keywords: "导航 侧边栏",
            control: { kind: "switch" },
          },
        ],
      },
      {
        title: "背景与动效",
        items: [
          {
            section: "appearance",
            key: "liveInk",
            label: "活墨背景（WebGL）",
            hint: "流动的水墨背景，鼠标划过会推开墨晕。低配显卡建议关闭。",
            keywords: "背景 水墨 性能 webgl",
            disabledWhen: (s) => s.appearance.reduceMotion,
            control: { kind: "switch" },
          },
          {
            section: "appearance",
            key: "grain",
            label: "纸纹颗粒",
            hint: "覆盖全屏的宣纸纤维颗粒。",
            keywords: "纸张 噪点",
            control: { kind: "switch" },
          },
          {
            section: "appearance",
            key: "reduceMotion",
            label: "减少动效",
            hint: "关闭过渡动画与活墨背景，适合晕动症或想省电的场景。",
            keywords: "动画 无障碍 animation",
            control: { kind: "switch" },
          },
        ],
      },
      {
        title: "提示",
        items: [
          {
            section: "appearance",
            key: "toastMs",
            label: "提示停留时长",
            hint: "屏幕下方的操作提示自动消失的时间。",
            keywords: "toast 通知 消息",
            control: { kind: "slider", min: 1500, max: 10000, step: 500, unit: "ms" },
          },
        ],
      },
    ],
  },
  {
    id: "gallery",
    title: "图库",
    glyph: "藏",
    desc: "卡片密度、排序分页、缩略图与删除确认。",
    groups: [
      {
        title: "显示",
        items: [
          {
            section: "gallery",
            key: "density",
            label: "卡片密度",
            hint: "与图库工具栏里的「紧凑/舒适」按钮同步。",
            keywords: "紧凑 舒适 网格",
            control: {
              kind: "segmented",
              options: [
                { value: "comfortable", label: "舒适" },
                { value: "compact", label: "紧凑" },
              ],
            },
          },
          {
            section: "gallery",
            key: "cardMinWidth",
            label: "卡片最小宽度",
            hint: "舒适模式下每张卡片的最小宽度，紧凑模式按比例缩小。",
            keywords: "网格 列数 大小",
            control: { kind: "slider", min: 150, max: 400, step: 10, unit: "px" },
          },
          {
            section: "gallery",
            key: "showArtists",
            label: "卡片上显示画师名",
            keywords: "artist 标签",
            control: { kind: "switch" },
          },
          {
            section: "gallery",
            key: "hoverPreview",
            label: "悬停画师名预览代表作",
            hint: "鼠标停在画师名上时弹出代表作预览。",
            keywords: "hover 悬浮",
            control: { kind: "switch" },
          },
        ],
      },
      {
        title: "排序与加载",
        items: [
          {
            section: "gallery",
            key: "sort",
            label: "排序方式",
            keywords: "顺序 时间 新旧",
            control: {
              kind: "segmented",
              options: [
                { value: "added_desc", label: "最新在前" },
                { value: "added_asc", label: "最早在前" },
              ],
            },
          },
          {
            section: "gallery",
            key: "pageSize",
            label: "每页加载数量",
            hint: "普通收藏夹图很多时分批渲染卡片，滚动到底自动继续；「全部」一次渲染完。单画师收藏夹始终完整显示。",
            keywords: "分页 分批 性能 懒加载",
            control: {
              kind: "select",
              options: [
                { value: 0, label: "全部" },
                { value: 100, label: "每批 100 张" },
                { value: 200, label: "每批 200 张" },
                { value: 500, label: "每批 500 张" },
              ],
            },
          },
          {
            section: "gallery",
            key: "startAlbum",
            label: "启动时打开的收藏夹",
            control: {
              kind: "segmented",
              options: [
                { value: "last", label: "上次浏览的" },
                { value: "default", label: "默认收藏夹" },
              ],
            },
          },
        ],
      },
      {
        title: "缩略图与安全",
        items: [
          {
            section: "gallery",
            key: "thumbSize",
            label: "缩略图最大边",
            hint: "只影响之后导入/生成的图；已有缩略图不会重做。",
            keywords: "thumb 画质 体积",
            control: { kind: "slider", min: 200, max: 800, step: 20, unit: "px" },
          },
          {
            section: "gallery",
            key: "thumbQuality",
            label: "缩略图 WEBP 质量",
            hint: "数值越高越清晰、占用越大。只影响之后新生成的缩略图。",
            control: { kind: "slider", min: 40, max: 95, step: 1 },
          },
          {
            section: "gallery",
            key: "confirmDelete",
            label: "清空/删除收藏夹前确认",
            hint: "关闭后，清空收藏夹和删除收藏夹会直接执行，不再弹确认。",
            keywords: "误删 二次确认",
            control: { kind: "switch" },
          },
        ],
      },
    ],
  },
  {
    id: "generation",
    title: "生图",
    glyph: "绘",
    desc: "新建生图表单的默认值、草稿、后台队列与预览。",
    groups: [
      {
        title: "默认参数（用于新表单与「重置」）",
        items: [
          {
            section: "generation",
            key: "model",
            label: "默认模型",
            control: { kind: "segmented", options: opts(MODEL_LABEL) },
          },
          {
            section: "generation",
            key: "v5Mode",
            label: "V5 模式",
            control: { kind: "segmented", options: opts(MODE_LABEL) },
          },
          {
            section: "generation",
            key: "quality",
            label: "质量词",
            control: { kind: "segmented", options: opts(QUALITY_LABEL) },
          },
          {
            section: "generation",
            key: "preset",
            label: "分辨率档位",
            control: { kind: "segmented", options: opts(PRESET_LABEL) },
          },
          {
            section: "generation",
            key: "aspect",
            label: "画幅",
            control: {
              kind: "segmented",
              options: [
                { value: "port", label: "竖" },
                { value: "land", label: "横" },
                { value: "square", label: "方" },
              ],
            },
          },
          {
            section: "generation",
            key: "sampler",
            label: "采样器",
            control: { kind: "select", options: opts(SAMPLER_LABEL) },
          },
          {
            section: "generation",
            key: "noiseSchedule",
            label: "噪声计划",
            control: {
              kind: "select",
              options: ["karras", "native", "exponential", "polyexponential"].map((v) => ({ value: v, label: v })),
            },
          },
          {
            section: "generation",
            key: "steps",
            label: "步数",
            control: { kind: "slider", min: 1, max: 50, step: 1 },
          },
          {
            section: "generation",
            key: "scale",
            label: "提示词相关性（CFG）",
            keywords: "scale guidance",
            control: { kind: "slider", min: 0, max: 30, step: 0.5, digits: 1 },
          },
          {
            section: "generation",
            key: "cfgRescale",
            label: "CFG Rescale",
            control: { kind: "slider", min: 0, max: 1, step: 0.05, digits: 2 },
          },
          {
            section: "generation",
            key: "nSamples",
            label: "每次张数",
            control: { kind: "slider", min: 1, max: 4, step: 1 },
          },
          {
            section: "generation",
            key: "ucPreset",
            label: "默认负向提示",
            hint: "新表单里负向提示词的初始内容。",
            keywords: "uc negative",
            control: {
              kind: "segmented",
              options: [
                { value: "heavy", label: "重度" },
                { value: "comic", label: "漫画" },
                { value: "none", label: "留空" },
              ],
            },
          },
        ],
      },
      {
        title: "草稿",
        items: [
          {
            section: "generation",
            key: "draftSave",
            label: "自动保存草稿",
            hint: "刷新页面后恢复上次的 Prompt 与参数。",
            control: { kind: "switch" },
          },
          {
            section: "generation",
            key: "draftDebounceMs",
            label: "草稿保存间隔",
            hint: "停止编辑参数多久后写入草稿。",
            disabledWhen: (s) => !s.generation.draftSave,
            control: { kind: "slider", min: 300, max: 5000, step: 100, unit: "ms" },
          },
        ],
      },
      {
        title: "后台队列",
        items: [
          {
            section: "generation",
            key: "concurrency",
            label: "同时生成任务数",
            hint: "默认 1 最稳；调高更快，但 NovelAI 可能因并发限流返回错误。立即生效。",
            keywords: "并发 队列 速度",
            control: { kind: "slider", min: 1, max: 3, step: 1 },
          },
          {
            section: "generation",
            key: "timeoutSec",
            label: "单次请求超时",
            hint: "超过这个时间还没出图就判定失败。",
            control: { kind: "slider", min: 30, max: 600, step: 10, unit: "秒" },
          },
          {
            section: "generation",
            key: "jobsKeep",
            label: "保留最近任务条数",
            hint: "后台任务列表里除进行中的任务外，最多保留的历史条数。",
            control: { kind: "slider", min: 20, max: 500, step: 10, unit: "条" },
          },
          {
            section: "generation",
            key: "autoOpenJobs",
            label: "有新任务时自动展开后台面板",
            keywords: "jobs dock",
            control: { kind: "switch" },
          },
          {
            section: "generation",
            key: "streamPreview",
            label: "生成过程中显示流式预览",
            hint: "关闭可省一点磁盘与带宽，只在出图后显示结果。立即生效。",
            control: { kind: "switch" },
          },
          {
            section: "generation",
            key: "tokenWarn",
            label: "Prompt 超出 Token 上限时提醒",
            keywords: "1471",
            control: { kind: "switch" },
          },
        ],
      },
    ],
  },
  {
    id: "lottery",
    title: "抽奖",
    glyph: "签",
    desc: "抽奖台的默认参数与删除确认。",
    groups: [
      {
        title: "默认参数（用于「重置」与新建的抽奖台）",
        items: [
          { section: "lottery", key: "min", label: "画师数 min", hint: "每条至少包含的画师数。", control: { kind: "slider", min: 1, max: 50, step: 1 } },
          { section: "lottery", key: "max", label: "画师数 max", hint: "每条至多包含的画师数。", control: { kind: "slider", min: 1, max: 50, step: 1 } },
          { section: "lottery", key: "draws", label: "条数", hint: "每批抽取的条数。", control: { kind: "slider", min: 1, max: 50, step: 1 } },
          { section: "lottery", key: "target", label: "目标和", hint: "每条权重之和的目标值。", control: { kind: "slider", min: 0.1, max: 20, step: 0.1, digits: 1 } },
          { section: "lottery", key: "wmin", label: "最小权重", control: { kind: "slider", min: 0.01, max: 5, step: 0.01, digits: 2 } },
          { section: "lottery", key: "wmax", label: "最大权重", control: { kind: "slider", min: 0.01, max: 5, step: 0.01, digits: 2 } },
          { section: "lottery", key: "jitter", label: "权重抖动", control: { kind: "slider", min: 0, max: 1, step: 0.05, digits: 2 } },
          { section: "lottery", key: "boost", label: "置顶加成", control: { kind: "slider", min: 0, max: 1, step: 0.05, digits: 2 } },
        ],
        custom: "lotteryApply",
      },
      {
        title: "安全",
        items: [
          {
            section: "lottery",
            key: "confirmDelete",
            label: "删除批次前确认",
            control: { kind: "switch" },
          },
        ],
      },
    ],
  },
  {
    id: "basket",
    title: "画师串",
    glyph: "串",
    desc: "复制格式与面板行为。",
    groups: [
      {
        title: "复制格式",
        items: [
          {
            section: "basket",
            key: "separator",
            label: "画师之间的分隔",
            keywords: "逗号 换行 空格 复制",
            control: {
              kind: "segmented",
              options: [
                { value: "comma", label: "逗号" },
                { value: "newline", label: "换行" },
                { value: "space", label: "空格" },
              ],
            },
          },
          {
            section: "basket",
            key: "underscoreToSpace",
            label: "下划线转空格",
            hint: "复制时把 artist:a_b 写成 artist:a b。",
            control: { kind: "switch" },
          },
          {
            section: "basket",
            key: "escapeParens",
            label: "转义括号",
            hint: "复制时把 ( ) 写成 \\( \\)，避免被 Prompt 当作强调语法。",
            control: { kind: "switch" },
          },
        ],
      },
      {
        title: "面板",
        items: [
          {
            section: "basket",
            key: "autoOpen",
            label: "加入画师后自动展开画师串",
            control: { kind: "switch" },
          },
        ],
      },
    ],
  },
  {
    id: "layout",
    title: "布局",
    glyph: "局",
    desc: "生图室面板宽度。",
    groups: [
      {
        title: "生图室面板",
        items: [
          {
            section: "layout",
            key: "rememberWidths",
            label: "记住拖动后的面板宽度",
            hint: "关闭则每次刷新都回到下面的宽度。",
            control: { kind: "switch" },
          },
          {
            section: "layout",
            key: "leftWidth",
            label: "参数栏宽度",
            keywords: "左栏 面板 拖动",
            control: { kind: "slider", min: 300, max: 640, step: 4, unit: "px" },
          },
          {
            section: "layout",
            key: "histWidth",
            label: "历史栏宽度",
            control: { kind: "slider", min: 108, max: 480, step: 4, unit: "px" },
          },
        ],
      },
    ],
  },
  {
    id: "account",
    title: "账号与额度",
    glyph: "账",
    desc: "NovelAI Token 与额度显示。",
    groups: [
      { title: "NovelAI Token", items: [], custom: "token" },
      {
        title: "额度",
        items: [
          {
            section: "account",
            key: "showBattery",
            label: "侧栏显示 Opus 额度电池",
            control: { kind: "switch" },
          },
          {
            section: "account",
            key: "quotaRefreshSec",
            label: "额度自动刷新间隔",
            keywords: "anlas opus",
            control: { kind: "slider", min: 15, max: 600, step: 5, unit: "秒" },
          },
          {
            section: "account",
            key: "statusTtlSec",
            label: "服务端额度缓存时间",
            hint: "后端对 NovelAI 额度查询的缓存，避免频繁请求。立即生效。",
            control: { kind: "slider", min: 10, max: 300, step: 5, unit: "秒" },
          },
        ],
      },
    ],
  },
  {
    id: "system",
    title: "数据与系统",
    glyph: "库",
    desc: "存储信息、完整性、备份、导入导出设置。",
    extra: "system",
    groups: [
      {
        title: "高级",
        items: [
          {
            section: "system",
            key: "importConcurrency",
            label: "导入图片并发数",
            hint: "同时解析/上传的图片数，机器弱时调低。",
            keywords: "导入 上传 性能",
            control: { kind: "slider", min: 1, max: 6, step: 1 },
          },
          {
            section: "system",
            key: "ssePingSec",
            label: "后台任务推送心跳",
            hint: "任务事件流的空闲心跳间隔，反向代理会断长连接时调小。立即生效（新连接）。",
            control: { kind: "slider", min: 5, max: 60, step: 1, unit: "秒" },
          },
        ],
      },
    ],
  },
];

export function findSection(id: SectionId) {
  return SECTIONS.find((s) => s.id === id) as SectionMeta;
}

export function allItems(): Array<{ item: SettingItem; section: SectionMeta; group: SettingGroup }> {
  const out: Array<{ item: SettingItem; section: SectionMeta; group: SettingGroup }> = [];
  for (const section of SECTIONS) {
    for (const group of section.groups) {
      for (const item of group.items) out.push({ item, section, group });
    }
  }
  return out;
}

export function matchesQuery(entry: { item: SettingItem; section: SectionMeta; group: SettingGroup }, q: string) {
  const text = `${entry.item.label} ${entry.item.hint || ""} ${entry.item.keywords || ""} ${entry.section.title} ${entry.group.title}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => text.includes(part));
}
