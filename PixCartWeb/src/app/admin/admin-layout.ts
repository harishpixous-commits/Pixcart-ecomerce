/*
 * Every /admin page: signed-in staff only (others go to /admin/login), their role and permissions (/api/admin/me into
 * AdminContext), the pending-work badges, the two-step sign-in requirement, and the staff member's admin layout.
 * /admin/login renders bare. Port of app/admin/layout.tsx.
 */

import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from "@angular/core";
import { Router, RouterOutlet } from "@angular/router";
import { ShieldCheck } from "lucide-angular";
import { ADMIN_ME_REFRESH, AdminContext, type AdminMe } from "../core/admin";
import { api } from "../core/api";
import { RouteState } from "../core/route-state";
import { SessionService } from "../core/session";
import { AdminShell, EMPTY_COUNTS, adminNav, type NavCounts } from "../shared/admin-shell/admin-shell";
import { AdminPrefsService } from "../shared/admin-shell/prefs";
import { Icon } from "../shared/ui/icon";
import { PageLoader } from "../shared/ui/page-loader";

type Dashboard = {
  sellers_pending_review: number; products_pending_review: number; refunds_needing_attention: number; reviews_needing_attention?: number;
  product_reports_open?: number; deals_pending?: number; ads_pending?: number; questions_pending?: number; delivery_kyc_pending?: number;
  delivery_waiting?: number; delivery_complaints_open?: number;
};

@Component({
  selector: "pc-admin-layout",
  imports: [RouterOutlet, Icon, AdminShell, PageLoader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (isLogin()) {
      <router-outlet />
    } @else if (!session.ready() || !session.user()?.is_admin || !me()) {
      <pc-page-loader />
    } @else if (mustSetUp()) {
      <div class="min-h-screen bg-mist px-3 py-6 sm:px-6">
        <div class="mx-auto flex max-w-3xl flex-col gap-4">
          <div class="flex items-start gap-3 rounded-xl bg-marigold-light p-4 ring-1 ring-marigold" role="status" data-testid="two-step-required">
            <svg [pcIcon]="ShieldCheck" class="mt-0.5 h-5 w-5 shrink-0" />
            <p><b>Turn on two-step sign-in to continue.</b> The owner requires it for every staff account. Set it up below with an authenticator app; the admin panel opens as soon as it is on.</p>
          </div>
          @if (path() === "/admin/account") {<router-outlet />} @else {<pc-page-loader />}
        </div>
      </div>
    } @else {
      <pc-admin-shell [title]="'Admin, ' + me()!.role_label" [items]="items()"><router-outlet /></pc-admin-shell>
      <!-- TODO(admin module): the AI assistant dock (components/assistant/dock.tsx) when me().permissions has "assistant". -->
    }
  `,
})
export class AdminLayout {
  protected readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly admin = inject(AdminContext);
  private readonly prefs = inject(AdminPrefsService);
  protected readonly path = inject(RouteState).pathname;
  protected readonly me = this.admin.me;
  private readonly counts = signal<NavCounts>(EMPTY_COUNTS);
  protected readonly ShieldCheck = ShieldCheck;
  protected readonly isLogin = computed(() => this.path() === "/admin/login");
  // the owner requires two-step sign-in: until it is on, My account is the only page that works
  protected readonly mustSetUp = computed(() => Boolean(this.me()?.two_step_required));
  protected readonly items = computed(() => adminNav(this.me()?.permissions ?? [], this.counts()));

  constructor() {
    effect(() => {
      if (!this.session.ready() || this.isLogin()) return;
      const user = this.session.user();
      if (!user || !user.is_admin) void this.router.navigateByUrl("/admin/login", { replaceUrl: true });
    });

    const load = () => api<AdminMe>("/api/admin/me").then((m) => this.admin.me.set(m)).catch(() => {});
    window.addEventListener(ADMIN_ME_REFRESH, load);
    inject(DestroyRef).onDestroy(() => window.removeEventListener(ADMIN_ME_REFRESH, load));
    let loadedFor: string | null = null;
    effect(() => {
      const user = this.session.user();
      if (!user?.is_admin || this.isLogin()) return;
      if (loadedFor === user.id) return;
      loadedFor = user.id;
      untracked(() => {
        this.admin.me.set(null);
        void load();
        this.prefs.load(true);
      });
    });

    effect(() => {
      if (this.mustSetUp() && this.path() !== "/admin/account") void this.router.navigateByUrl("/admin/account", { replaceUrl: true });
    });

    effect(() => {
      const user = this.session.user();
      const me = this.me();
      this.path();
      if (!user?.is_admin || this.isLogin() || !me?.permissions.includes("dashboard")) return;
      api<Dashboard>("/api/admin/dashboard")
        .then((d) => this.counts.set({
          s: d.sellers_pending_review, p: d.products_pending_review, r: d.refunds_needing_attention, rv: d.reviews_needing_attention ?? 0,
          pr: d.product_reports_open ?? 0, dl: d.deals_pending ?? 0, ad: d.ads_pending ?? 0, qa: d.questions_pending ?? 0,
          dk: d.delivery_kyc_pending ?? 0, dw: d.delivery_waiting ?? 0, dc: d.delivery_complaints_open ?? 0,
        }))
        .catch(() => {});
    });
  }
}
