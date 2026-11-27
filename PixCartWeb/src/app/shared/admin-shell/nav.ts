/*
 * Port of components/admin-shell/nav.ts.
 * The admin menu, shared by every admin layout (sidebar, top navigation, rail, glass), the quick find palette and the
 * phone menus. The order, sections, labels and links never change between layouts (docs/ADMIN_SPEC.md 2.1): a staff
 * member sees only the items their role allows, with the same badges everywhere.
 */

import {
  BarChart3, Bell, Bike, Bot, ChartColumn, Cpu, FileClock, FileDown, Flag, FolderTree, Globe, IndianRupee, KeyRound, LayoutDashboard, LifeBuoy, LogIn,
  MapPinned, Megaphone, MessageCircleQuestion, MessageSquareText, MessageSquareWarning, MessagesSquare, Package, PackageCheck, Palette,
  PanelsTopLeft, Plug, Radar, Receipt, Rocket, RotateCcw, Route, Settings, ShieldCheck, ShoppingBag, SlidersHorizontal, Sparkles, Store, Tag,
  Truck, Undo2, Users, Wallet, Zap, type LucideIconData,
} from "lucide-angular";

export interface AdminNavItem {
  href: string;
  label: string;
  icon: LucideIconData;
  section: string;
  badge?: number;
  /** active only on this exact path (an overview whose sub-pages have their own items) */
  exact?: boolean;
}

/** Pending-work counts from the dashboard (each feeds a badge). */
export type NavCounts = { s: number; p: number; r: number; rv: number; pr: number; dl: number; ad: number; qa: number; dk: number; dw: number; dc: number };
export const EMPTY_COUNTS: NavCounts = { s: 0, p: 0, r: 0, rv: 0, pr: 0, dl: 0, ad: 0, qa: 0, dk: 0, dw: 0, dc: 0 };

type Def = Omit<AdminNavItem, "badge"> & { p: string; any?: string[]; count?: keyof NavCounts };

