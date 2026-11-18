"use client";

import {
  BarChart3, Bell, Bot, Cpu, MessagesSquare, Rocket, FileDown, FileClock, FolderTree, IndianRupee, KeyRound, LayoutDashboard, LifeBuoy, MessageSquareText, Package, Palette, Plug, Settings,
  ShieldCheck, ShoppingBag, Sparkles, Store, Tag, Undo2, Users, RotateCcw,
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
  const [counts, setCounts] = useState<{ s: number; p: number; r: number }>({ s: 0, p: 0, r: 0 });

  useEffect(() => {
    if (!ready || isLogin) return;
    if (!user || !user.is_admin) router.replace("/admin/login");
  }, [ready, user, isLogin, router]);

  useEffect(() => {
    if (user?.is_admin && !isLogin) api<AdminMe>("/api/admin/me").then(setMe).catch(() => {});
  }, [user, isLogin]);

  useEffect(() => {
    if (user?.is_admin && !isLogin && me?.permissions.includes("sellers"))
      api<{ sellers_pending_review: number; products_pending_review: number; refunds_needing_attention: number }>("/api/admin/dashboard")
        .then((d) => setCounts({ s: d.sellers_pending_review, p: d.products_pending_review, r: d.refunds_needing_attention }))
        .catch(() => {});
  }, [user, isLogin, pathname, me]);

  if (isLogin) return <>{children}</>;
  if (!ready || !user?.is_admin || !me) return <PageLoader />;
  const can = (p: string) => me.permissions.includes(p);
  const nav = [
    { href: "/admin", label: "Overview", icon: LayoutDashboard, p: "dashboard" },
    { href: "/admin/sellers", label: "Sellers", icon: Store, badge: counts.s, p: "sellers" },
    { href: "/admin/products", label: "Listings", icon: Package, badge: counts.p, p: "catalog" },
    { href: "/admin/orders", label: "Orders", icon: ShoppingBag, p: "orders" },
    { href: "/admin/returns", label: "Returns", icon: RotateCcw, p: "orders" },
    { href: "/admin/refunds", label: "Refunds", icon: Undo2, badge: counts.r, p: "refunds" },
    { href: "/admin/payouts", label: "Payouts", icon: IndianRupee, p: "payouts" },
    { href: "/admin/support", label: "Support desk", icon: LifeBuoy, p: "support" },
    { href: "/admin/customers", label: "Customers", icon: Users, p: "customers" },
    { href: "/admin/categories", label: "Categories", icon: FolderTree, p: "catalog" },
    { href: "/admin/reviews", label: "Reviews", icon: MessageSquareText, p: "catalog" },
    { href: "/admin/storefront", label: "Storefront", icon: Palette, p: "marketing" },
    { href: "/admin/coupons", label: "Coupons", icon: Tag, p: "marketing" },
    { href: "/admin/notifications", label: "Messages", icon: Bell, p: "marketing" },
    { href: "/admin/reports", label: "Reports", icon: BarChart3, p: "reports" },
    { href: "/admin/exports", label: "Exports", icon: FileDown, p: "dashboard" },
    { href: "/admin/settings", label: "Settings", icon: Settings, p: "settings" },
    { href: "/admin/ai", label: "AI studio", icon: Sparkles, p: "settings" },
    { href: "/admin/assistant", label: "AI assistant", icon: Bot, p: "settings" },
    { href: "/admin/shop-assistant", label: "Shop assistant", icon: MessagesSquare, p: "shop_assistant", any: ["shop_assistant", "shop_assistant_kb", "shop_assistant_chats"] },
    { href: "/admin/ai-providers", label: "AI providers", icon: Cpu, p: "ai_providers" },
    { href: "/admin/go-live", label: "Go-live checklist", icon: Rocket, p: "dashboard" },
    { href: "/admin/integrations", label: "Integrations", icon: Plug, p: "integrations" },
    { href: "/admin/staff", label: "Staff and roles", icon: ShieldCheck, p: "staff" },
    { href: "/admin/audit", label: "Audit log", icon: FileClock, p: "audit" },
    { href: "/admin/account", label: "My account", icon: KeyRound, p: "dashboard" },
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
