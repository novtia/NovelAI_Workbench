import {
  Brush,
  Database,
  FlaskConical,
  History,
  Images,
  LayoutDashboard,
  Moon,
  Palette,
  Settings,
  ShoppingBasket,
  Sun,
  Ticket,
  WalletCards,
  type LucideIcon,
} from "lucide-react";

/** 导航用图标统一从这里取（lucide-react），替换原先的书法单字。 */
export const NAV_ICONS = {
  /** 图库 */
  gallery: Images,
  /** 抽奖 */
  lottery: Ticket,
  /** 生图 */
  studio: Brush,
  /** 历史记录 */
  history: History,
  /** 画师串 */
  basket: ShoppingBasket,
  /** 设置 */
  settings: Settings,
  /** 主题切换：当前浅色时显示月亮（点击进深色），深色时显示太阳 */
  themeToDark: Moon,
  themeToLight: Sun,
  /** 设置分区：外观 */
  appearance: Palette,
  /** 设置分区：画师测试 */
  artistTest: FlaskConical,
  /** 设置分区：布局 */
  layout: LayoutDashboard,
  /** 设置分区：账号与额度 */
  account: WalletCards,
  /** 设置分区：数据与系统 */
  system: Database,
} satisfies Record<string, LucideIcon>;

export type NavIconId = keyof typeof NAV_ICONS;
