"use client";

import {
  BarChart3, Bell, Bot, Cpu, LogIn, MessagesSquare, Rocket, FileDown, FileClock, FolderTree, IndianRupee, KeyRound, LayoutDashboard, LifeBuoy, MessageSquareText, Package, Palette, Plug, Settings,
  ShieldCheck, ShoppingBag, Sparkles, Store, Tag, Undo2, Users, RotateCcw, Flag, PanelsTopLeft, Zap, Megaphone, MessageCircleQuestion,
  Truck, Bike, MapPinned, SlidersHorizontal,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AssistantDock } from "@/components/assistant/dock";
import { PortalShell } from "@/components/portal-shell";
import { PageLoader } from "@/components/ui";
import { AdminCtx, type AdminMe } from "@/lib/admin";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, ready } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const isLogin = pathname === "/admin/login";
  const [me, setMe] = useState<AdminMe | null>(null);
  const [counts, setCounts] = useState({ s: 0, p: 0, r: 0, rv: 0, pr: 0, dl: 0, ad: 0, qa: 0, dk: 0 });

  useEffect(() => {
    if (!ready || isLogin) return;
    if (!user || !user.is_admin) router.replace("/admin/login");
  }, [ready, user, isLogin, router]);

  useEffect(() => {
    if (user?.is_admin && !isLogin) api<AdminMe>("/api/admin/me").then(setMe).catch(() => {});
  }, [user, isLogin]);

  useEffect(() => {
    if (user?.is_admin && !isLogin && me?.permissions.includes("dashboard"))
      api<{
        sellers_pending_review: number; products_pending_review: number; refunds_needing_attention: number; reviews_needing_attention?: number;
        product_reports_open?: number; deals_pending?: number; ads_pending?: number; questions_pending?: number; delivery_kyc_pending?: number;
      }>("/api/admin/dashboard")
        .then((d) => setCounts({
          s: d.sellers_pending_review, p: d.products_pending_review, r: d.refunds_needing_attention, rv: d.reviews_needing_attention ?? 0,
          pr: d.product_reports_open ?? 0, dl: d.deals_pending ?? 0, ad: d.ads_pending ?? 0, qa: d.questions_pending ?? 0,
          dk: d.delivery_kyc_pending ?? 0,
        }))
        .catch(() => {});
  }, [user, isLogin, pathname, me]);

  if (isLogin) return <>{children}</>;
  if (!ready || !user?.is_admin || !me) return <PageLoader />;
  const can = (p: string) => me.permissions.includes(p);
  const nav = [
    { section: "Overview", href: "/admin", label: "Overview", icon: LayoutDashboard, p: "dashboard" },
    { section: "Overview", href: "/admin/go-live", label: "Go-live checklist", icon: Rocket, p: "dashboard" },
    { section: "Orders and customers", href: "/admin/orders", label: "Orders", icon: ShoppingBag, p: "orders" },
    { section: "Orders and customers", href: "/admin/returns", label: "Returns", icon: RotateCcw, p: "orders" },
    { section: "Orders and customers", href: "/admin/refunds", label: "Refunds", icon: Undo2, badge: counts.r, p: "refunds" },
    { section: "Orders and customers", href: "/admin/support", label: "Support desk", icon: LifeBuoy, p: "support" },
    { section: "Orders and customers", href: "/admin/customers", label: "Customers and accounts", icon: Users, p: "customers" },
    { section: "Delivery fleet", href: "/admin/delivery", label: "Delivery overview", icon: Truck, p: "delivery", exact: true },
    { section: "Delivery fleet", href: "/admin/delivery/partners", label: "Delivery partners", icon: Bike, badge: counts.dk, p: "delivery" },
    { section: "Delivery fleet", href: "/admin/delivery/zones", label: "Delivery zones", icon: MapPinned, p: "delivery" },
    { section: "Delivery fleet", href: "/admin/delivery/settings", label: "Delivery settings", icon: SlidersHorizontal, p: "delivery" },
    { section: "Sellers and catalogue", href: "/admin/sellers", label: "Sellers", icon: Store, badge: counts.s, p: "sellers" },
    { section: "Sellers and catalogue", href: "/admin/products", label: "Listings", icon: Package, badge: counts.p, p: "catalog" },
    { section: "Sellers and catalogue", href: "/admin/categories", label: "Categories", icon: FolderTree, p: "catalog" },
    { section: "Sellers and catalogue", href: "/admin/reviews", label: "Reviews", icon: MessageSquareText, badge: counts.rv, p: "catalog" },
    { section: "Sellers and catalogue", href: "/admin/questions", label: "Questions", icon: MessageCircleQuestion, badge: counts.qa, p: "catalog" },
    { section: "Sellers and catalogue", href: "/admin/product-reports", label: "Product reports", icon: Flag, badge: counts.pr, p: "catalog" },
    { section: "Money and reports", href: "/admin/payouts", label: "Payouts", icon: IndianRupee, p: "payouts" },
    { section: "Money and reports", href: "/admin/reports", label: "Reports", icon: BarChart3, p: "reports" },
    { section: "Money and reports", href: "/admin/exports", label: "Exports", icon: FileDown, p: "dashboard" },
    { section: "Store and marketing", href: "/admin/storefront", label: "Storefront", icon: Palette, p: "marketing" },
    { section: "Store and marketing", href: "/admin/product-page", label: "Product page", icon: PanelsTopLeft, p: "settings" },
    { section: "Store and marketing", href: "/admin/coupons", label: "Coupons", icon: Tag, p: "marketing" },
    { section: "Store and marketing", href: "/admin/deals", label: "Deals", icon: Zap, badge: counts.dl, p: "catalog" },
    { section: "Store and marketing", href: "/admin/advertising", label: "Advertising", icon: Megaphone, badge: counts.ad, p: "marketing" },
    { section: "Store and marketing", href: "/admin/notifications", label: "Messages", icon: Bell, p: "marketing" },
    { section: "AI", href: "/admin/shop-assistant", label: "Shop assistant", icon: MessagesSquare, p: "shop_assistant", any: ["shop_assistant", "shop_assistant_kb", "shop_assistant_chats"] },
    { section: "AI", href: "/admin/assistant", label: "AI assistant", icon: Bot, p: "settings" },
    { section: "AI", href: "/admin/ai", label: "AI studio", icon: Sparkles, p: "settings" },
    { section: "AI", href: "/admin/ai-providers", label: "AI providers", icon: Cpu, p: "ai_providers" },
    { section: "Administration", href: "/admin/settings", label: "Marketplace settings", icon: Settings, p: "settings" },
    { section: "Administration", href: "/admin/sign-in", label: "Sign-in and accounts", icon: LogIn, p: "settings" },
    { section: "Administration", href: "/admin/integrations", label: "Integrations", icon: Plug, p: "integrations" },
    { section: "Administration", href: "/admin/staff", label: "Staff and roles", icon: ShieldCheck, p: "staff" },
    { section: "Administration", href: "/admin/audit", label: "Audit log", icon: FileClock, p: "audit" },
    { section: "Administration", href: "/admin/account", label: "My account", icon: KeyRound, p: "dashboard" },
  ].filter((n) => ("any" in n && Array.isArray(n.any) ? n.any.some(can) : can(n.p)));
  return (
    <AdminCtx.Provider value={me}>
      <PortalShell title={`Admin, ${me.role_label}`} root="/admin" nav={nav}>
        {children}
      </PortalShell>
      {can("assistant") && <AssistantDock />}
    </AdminCtx.Provider>
  );
}
