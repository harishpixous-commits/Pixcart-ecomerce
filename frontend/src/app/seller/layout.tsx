"use client";

import {
  BarChart3, Boxes, ListChecks, FileDown, Flag, IndianRupee, LayoutDashboard, Megaphone, MessageCircleQuestion, MessageSquareText, Package, Settings, ShoppingBag, Tag,
  ShieldCheck, Undo2, Warehouse, Zap,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PortalShell } from "@/components/portal-shell";
import { PageLoader } from "@/components/ui";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";

type Badges = { orders: number; questions: number; reports: number; deals_running: number };

export default function SellerLayout({ children }: { children: React.ReactNode }) {
  const { user, ready } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const onboarding = pathname.startsWith("/seller/onboarding");
  const approved = user?.seller?.status === "approved";
  const [badges, setBadges] = useState<Badges | null>(null);

  useEffect(() => {
    if (!ready) return;
    if (!user) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    else if (!onboarding && (!user.seller || user.seller.status !== "approved")) router.replace("/seller/onboarding");
  }, [ready, user, onboarding, pathname, router]);

  // menu counts, refreshed on every page change
  useEffect(() => {
    if (!approved) return;
    let live = true;
    api<Badges>("/api/seller/badges").then((b) => { if (live) setBadges(b); }).catch(() => {});
    return () => { live = false; };
  }, [approved, pathname]);

  if (!ready || !user) return <PageLoader />;
  const nav = approved
    ? [
        { section: "Overview", href: "/seller", label: "Dashboard", icon: LayoutDashboard },
        { section: "Orders", href: "/seller/orders", label: "Orders", icon: ShoppingBag, badge: badges?.orders },
        { section: "Orders", href: "/seller/returns", label: "Returns", icon: Undo2 },
        { section: "Catalogue", href: "/seller/products", label: "Products", icon: Package },
        { section: "Catalogue", href: "/seller/inventory", label: "Inventory", icon: Boxes },
        { section: "Catalogue", href: "/seller/bulk-edit", label: "Bulk edit", icon: ListChecks },
        { section: "Catalogue", href: "/seller/warehouses", label: "Warehouses", icon: Warehouse },
        { section: "Grow sales", href: "/seller/deals", label: "Deals", icon: Zap },
        { section: "Grow sales", href: "/seller/advertising", label: "Advertising", icon: Megaphone },
        { section: "Grow sales", href: "/seller/coupons", label: "Coupons", icon: Tag },
        { section: "Customers", href: "/seller/questions", label: "Questions", icon: MessageCircleQuestion, badge: badges?.questions },
        { section: "Customers", href: "/seller/reviews", label: "Reviews", icon: MessageSquareText },
        { section: "Customers", href: "/seller/quality", label: "Quality", icon: ShieldCheck },
        { section: "Customers", href: "/seller/product-reports", label: "Customer reports", icon: Flag, badge: badges?.reports },
        { section: "Money and reports", href: "/seller/payouts", label: "Payouts", icon: IndianRupee },
        { section: "Money and reports", href: "/seller/analytics", label: "Analytics", icon: BarChart3 },
        { section: "Money and reports", href: "/seller/exports", label: "Reports and exports", icon: FileDown },
        { section: "Settings", href: "/seller/settings", label: "Store settings", icon: Settings },
      ]
    : [{ href: "/seller/onboarding", label: "Registration", icon: Settings }];
  if (!approved && !onboarding) return <PageLoader />;
  return (
    <PortalShell title="Seller hub" nav={nav} root="/seller">
      {children}
    </PortalShell>
  );
}