const DEFS: Def[] = [
  { section: "Overview", href: "/admin", label: "Overview", icon: LayoutDashboard, p: "dashboard" },
  { section: "Overview", href: "/admin/go-live", label: "Go-live checklist", icon: Rocket, p: "dashboard" },
  { section: "Orders and customers", href: "/admin/orders", label: "Orders", icon: ShoppingBag, p: "orders" },
  { section: "Orders and customers", href: "/admin/returns", label: "Returns", icon: RotateCcw, p: "orders" },
  { section: "Orders and customers", href: "/admin/refunds", label: "Refunds", icon: Undo2, count: "r", p: "refunds" },
  { section: "Orders and customers", href: "/admin/support", label: "Support desk", icon: LifeBuoy, p: "support" },
  { section: "Orders and customers", href: "/admin/customers", label: "Customers and accounts", icon: Users, p: "customers" },
  { section: "Delivery fleet", href: "/admin/delivery", label: "Delivery overview", icon: Truck, p: "delivery", exact: true },
  { section: "Delivery fleet", href: "/admin/delivery/live", label: "Live partners", icon: Radar, p: "delivery" },
  { section: "Delivery fleet", href: "/admin/delivery/queue", label: "Assign deliveries", icon: PackageCheck, count: "dw", p: "delivery" },
  { section: "Delivery fleet", href: "/admin/delivery/trips", label: "Delivery trips", icon: Route, p: "delivery" },
  { section: "Delivery fleet", href: "/admin/delivery/partners", label: "Delivery partners", icon: Bike, count: "dk", p: "delivery" },
  { section: "Delivery fleet", href: "/admin/delivery/payouts", label: "Partner payouts and cash", icon: Wallet, p: "delivery" },
  { section: "Delivery fleet", href: "/admin/delivery/reports", label: "Delivery reports", icon: ChartColumn, p: "delivery" },
  { section: "Delivery fleet", href: "/admin/delivery/feedback", label: "Ratings and complaints", icon: MessageSquareWarning, count: "dc", p: "delivery" },
  { section: "Delivery fleet", href: "/admin/delivery/zones", label: "Delivery zones", icon: MapPinned, p: "delivery" },
  { section: "Delivery fleet", href: "/admin/delivery/settings", label: "Delivery settings", icon: SlidersHorizontal, p: "delivery" },
  { section: "Sellers and catalogue", href: "/admin/sellers", label: "Sellers", icon: Store, count: "s", p: "sellers" },
  { section: "Sellers and catalogue", href: "/admin/products", label: "Listings", icon: Package, count: "p", p: "catalog" },
  { section: "Sellers and catalogue", href: "/admin/categories", label: "Categories", icon: FolderTree, p: "catalog" },
  { section: "Sellers and catalogue", href: "/admin/reviews", label: "Reviews", icon: MessageSquareText, count: "rv", p: "catalog" },
  { section: "Sellers and catalogue", href: "/admin/questions", label: "Questions", icon: MessageCircleQuestion, count: "qa", p: "catalog" },
  { section: "Sellers and catalogue", href: "/admin/product-reports", label: "Product reports", icon: Flag, count: "pr", p: "catalog" },
  { section: "Sellers and catalogue", href: "/admin/growth", label: "Growth", icon: Rocket, p: "marketing" },
  { section: "Money and reports", href: "/admin/payouts", label: "Payouts", icon: IndianRupee, p: "payouts" },
  { section: "Money and reports", href: "/admin/reports", label: "Reports", icon: BarChart3, p: "reports" },
  { section: "Money and reports", href: "/admin/exports", label: "Exports", icon: FileDown, p: "dashboard" },
  { section: "Store and marketing", href: "/admin/storefront", label: "Storefront", icon: Palette, p: "marketing" },
  { section: "Store and marketing", href: "/admin/product-page", label: "Product page", icon: PanelsTopLeft, p: "settings" },
  { section: "Store and marketing", href: "/admin/checkout", label: "Checkout and fees", icon: Receipt, p: "settings" },
  { section: "Store and marketing", href: "/admin/coupons", label: "Coupons", icon: Tag, p: "marketing" },
  { section: "Store and marketing", href: "/admin/deals", label: "Deals", icon: Zap, count: "dl", p: "catalog" },
  { section: "Store and marketing", href: "/admin/advertising", label: "Advertising", icon: Megaphone, count: "ad", p: "marketing" },
  { section: "Store and marketing", href: "/admin/notifications", label: "Messages", icon: Bell, p: "marketing" },
  { section: "AI", href: "/admin/shop-assistant", label: "Shop assistant", icon: MessagesSquare, p: "shop_assistant", any: ["shop_assistant", "shop_assistant_kb", "shop_assistant_chats"] },
  { section: "AI", href: "/admin/assistant", label: "AI assistant", icon: Bot, p: "settings" },
  { section: "AI", href: "/admin/ai", label: "AI studio", icon: Sparkles, p: "settings" },
  { section: "AI", href: "/admin/ai-providers", label: "AI providers", icon: Cpu, p: "ai_providers" },
  { section: "Administration", href: "/admin/settings", label: "Marketplace settings", icon: Settings, p: "settings" },
  { section: "Administration", href: "/admin/regional", label: "Languages and currencies", icon: Globe, p: "settings" },
  { section: "Administration", href: "/admin/sign-in", label: "Sign-in and accounts", icon: LogIn, p: "settings" },
  { section: "Administration", href: "/admin/integrations", label: "Integrations", icon: Plug, p: "integrations" },
  { section: "Administration", href: "/admin/staff", label: "Staff and roles", icon: ShieldCheck, p: "staff" },
  { section: "Administration", href: "/admin/audit", label: "Audit log", icon: FileClock, p: "audit" },
  { section: "Administration", href: "/admin/account", label: "My account", icon: KeyRound, p: "dashboard" },
];

/** The menu for a staff member: the items their permissions allow, with their badges. */
export function adminNav(permissions: string[], counts: NavCounts): AdminNavItem[] {
  const can = (p: string) => permissions.includes(p);
  return DEFS.filter((d) => (d.any ? d.any.some(can) : can(d.p))).map((d) => ({
    href: d.href, label: d.label, icon: d.icon, section: d.section, exact: d.exact, badge: d.count ? counts[d.count] : undefined,
  }));
}

export interface NavSection {
  name: string;
  items: AdminNavItem[];
  /** pending work in the section (shown on a folded group) */
  badge: number;
}

export function navSections(items: AdminNavItem[]): NavSection[] {
  const out: NavSection[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && last.name === it.section) last.items.push(it);
    else out.push({ name: it.section, items: [it], badge: 0 });
  }
  for (const s of out) s.badge = s.items.reduce((n, i) => n + (i.badge ?? 0), 0);
  return out;
}

/** Whether a menu item is the current page (the overview only on its own path; others for their sub-pages too). */
export function isActiveItem(pathname: string, item: AdminNavItem): boolean {
  if (item.href === "/admin" || item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** The current page's menu item (the longest matching link), for titles and breadcrumbs. */
export function currentItem(pathname: string, items: AdminNavItem[]): AdminNavItem | null {
  return items.filter((i) => isActiveItem(pathname, i)).sort((a, b) => b.href.length - a.href.length)[0] ?? null;
}
