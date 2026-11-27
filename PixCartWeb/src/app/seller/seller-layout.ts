/*
 * Every /seller page: signed-in sellers only (others sign in; sellers not yet approved go to registration), the seller
 * hub menu with its badges, in the portal shell. Port of app/seller/layout.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from "@angular/core";
import { Router, RouterOutlet } from "@angular/router";
import {
  ChartColumn, Boxes, FileDown, Flag, IndianRupee, LayoutDashboard, Megaphone, MessageCircleQuestion, MessageSquareText, Package, Settings, ShoppingBag, Tag,
  ShieldCheck, Undo2, Warehouse, Zap,
} from "lucide-angular";
import { api } from "../core/api";
import { RouteState } from "../core/route-state";
import { SessionService } from "../core/session";
import { PortalShell, type NavItem } from "../shared/portal-shell";
import { PageLoader } from "../shared/ui/page-loader";

type Badges = { orders: number; questions: number; reports: number; deals_running: number };

@Component({
  selector: "pc-seller-layout",
  imports: [RouterOutlet, PortalShell, PageLoader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!session.ready() || !session.user() || (!approved() && !onboarding())) {
      <pc-page-loader />
    } @else {
      <pc-portal-shell title="Seller hub" [nav]="nav()" root="/seller"><router-outlet /></pc-portal-shell>
    }
  `,
})
export class SellerLayout {
  protected readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly path = inject(RouteState).pathname;
  private readonly badges = signal<Badges | null>(null);
  protected readonly onboarding = computed(() => this.path().startsWith("/seller/onboarding"));
  protected readonly approved = computed(() => this.session.user()?.seller?.status === "approved");
  protected readonly nav = computed<NavItem[]>(() => {
    const b = this.badges();
    return this.approved()
      ? [
          { section: "Overview", href: "/seller", label: "Dashboard", icon: LayoutDashboard },
          { section: "Orders", href: "/seller/orders", label: "Orders", icon: ShoppingBag, badge: b?.orders },
          { section: "Orders", href: "/seller/returns", label: "Returns", icon: Undo2 },
          { section: "Catalogue", href: "/seller/products", label: "Products", icon: Package },
          { section: "Catalogue", href: "/seller/inventory", label: "Inventory", icon: Boxes },
          { section: "Catalogue", href: "/seller/warehouses", label: "Warehouses", icon: Warehouse },
          { section: "Grow sales", href: "/seller/deals", label: "Deals", icon: Zap },
          { section: "Grow sales", href: "/seller/advertising", label: "Advertising", icon: Megaphone },
          { section: "Grow sales", href: "/seller/coupons", label: "Coupons", icon: Tag },
          { section: "Customers", href: "/seller/questions", label: "Questions", icon: MessageCircleQuestion, badge: b?.questions },
          { section: "Customers", href: "/seller/reviews", label: "Reviews", icon: MessageSquareText },
          { section: "Customers", href: "/seller/quality", label: "Quality", icon: ShieldCheck },
          { section: "Customers", href: "/seller/product-reports", label: "Customer reports", icon: Flag, badge: b?.reports },
          { section: "Money and reports", href: "/seller/payouts", label: "Payouts", icon: IndianRupee },
          { section: "Money and reports", href: "/seller/analytics", label: "Analytics", icon: ChartColumn },
          { section: "Money and reports", href: "/seller/exports", label: "Reports and exports", icon: FileDown },
          { section: "Settings", href: "/seller/settings", label: "Store settings", icon: Settings },
        ]
      : [{ href: "/seller/onboarding", label: "Registration", icon: Settings }];
  });

  constructor() {
    effect(() => {
      if (!this.session.ready()) return;
      const user = this.session.user();
      if (!user) void this.router.navigateByUrl(`/login?next=${encodeURIComponent(this.path())}`, { replaceUrl: true });
      else if (!this.onboarding() && (!user.seller || user.seller.status !== "approved")) void this.router.navigateByUrl("/seller/onboarding", { replaceUrl: true });
    });
    // menu counts, refreshed on every page change
    effect((onCleanup) => {
      this.path();
      if (!this.approved()) return;
      let live = true;
      api<Badges>("/api/seller/badges").then((b) => { if (live) this.badges.set(b); }).catch(() => {});
      onCleanup(() => { live = false; });
    });
  }
}
