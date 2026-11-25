/* Admin → Sellers: the verification queue by status, and opening a seller account by hand. Port of frontend/src/app/admin/sellers/page.tsx. */

import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from "@angular/core";
import { Router } from "@angular/router";
import { Plus } from "lucide-angular";
import { api, ApiError, quietly } from "../../core/api";
import { date } from "../../core/format";
import type { Paged } from "../../core/types";
import { ExportButton } from "../../shared/portal/export-button";
import { PageHeader, Table, Tabs } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, ErrorNote, Input, Modal, Pagination, StatusPill, TextField, Toast } from "../../shared/ui/ui";
import { searchParam } from "../shared/admin-helpers";

type Row = { id: string; display_name: string; legal_name: string; gstin: string | null; status: string; city: string; state: string; submitted_at: string | null; created_at: string };
type Data = Paged<Row> & { status_counts?: Record<string, number> };
type F = { phone: string; name: string; store: string; email: string };

const TABS = [["submitted", "To verify"], ["approved", "Approved"], ["rejected", "Sent back"], ["suspended", "Suspended"], ["draft", "Not submitted"], ["", "All"]];

@Component({
  selector: "pc-admin-sellers-page",
  imports: [PageHeader, Table, Tabs, ExportButton, Icon, PcLink, PageLoader, Button, EmptyState, ErrorNote, Input, Modal, Pagination, StatusPill, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <div>
      <pc-page-header title="Sellers" [withActions]="true">
        <button actions pcButton (click)="openAdd()"><svg [pcIcon]="Plus" class="h-4 w-4" />Add seller</button>
        <pc-export-button actions scope="admin" name="sellers" [status]="status() || undefined" [dated]="false" />
      </pc-page-header>
      <pc-tabs [value]="status()" (valueChange)="tab($event)" [items]="tabs()" />
      <input pcInput placeholder="Search name, GSTIN or phone" [value]="q()" (input)="q.set($any($event.target).value); page.set(1)" class="mb-3 max-w-sm" aria-label="Search sellers" />
      @if (!d()) {
        <pc-page-loader />
      } @else if (d()!.items.length === 0) {
        <pc-empty-state title="No sellers here" [hasAction]="false" />
      } @else {
        <pc-table [head]="['Store', 'Legal name', 'GSTIN', 'Location', 'Submitted', 'Status']">
          @for (s of d()!.items; track s.id) {
            <tr class="hover:bg-mist/60">
              <td class="px-4 py-3"><a [pcLink]="'/admin/sellers/' + s.id" class="font-semibold text-peacock hover:underline">{{ s.display_name }}</a></td>
              <td class="px-4 py-3">{{ s.legal_name }}</td>
              <td class="px-4 py-3 font-mono text-sm">{{ s.gstin }}</td>
              <td class="px-4 py-3 text-sm">{{ s.city }}{{ s.state ? ", " + s.state : "" }}</td>
              <td class="px-4 py-3 text-sm">{{ date(s.submitted_at) }}</td>
              <td class="px-4 py-3"><pc-status-pill [status]="s.status" /></td>
            </tr>
          }
        </pc-table>
        <pc-pagination [page]="d()!.page" [pageSize]="d()!.page_size" [total]="d()!.total" (pageChange)="page.set($event)" />
      }
      <pc-modal [open]="adding()" (close)="adding.set(false)" title="Add a seller">
        <form (submit)="add($event)" class="flex flex-col gap-3">
          <p class="text-sm text-ink-soft">Opens a seller account in draft. The seller signs in with a one-time code on this mobile, fills in business, PAN, GST, pickup and bank details and submits them; you then verify as usual.</p>
          <pc-error-note [message]="err()" />
          <pc-text-field label="Owner's mobile number" type="tel" [value]="f().phone" (valueChange)="setF('phone', $event)" [required]="true" [autofocus]="true" />
          <pc-text-field label="Owner's name" [value]="f().name" (valueChange)="setF('name', $event)" [required]="true" />
          <pc-text-field label="Store name (shown to customers)" [value]="f().store" (valueChange)="setF('store', $event)" [required]="true" />
          <pc-text-field label="Email (optional)" type="email" [value]="f().email" (valueChange)="setF('email', $event)" />
          <button pcButton type="submit" [loading]="busy()" [disabled]="f().phone.replace(nonDigits, '').length < 10 || f().name.trim().length < 2 || f().store.trim().length < 2">Open seller account</button>
        </form>
      </pc-modal>
    </div>
  `,
})
export class AdminSellersPage {
  private readonly router = inject(Router);
  private readonly toast = inject(Toast);
  protected readonly Plus = Plus;
  protected readonly date = date;
  protected readonly nonDigits = /\D/g;
  private readonly statusParam = searchParam("status");
  protected readonly status = computed(() => this.statusParam() ?? "submitted");
  protected readonly q = signal("");
  protected readonly page = signal(1);
  protected readonly d = signal<Data | null>(null);
  protected readonly adding = signal(false);
  protected readonly f = signal<F>({ phone: "", name: "", store: "", email: "" });
  protected readonly err = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly tabs = computed(() => {
    const c = this.d()?.status_counts ?? {};
    return TABS.map(([v, l]) => ({ value: v, label: l, count: v ? c[v] ?? 0 : undefined }));
  });

  constructor() {
    let t: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      const status = this.status(), q = this.q(), page = this.page();
      clearTimeout(t);
      t = setTimeout(() => api<Data>("/api/admin/sellers", { query: { status: status || undefined, q, page } }).then((x) => this.d.set(x)).catch(quietly), q ? 250 : 0);
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(t));
  }

  protected tab(v: string): void {
    this.page.set(1);
    void this.router.navigateByUrl(`/admin/sellers?status=${v}`);
  }

  protected setF(k: keyof F, v: string): void {
    this.f.update((f) => ({ ...f, [k]: v }));
  }

  protected openAdd(): void {
    this.adding.set(true);
    this.err.set(null);
    this.f.set({ phone: "", name: "", store: "", email: "" });
  }

  protected async add(e: Event): Promise<void> {
    e.preventDefault();
    const f = this.f();
    this.busy.set(true);
    this.err.set(null);
    try {
      const r = await api<{ id: string }>("/api/admin/sellers", { method: "POST", body: { phone: f.phone, name: f.name, store_name: f.store, email: f.email.trim() || null } });
      this.toast.show("Seller account opened. They sign in with this mobile to finish their details.");
      void this.router.navigateByUrl(`/admin/sellers/${r.id}`);
    } catch (x) {
      this.err.set(x instanceof ApiError ? x.message : "Could not create the seller");
    } finally {
      this.busy.set(false);
    }
  }
}
