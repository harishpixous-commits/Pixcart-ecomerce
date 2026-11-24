/*
 * The admin panel's frame in the staff member's own layout (sidebar, top navigation, compact rail or glass), plus
 * quick find (Ctrl+K) in every layout. Port of components/admin-shell/index.tsx:
 *   <pc-admin-shell [title] [items]> page </pc-admin-shell>
 */

import { NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, inject, input, signal } from "@angular/core";
import { AdminPageSkeleton } from "../ui/skeletons";
import type { AdminNavItem } from "./nav";
import { QuickFind, quickFindKey } from "./parts";
import { AdminPrefsService } from "./prefs";
import { GlassShell, RailShell, SidebarShell, TopnavShell } from "./shells";

export { ADMIN_LAYOUTS, AdminPrefsService, LAYOUT_INFO, type AdminLayout } from "./prefs";
export { LayoutPicker } from "./parts";
export { EMPTY_COUNTS, adminNav, type AdminNavItem, type NavCounts } from "./nav";

@Component({
  selector: "pc-admin-shell",
  imports: [NgTemplateOutlet, AdminPageSkeleton, QuickFind, SidebarShell, TopnavShell, RailShell, GlassShell],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <ng-template #page><ng-content /></ng-template>
    @if (!prefs.ready()) {
      <!-- Wait for the person's saved layout: drawing the default first and then switching would rebuild the whole page. -->
      <div class="min-h-screen bg-mist p-4 sm:p-6" aria-busy="true"><pc-admin-page-skeleton kind="dashboard" /></div>
    } @else {
      @switch (prefs.layout()) {
        @case ("topnav") {<pc-topnav-shell [title]="title()" [items]="items()" (find)="find.set(true)"><ng-container *ngTemplateOutlet="page" /></pc-topnav-shell>}
        @case ("rail") {<pc-rail-shell [title]="title()" [items]="items()" (find)="find.set(true)"><ng-container *ngTemplateOutlet="page" /></pc-rail-shell>}
        @case ("glass") {<pc-glass-shell [title]="title()" [items]="items()" (find)="find.set(true)"><ng-container *ngTemplateOutlet="page" /></pc-glass-shell>}
        @default {<pc-sidebar-shell [title]="title()" [items]="items()" (find)="find.set(true)"><ng-container *ngTemplateOutlet="page" /></pc-sidebar-shell>}
      }
      @if (find()) {<pc-quick-find [items]="items()" (close)="find.set(false)" />}
    }
  `,
})
export class AdminShell {
  readonly title = input.required<string>();
  readonly items = input.required<AdminNavItem[]>();
  protected readonly prefs = inject(AdminPrefsService);
  protected readonly find = signal(false);
  constructor() {
    quickFindKey(() => this.find.set(true));
  }
}
