/* Admin → Customers and accounts: every account, search, kinds, add a customer. Port of frontend/src/app/admin/customers/page.tsx. */

import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, signal } from "@angular/core";
import { Router } from "@angular/router";
import { Plus } from "lucide-angular";
import { api, ApiError, latestOnly } from "../../core/api";
import { date } from "../../core/format";
import type { Paged } from "../../core/types";
import { ExportButton } from "../../shared/portal/export-button";
import { PageHeader, Table, Tabs } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Input, Modal, Pagination, Pill, TextField, Toast } from "../../shared/ui/ui";

type Row = { id: string; name: string; phone: string | null; email: string | null; is_admin: boolean; is_active: boolean; orders: number;
  seller: { id: string; status: string } | null; last_login_at: string | null; created_at: string };
const KINDS = [
  { value: "all", label: "Everyone" }, { value: "customers", label: "Customers" }, { value: "sellers", label: "Sellers" },
  { value: "staff", label: "Staff" }, { value: "blocked", label: "Blocked" },
];

@Component({
  selector: "pc-admin-customers-page",
  imports: [PageHeader, Table, Tabs, ExportButton, Icon, PcLink, PageLoader, Button, ErrorNote, Input, Modal, Pagination, Pill, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <pc-page-header title="Customers and accounts" sub="Every account: customers, sellers' logins and staff. Open one to see and manage its details." [withActions]="true">
      <button actions pcButton (click)="openAdd()"><svg [pcIcon]="Plus" class="h-4 w-4" />Add customer</button>
      <pc-export-button actions scope="admin" name="customers" [dated]="false" />
    </pc-page-header>
    <pc-tabs [value]="kind()" (valueChange)="kind.set($event); page.set(1)" [items]="kinds" />
    <input pcInput placeholder="Name, mobile or email" [value]="q()" (input)="q.set($any($event.target).value); page.set(1)" class="mb-3 max-w-sm" aria-label="Search accounts" />
    @if (!d()) {
      <pc-page-loader />
    } @else {
      <pc-table [head]="['Name', 'Mobile', 'Email', 'Orders', 'Joined', 'Last sign-in', 'Status']">
        @for (u of d()!.items; track u.id) {
          <tr class="cursor-pointer hover:bg-mist/60" (click)="go(u.id)">
            <td class="px-4 py-2.5">
              <a [pcLink]="'/admin/customers/' + u.id" class="font-semibold text-peacock" (click)="$event.stopPropagation()">{{ u.name || "—" }}</a>{{ " " }}@if (u.is_admin) {<pc-pill tone="blue">Staff</pc-pill>}{{ " " }}@if (u.seller) {<pc-pill tone="gray">Seller</pc-pill>}
            </td>
            <td class="px-4 py-2.5">{{ u.phone }}</td>
            <td class="px-4 py-2.5 text-sm">{{ u.email }}</td>
            <td class="px-4 py-2.5">{{ u.orders }}</td>
            <td class="px-4 py-2.5 text-sm">{{ date(u.created_at) }}</td>
            <td class="px-4 py-2.5 text-sm">{{ u.last_login_at ? date(u.last_login_at) : "Never" }}</td>
            <td class="px-4 py-2.5">@if (u.is_active) {<pc-pill tone="green">Active</pc-pill>} @else {<pc-pill tone="red">Blocked</pc-pill>}</td>
          </tr>
        }
      </pc-table>
      @if (!d()!.items.length) {<p class="py-6 text-center text-ink-faint">No accounts match.</p>}
      <pc-pagination [page]="d()!.page" [pageSize]="d()!.page_size" [total]="d()!.total" (pageChange)="page.set($event)" />
    }
    <pc-modal [open]="adding()" (close)="adding.set(false)" title="Add a customer">
      <form (submit)="add($event)" class="flex flex-col gap-3">
        <p class="text-sm text-ink-soft">For orders taken on the phone or in a shop. The customer signs in with a one-time code on this mobile; no password is needed.</p>
        <pc-error-note [message]="error()" />
        <pc-text-field label="Full name" [value]="f().name" (valueChange)="setF('name', $event)" [error]="fieldErrors()['name']" [required]="true" [autofocus]="true" />
        <pc-text-field label="Mobile number" type="tel" inputmode="numeric" [value]="f().phone" (valueChange)="setF('phone', $event)" [error]="fieldErrors()['phone']" [required]="true" />
        <pc-text-field label="Email (optional)" type="email" [value]="f().email" (valueChange)="setF('email', $event)" [error]="fieldErrors()['email']" />
        <button pcButton type="submit" [loading]="busy()" [disabled]="f().name.trim().length < 2 || f().phone.replace(digitsOnly, '').length < 10">Create account</button>
      </form>
    </pc-modal>
  `,
})
export class AdminCustomersPage {
  private readonly toast = inject(Toast);
  private readonly router = inject(Router);
  protected readonly Plus = Plus;
  protected readonly date = date;
  protected readonly kinds = KINDS;
  protected readonly digitsOnly = /\D/g;
  protected readonly q = signal("");
  protected readonly kind = signal("all");
  protected readonly page = signal(1);
  protected readonly d = signal<Paged<Row> | null>(null);
  protected readonly adding = signal(false);
  protected readonly f = signal({ name: "", phone: "", email: "" });
  protected readonly fieldErrors = signal<Record<string, string>>({});
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  private readonly track = latestOnly();

  constructor() {
    let t: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      const q = this.q(), page = this.page(), kind = this.kind();
      clearTimeout(t);
      t = setTimeout(() => void this.track(api<Paged<Row>>("/api/admin/customers", { query: { q, page, kind } }), (x) => this.d.set(x)), q ? 250 : 0);
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(t));
  }

  protected go(id: string): void {
    void this.router.navigateByUrl(`/admin/customers/${id}`);
  }

  protected setF(k: "name" | "phone" | "email", v: string): void {
    this.f.update((f) => ({ ...f, [k]: v }));
  }

  protected openAdd(): void {
    this.adding.set(true);
    this.f.set({ name: "", phone: "", email: "" });
    this.error.set(null);
  }

  protected async add(e: Event): Promise<void> {
    e.preventDefault();
    const f = this.f();
    this.busy.set(true);
    this.error.set(null);
    this.fieldErrors.set({});
    try {
      const r = await api<{ id: string }>("/api/admin/customers", { method: "POST", body: { name: f.name, phone: f.phone, email: f.email.trim() || null } });
      this.toast.show("Customer account created. They sign in with an OTP on this mobile.");
      void this.router.navigateByUrl(`/admin/customers/${r.id}`);
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : "Could not create the account");
      if (err instanceof ApiError) this.fieldErrors.set(err.fields ?? {});
    } finally {
      this.busy.set(false);
    }
  }
}
