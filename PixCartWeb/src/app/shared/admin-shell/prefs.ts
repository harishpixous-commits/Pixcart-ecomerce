/*
 * Each staff member's own admin panel preferences (GET/PUT /api/admin/me/preferences): the admin layout, folded menu
 * sections and a folded sidebar. Changes show at once and are saved in the background; if saving fails they are
 * undone with a message. Until the preferences load (or if the request fails) the owner's default layout is used.
 * Port of components/admin-shell/prefs.tsx: useAdminPrefs() → inject(AdminPrefsService). Call load() once (AdminLayout does).
 */

import { Injectable, computed, inject, signal } from "@angular/core";
import { api } from "../../core/api";
import { Toast } from "../ui/ui";

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

const EMPTY: Stored = { admin_layout: null, nav_collapsed: [], sidebar_collapsed: false };

function isLayout(v: unknown): v is AdminLayout {
  return typeof v === "string" && (ADMIN_LAYOUTS as readonly string[]).includes(v);
}

@Injectable({ providedIn: "root" })
export class AdminPrefsService {
  private readonly toast = inject(Toast);
  private readonly data = signal<PrefsOut | null>(null);
  private loading = false;

  private readonly stored = computed(() => this.data()?.ui_prefs ?? EMPTY);
  readonly defaultLayout = computed<AdminLayout>(() => (isLayout(this.data()?.default_layout) ? this.data()!.default_layout : "sidebar"));
  readonly layout = computed<AdminLayout>(() => (isLayout(this.data()?.admin_layout) ? this.data()!.admin_layout : this.defaultLayout()));
  /** the person's own choice (null: the owner's default) */
  readonly chosen = computed(() => this.stored().admin_layout);
  readonly folded = computed(() => this.stored().nav_collapsed);
  readonly sidebarFolded = computed(() => this.stored().sidebar_collapsed);
  readonly environment = computed(() => this.data()?.environment ?? "production");
  readonly ready = computed(() => this.data() !== null);

  /** Reads the preferences (once per visit; call again after sign-in as someone else). */
  load(force = false): void {
    if (this.loading && !force) return;
    this.loading = true;
    api<PrefsOut>("/api/admin/me/preferences")
      .then((d) => this.data.set(d))
      .catch(() => this.data.set({ ui_prefs: { ...EMPTY }, admin_layout: "sidebar", default_layout: "sidebar" }));
  }

  private update(patch: Partial<Stored>): void {
    const before = this.data();
    if (!before) return;
    const nextStored = { ...this.stored(), ...patch };
    this.data.set({ ...before, ui_prefs: nextStored, admin_layout: nextStored.admin_layout ?? this.defaultLayout() });
    api<PrefsOut>("/api/admin/me/preferences", { method: "PUT", body: patch })
      .then((r) => this.data.update((d) => (d ? { ...r, environment: r.environment ?? d.environment } : r)))
      .catch(() => {
        this.data.set(before);
        this.toast.show("Could not save your layout. Check your connection and try again.", "error");
      });
  }

  setLayout(l: AdminLayout | null): void {
    this.update({ admin_layout: l });
  }
  toggleSection(name: string): void {
    const cur = this.stored().nav_collapsed;
    this.update({ nav_collapsed: cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name].slice(-20) });
  }
  setSidebarFolded(v: boolean): void {
    this.update({ sidebar_collapsed: v });
  }
}
