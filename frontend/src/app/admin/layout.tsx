"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AdminPrefsProvider, AdminShell, EMPTY_COUNTS, adminNav, type NavCounts } from "@/components/admin-shell";
import { AssistantDock } from "@/components/assistant/dock";
import { PageLoader } from "@/components/ui";
import { ShieldCheck } from "lucide-react";
import { ADMIN_ME_REFRESH, AdminCtx, type AdminMe } from "@/lib/admin";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, ready } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const isLogin = pathname === "/admin/login";
  const [me, setMe] = useState<AdminMe | null>(null);
  const [counts, setCounts] = useState<NavCounts>(EMPTY_COUNTS);

  useEffect(() => {
    if (!ready || isLogin) return;
    if (!user || !user.is_admin) router.replace("/admin/login");
  }, [ready, user, isLogin, router]);

  useEffect(() => {
    if (!user?.is_admin || isLogin) return;
    const load = () => api<AdminMe>("/api/admin/me").then(setMe).catch(() => {});
    load();
    window.addEventListener(ADMIN_ME_REFRESH, load);
    return () => window.removeEventListener(ADMIN_ME_REFRESH, load);
  }, [user, isLogin]);

  // the owner requires two-step sign-in: until it is on, My account is the only page that works
  const mustSetUp = Boolean(me?.two_step_required);
  useEffect(() => {
    if (mustSetUp && pathname !== "/admin/account") router.replace("/admin/account");
  }, [mustSetUp, pathname, router]);

  useEffect(() => {
    if (user?.is_admin && !isLogin && me?.permissions.includes("dashboard"))
      api<{
        sellers_pending_review: number; products_pending_review: number; refunds_needing_attention: number; reviews_needing_attention?: number;
        product_reports_open?: number; deals_pending?: number; ads_pending?: number; questions_pending?: number; delivery_kyc_pending?: number;
        delivery_waiting?: number; delivery_complaints_open?: number;
      }>("/api/admin/dashboard")
        .then((d) => setCounts({
          s: d.sellers_pending_review, p: d.products_pending_review, r: d.refunds_needing_attention, rv: d.reviews_needing_attention ?? 0,
          pr: d.product_reports_open ?? 0, dl: d.deals_pending ?? 0, ad: d.ads_pending ?? 0, qa: d.questions_pending ?? 0,
          dk: d.delivery_kyc_pending ?? 0, dw: d.delivery_waiting ?? 0, dc: d.delivery_complaints_open ?? 0,
        }))
        .catch(() => {});
  }, [user, isLogin, pathname, me]);

  if (isLogin) return <>{children}</>;
  if (!ready || !user?.is_admin || !me) return <PageLoader />;
  if (mustSetUp) {
    return (
      <AdminCtx.Provider value={me}>
        <AdminPrefsProvider>
          <div className="min-h-screen bg-mist px-3 py-6 sm:px-6">
            <div className="mx-auto flex max-w-3xl flex-col gap-4">
              <div className="flex items-start gap-3 rounded-xl bg-marigold-light p-4 ring-1 ring-marigold" role="status" data-testid="two-step-required">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
                <p><b>Turn on two-step sign-in to continue.</b> The owner requires it for every staff account. Set it up below with an authenticator app; the admin panel opens as soon as it is on.</p>
              </div>
              {pathname === "/admin/account" ? children : <PageLoader />}
            </div>
          </div>
        </AdminPrefsProvider>
      </AdminCtx.Provider>
    );
  }
  return (
    <AdminCtx.Provider value={me}>
      <AdminPrefsProvider>
        <AdminShell title={`Admin, ${me.role_label}`} items={adminNav(me.permissions, counts)}>
          {children}
        </AdminShell>
      </AdminPrefsProvider>
      {me.permissions.includes("assistant") && <AssistantDock />}
    </AdminCtx.Provider>
  );
}
