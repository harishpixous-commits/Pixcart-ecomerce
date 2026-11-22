"use client";

/*
 * Each staff member's own admin panel preferences (GET/PUT /api/admin/me/preferences): the admin layout, folded menu
 * sections and a folded sidebar. Changes show at once and are saved in the background; if saving fails they are
 * undone with a message. Until the preferences load (or if the request fails) the owner's default layout is used.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useToast } from "@/components/ui";
import { api } from "@/lib/api";

export const ADMIN_LAYOUTS = ["sidebar", "topnav", "rail", "glass"] as const;
export type AdminLayout = (typeof ADMIN_LAYOUTS)[number];

export const LAYOUT_INFO: Record<AdminLayout, { name: string; text: string }> = {
  sidebar: { name: "Sidebar", text: "The full menu on the left, with groups you can fold and quick find" },
  topnav: { name: "Top navigation", text: "Menus across the top; pages use the full width" },
  rail: { name: "Compact rail", text: "A slim icon rail that opens on hover; the most room for tables" },
  glass: { name: "Glass", text: "Frosted sidebar and toolbar, large titles, a tab bar on phones (inspired by Apple's design guidelines)" },
};

interface Stored { admin_layout: AdminLayout | null; nav_collapsed: string[]; sidebar_collapsed: boolean }
interface PrefsOut { ui_prefs: Stored; admin_layout: AdminLayout; default_layout: AdminLayout; environment?: string }

interface PrefsCtx {
  layout: AdminLayout;
  /** the person's own choice (null: the owner's default) */
  chosen: AdminLayout | null;
  defaultLayout: AdminLayout;
  folded: string[];
  sidebarFolded: boolean;
  environment: string;
  ready: boolean;
  setLayout: (l: AdminLayout | null) => void;
  toggleSection: (name: string) => void;
  setSidebarFolded: (v: boolean) => void;
}

const Ctx = createContext<PrefsCtx | null>(null);

function isLayout(v: unknown): v is AdminLayout {
  return typeof v === "string" && (ADMIN_LAYOUTS as readonly string[]).includes(v);
}

export function AdminPrefsProvider({ children }: { children: React.ReactNode }) {
  const toast = useToast();
  const [data, setData] = useState<PrefsOut | null>(null);

  useEffect(() => {
    api<PrefsOut>("/api/admin/me/preferences")
      .then(setData)
      .catch(() => setData({ ui_prefs: { admin_layout: null, nav_collapsed: [], sidebar_collapsed: false }, admin_layout: "sidebar", default_layout: "sidebar" }));
  }, []);

  const save = useCallback((patch: Partial<Stored>, before: PrefsOut) => {
    api<PrefsOut>("/api/admin/me/preferences", { method: "PUT", body: patch })
      .then((r) => setData((d) => (d ? { ...r, environment: r.environment ?? d.environment } : r)))
      .catch(() => {
        setData(before);
        toast("Could not save your layout. Check your connection and try again.", "error");
      });
  }, [toast]);

  const value = useMemo<PrefsCtx>(() => {
    const stored = data?.ui_prefs ?? { admin_layout: null, nav_collapsed: [], sidebar_collapsed: false };
    const def = isLayout(data?.default_layout) ? data!.default_layout : "sidebar";
    const update = (patch: Partial<Stored>) => {
      if (!data) return;
      const nextStored = { ...stored, ...patch };
      const next = { ...data, ui_prefs: nextStored, admin_layout: nextStored.admin_layout ?? def };
      setData(next);
      save(patch, data);
    };
    return {
      layout: isLayout(data?.admin_layout) ? data!.admin_layout : def,
      chosen: stored.admin_layout,
      defaultLayout: def,
      folded: stored.nav_collapsed,
      sidebarFolded: stored.sidebar_collapsed,
      environment: data?.environment ?? "production",
      ready: data !== null,
      setLayout: (l) => update({ admin_layout: l }),
      toggleSection: (name) => update({ nav_collapsed: stored.nav_collapsed.includes(name) ? stored.nav_collapsed.filter((n) => n !== name) : [...stored.nav_collapsed, name].slice(-20) }),
      setSidebarFolded: (v) => update({ sidebar_collapsed: v }),
    };
  }, [data, save]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAdminPrefs(): PrefsCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAdminPrefs needs AdminPrefsProvider");
  return v;
}
