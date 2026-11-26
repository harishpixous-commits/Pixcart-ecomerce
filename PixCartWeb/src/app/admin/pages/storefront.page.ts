/*
 * Admin → Storefront: everything shoppers see. Theme and layout, the home page sections, brand and colours,
 * navigation and footer, business details, information pages and the media library. Brand, navigation and business
 * share one draft of the site settings with Save and Discard. Port of frontend/src/app/admin/storefront/page.tsx.
 */

import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from "@angular/core";
import { Router } from "@angular/router";
import { api, ApiError, quietly } from "../../core/api";
import type { Site } from "../../core/types";
import { PageHeader, Tabs } from "../../shared/portal-shell";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Toast } from "../../shared/ui/ui";
import { MediaGrid } from "../shared/media-picker";
import { searchParam } from "../shared/admin-helpers";
import { BrandEditor, NavEditor } from "../storefront/brand";
import { BusinessEditor } from "../storefront/business";
import { PagesEditor } from "../storefront/pages";
import { SectionsEditor } from "../storefront/sections";
import { ThemeEditor } from "../storefront/theme";

const TABS = [
  { value: "theme", label: "Theme and layout" },
  { value: "home", label: "Home page" },
  { value: "brand", label: "Brand and colours" },
  { value: "nav", label: "Navigation and footer" },
  { value: "business", label: "Business, contact and social" },
  { value: "pages", label: "Pages" },
  { value: "media", label: "Media library" },
];

@Component({
  selector: "pc-admin-storefront-page",
  imports: [PageHeader, Tabs, PageLoader, Button, ErrorNote, MediaGrid, BrandEditor, NavEditor, BusinessEditor, PagesEditor, SectionsEditor, ThemeEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <div>
      <pc-page-header title="Storefront" sub="Everything shoppers see: the home page, brand, colours, menus and information pages." [withActions]="siteTab() && !!site()">
        <ng-container ngProjectAs="[actions]">
          @if (siteTab() && site()) {
            @if (dirty()) {<span class="self-center text-sm text-ink-soft">Unsaved changes</span>}
            <button pcButton variant="ghost" [disabled]="!dirty()" (click)="discard()">Discard</button>
            <button pcButton (click)="saveSite()" [loading]="busy()" [disabled]="!dirty()">Save changes</button>
          }
        </ng-container>
      </pc-page-header>
      <pc-tabs [value]="tab()" (valueChange)="pick($event)" [items]="tabs" />
      <pc-error-note [message]="error()" />
      @if (tab() === "theme") {<pc-theme-editor />}
      @if (tab() === "home") {<pc-sections-editor />}
      @if (siteTab()) {
        @if (!site()) {
          <pc-page-loader />
        } @else if (tab() === "brand") {
          <pc-brand-editor [site]="site()!" (siteChange)="site.set($event)" />
        } @else if (tab() === "business") {
          <pc-business-editor [site]="site()!" (siteChange)="site.set($event)" />
        } @else {
          <pc-nav-editor [site]="site()!" (siteChange)="site.set($event)" />
        }
      }
      @if (tab() === "pages") {<pc-pages-editor />}
      @if (tab() === "media") {<div class="rounded-xl bg-white p-5"><pc-media-grid /></div>}
    </div>
  `,
})
export class AdminStorefrontPage {
  private readonly router = inject(Router);
  private readonly toast = inject(Toast);
  private readonly tabParam = searchParam("tab");
  protected readonly tabs = TABS;
  protected readonly tab = computed(() => this.tabParam() ?? "home");
  protected readonly siteTab = computed(() => this.tab() === "brand" || this.tab() === "nav" || this.tab() === "business");
  protected readonly site = signal<Site | null>(null);
  private readonly saved = signal("");
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly dirty = computed(() => this.site() !== null && JSON.stringify(this.site()) !== this.saved());

  constructor() {
    api<Site>("/api/admin/storefront/site").then((s) => { this.site.set(s); this.saved.set(JSON.stringify(s)); }).catch(quietly);
    const warn = (e: BeforeUnloadEvent) => { if (this.dirty()) e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    inject(DestroyRef).onDestroy(() => window.removeEventListener("beforeunload", warn));
  }

  protected pick(v: string): void {
    void this.router.navigateByUrl(`/admin/storefront?tab=${v}`, { replaceUrl: true });
  }

  protected discard(): void {
    this.site.set(JSON.parse(this.saved()) as Site);
  }

  protected async saveSite(): Promise<void> {
    const site = this.site();
    if (!site) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const s = await api<Site>("/api/admin/storefront/site", { method: "PUT", body: site });
      this.site.set(s);
      this.saved.set(JSON.stringify(s));
      this.toast.show("Saved. The shop shows the change now.");
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not save");
    } finally {
      this.busy.set(false);
    }
  }
}
