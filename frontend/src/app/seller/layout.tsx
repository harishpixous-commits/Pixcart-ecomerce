"use client";

import { BarChart3, Boxes, FileDown, IndianRupee, LayoutDashboard, MessageSquareText, Package, Settings, ShoppingBag, Tag, Undo2, Warehouse } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { PortalShell } from "@/components/portal-shell";
import { PageLoader } from "@/components/ui";
import { useSession } from "@/lib/session";

export default function SellerLayout({ children }: { children: React.ReactNode }) {
  const { user, ready } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const onboarding = pathname.startsWith("/seller/onboarding");

  useEffect(() => {
    if (!ready) return;
    if (!user) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    else if (!onboarding && (!user.seller || user.seller.status !== "approved")) router.replace("/seller/onboarding");
  }, [ready, user, onboarding, pathname, router]);

  if (!ready || !user) return <PageLoader />;
  const approved = user.seller?.status === "approved";
  const nav = approved
    ? [
        { href: "/seller", label: "Dashboard", icon: LayoutDashboard },
        { href: "/seller/orders", label: "Orders", icon: ShoppingBag },
        { href: "/seller/returns", label: "Returns", icon: Undo2 },
        { href: "/seller/products", label: "Products", icon: Package },
        { href: "/seller/inventory", label: "Inventory", icon: Boxes },
        { href: "/seller/warehouses", label: "Warehouses", icon: Warehouse },
        { href: "/seller/payouts", label: "Payouts", icon: IndianRupee },
        { href: "/seller/analytics", label: "Analytics", icon: BarChart3 },
        { href: "/seller/exports", label: "Reports and exports", icon: FileDown },
        { href: "/seller/coupons", label: "Coupons", icon: Tag },
        { href: "/seller/reviews", label: "Reviews", icon: MessageSquareText },
        { href: "/seller/settings", label: "Store settings", icon: Settings },
      ]
    : [{ href: "/seller/onboarding", label: "Registration", icon: Settings }];
  if (!approved && !onboarding) return <PageLoader />;
  return (
    <PortalShell title="Seller hub" nav={nav} root="/seller">
      {children}
    </PortalShell>
  );
}
