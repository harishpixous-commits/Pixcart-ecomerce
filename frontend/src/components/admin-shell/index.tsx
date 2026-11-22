"use client";

/*
 * The admin panel's frame in the staff member's own layout (sidebar, top navigation, compact rail or glass), plus
 * quick find (Ctrl+K) in every layout. See docs/THEMES.md → Admin layouts.
 */

import { useCallback, useState } from "react";
import type { AdminNavItem } from "./nav";
import { QuickFind, useQuickFindKey } from "./parts";
import { useAdminPrefs } from "./prefs";
import { GlassShell, RailShell, SidebarShell, TopnavShell } from "./shells";

export { AdminPrefsProvider, useAdminPrefs, ADMIN_LAYOUTS, LAYOUT_INFO, type AdminLayout } from "./prefs";
export { LayoutPicker } from "./parts";
export { adminNav, EMPTY_COUNTS, type AdminNavItem, type NavCounts } from "./nav";

const SHELLS = { sidebar: SidebarShell, topnav: TopnavShell, rail: RailShell, glass: GlassShell };

export function AdminShell({ title, items, children }: { title: string; items: AdminNavItem[]; children: React.ReactNode }) {
  const { layout } = useAdminPrefs();
  const [find, setFind] = useState(false);
  const openFind = useCallback(() => setFind(true), []);
  const closeFind = useCallback(() => setFind(false), []);
  useQuickFindKey(openFind);
  const Shell = SHELLS[layout] ?? SidebarShell;
  return (
    <>
      <Shell title={title} items={items} onFind={openFind}>{children}</Shell>
      {find && <QuickFind items={items} onClose={closeFind} />}
    </>
  );
}
