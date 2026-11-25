/* Admin → one customer account: details, orders, returns, tickets, history; edit, sign out, block. Port of frontend/src/app/admin/customers/[id]/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from "@angular/core";
import { ArrowLeft, LogOut, Pencil, ShieldCheck, ShieldOff } from "lucide-angular";
import { AdminContext } from "../../core/admin";
import { api, ApiError, quietly } from "../../core/api";
import { date, rupees } from "../../core/format";
import { PageHeader, Stat, Table } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, ErrorNote, Modal, Pill, StatusPill, Textarea, TextField, Toast } from "../../shared/ui/ui";

type Detail = {
  id: string; name: string; phone: string | null; email: string | null; is_active: boolean; is_admin: boolean; marketing_opt_in: boolean;
  created_at: string; last_login_at: string | null; terms_accepted_at: string | null;
  seller: { id: string; name: string; status: string } | null;
  stats: { orders: number; spent: number; returns: number; tickets: number; open_tickets: number; wishlist: number; reviews: number };
  addresses: { id: string; name: string; phone: string; kind: string; is_default: boolean; text: string }[];
  orders: { id: string; number: string; status: string; payment_method: string; grand_total: number; created_at: string; item_count: number; sub_statuses: string[] }[];
  returns: { id: string; number: string; status: string; reason_label: string; refund_amount: number; sub_order_number: string; order_id: string; created_at: string }[];
  tickets: { id: string; number: string; subject: string; status: string; updated_at: string }[];
  sessions: { device: string; signed_in_at: string; expires_at: string }[];
  history: { action: string; detail: string; by: string; at: string }[];
};

const ACTIONS: Record<string, string> = {
  "user.create": "Account created", "user.edit": "Details changed", "user.block": "Blocked", "user.unblock": "Unblocked",
  "user.sign_out": "Signed out everywhere", "staff.create": "Made staff", "staff.update": "Staff access changed",
};

/** A white card with a title and an optional action on the right (project it with the `action` attribute). */
@Component({
  selector: "section[pcCustomerCard]",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "rounded-xl bg-white p-5" },
  template: `
    <div class="mb-3 flex items-center justify-between gap-2"><h2 class="text-lg font-semibold">{{ title() }}</h2><ng-content select="[action]" /></div>
    <ng-content />
  `,
})
export class CustomerCard {
  readonly title = input.required<string>();
}

@Component({
  selector: "pc-admin-customers-id-page",
  imports: [PageHeader, Stat, Table, Icon, PcLink, PageLoader, Button, EmptyState, ErrorNote, Modal, Pill, StatusPill, Textarea, TextField, CustomerCard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (!d()) {
      @if (error()) {<pc-error-note [message]="error()" />} @else {<pc-page-loader />}
    } @else {
      <div class="flex flex-col gap-4">
        <a pcLink="/admin/customers" class="inline-flex items-center gap-1 text-sm font-semibold text-peacock"><svg [pcIcon]="ArrowLeft" class="h-4 w-4" />All accounts</a>
        <pc-page-header [title]="d()!.name || 'No name yet'" [sub]="sub()" [withActions]="true">
          @if (!d()!.is_admin) {<button actions pcButton variant="secondary" (click)="openEdit()"><svg [pcIcon]="Pencil" class="h-4 w-4" />Edit</button>}
          <button actions pcButton variant="secondary" (click)="signOut()" [disabled]="!d()!.sessions.length"><svg [pcIcon]="LogOut" class="h-4 w-4" />Sign out everywhere</button>
          @if (!d()!.is_admin) {
            @if (d()!.is_active) {
              <button actions pcButton variant="danger" (click)="blocking.set(true)"><svg [pcIcon]="ShieldOff" class="h-4 w-4" />Block</button>
            } @else {
              <button actions pcButton (click)="unblock()"><svg [pcIcon]="ShieldCheck" class="h-4 w-4" />Unblock</button>
            }
          }
        </pc-page-header>
        <div class="flex flex-wrap items-center gap-2">
          @if (d()!.is_active) {<pc-pill tone="green">Active</pc-pill>} @else {<pc-pill tone="red">Blocked</pc-pill>}
          @if (d()!.is_admin) {<pc-pill tone="blue">Staff: manage in&ngsp;<a pcLink="/admin/staff" class="underline">Staff and roles</a></pc-pill>}
          @if (d()!.seller; as s) {<a [pcLink]="'/admin/sellers/' + s.id"><pc-pill tone="gray">Seller: {{ s.name }} ({{ s.status }})</pc-pill></a>}
        </div>
        <pc-error-note [message]="error() && !editing() ? error() : null" />

        <div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <pc-stat label="Orders" [value]="d()!.stats.orders" />
          <pc-stat label="Spent (after refunds)" [value]="rupees(d()!.stats.spent)" />
          <pc-stat label="Returns" [value]="d()!.stats.returns" />
          <pc-stat label="Support requests" [value]="d()!.stats.tickets" [hint]="d()!.stats.open_tickets ? d()!.stats.open_tickets + ' open' : undefined" />
          <pc-stat label="Wishlist" [value]="d()!.stats.wishlist" />
          <pc-stat label="Reviews" [value]="d()!.stats.reviews" />
        </div>

        <div class="grid gap-4 lg:grid-cols-2">
          <section pcCustomerCard title="Account">
            <dl class="grid grid-cols-[150px_1fr] gap-y-1.5 text-[15px]">
              <dt class="text-ink-faint">Joined</dt><dd>{{ date(d()!.created_at) }}</dd>
              <dt class="text-ink-faint">Last sign-in</dt><dd>{{ d()!.last_login_at ? date(d()!.last_login_at) : "Never" }}</dd>
              <dt class="text-ink-faint">Terms accepted</dt><dd>{{ d()!.terms_accepted_at ? date(d()!.terms_accepted_at) : "Not yet (account made by staff)" }}</dd>
              <dt class="text-ink-faint">Offers by message</dt><dd>{{ d()!.marketing_opt_in ? "Yes, opted in" : "No" }}</dd>
            </dl>
          </section>
          <section pcCustomerCard [title]="'Signed in on ' + d()!.sessions.length + ' device(s)'">
            @if (d()!.sessions.length) {
              <ul class="divide-y divide-line text-sm">@for (s of d()!.sessions; track $index) {<li class="flex justify-between py-1.5"><span>{{ s.device }}</span><span class="text-ink-faint">since {{ date(s.signed_in_at) }}</span></li>}</ul>
            } @else {<p class="text-sm text-ink-faint">Not signed in anywhere.</p>}
          </section>
        </div>

        <section pcCustomerCard title="Addresses">
          @if (d()!.addresses.length) {
            <ul class="grid gap-2 sm:grid-cols-2">
              @for (a of d()!.addresses; track a.id) {
                <li class="rounded-lg border border-line p-3 text-sm">
                  <p class="font-semibold">{{ a.name }} <span class="font-normal text-ink-faint">· {{ a.phone }}</span>{{ " " }}@if (a.is_default) {<pc-pill tone="green">Default</pc-pill>}</p>
                  <p class="text-ink-soft">{{ a.text }}</p>
                </li>
              }
            </ul>
          } @else {<p class="text-sm text-ink-faint">No saved addresses.</p>}
        </section>

        <section pcCustomerCard title="Recent orders">
          @if (canOrders()) {<a action [pcLink]="'/admin/orders?customer_id=' + d()!.id" class="text-sm font-semibold text-peacock">All orders</a>}
          @if (d()!.orders.length) {
            <pc-table [head]="['Order', 'Placed', 'Items', 'Payment', 'Total', 'Packages']">
              @for (o of d()!.orders; track o.id) {
                <tr>
                  <td class="px-4 py-2">@if (canOrders()) {<a [pcLink]="'/admin/orders/' + o.id" class="font-semibold text-peacock">{{ o.number }}</a>} @else {{{ o.number }}}</td>
                  <td class="px-4 py-2 text-sm">{{ date(o.created_at) }}</td>
                  <td class="px-4 py-2">{{ o.item_count }}</td>
                  <td class="px-4 py-2 text-sm">{{ o.payment_method === "cod" ? "Cash on delivery" : "Online" }}</td>
                  <td class="px-4 py-2">{{ rupees(o.grand_total) }}</td>
                  <td class="px-4 py-2"><span class="flex flex-wrap gap-1">@for (s of o.sub_statuses; track $index) {<pc-status-pill [status]="s" />}</span></td>
                </tr>
              }
            </pc-table>
          } @else {<pc-empty-state title="No orders yet" [hasAction]="false" />}
        </section>

        <div class="grid gap-4 lg:grid-cols-2">
          <section pcCustomerCard title="Returns">
            @if (d()!.returns.length) {
              <ul class="divide-y divide-line text-sm">@for (r of d()!.returns; track r.id) {
                <li class="flex justify-between gap-2 py-1.5">
                  <span>{{ r.number }} · {{ r.reason_label }}@if (canOrders()) { · <a [pcLink]="'/admin/orders/' + r.order_id" class="text-peacock">order</a>}</span>
                  <span class="shrink-0"><pc-status-pill [status]="r.status" /></span>
                </li>
              }</ul>
            } @else {<p class="text-sm text-ink-faint">No returns.</p>}
          </section>
          <section pcCustomerCard title="Support requests">
            @if (d()!.tickets.length) {
              <ul class="divide-y divide-line text-sm">@for (t of d()!.tickets; track t.id) {
                <li class="flex justify-between gap-2 py-1.5">
                  <span class="truncate">@if (canSupport()) {<a [pcLink]="'/admin/support/' + t.id" class="font-semibold text-peacock">{{ t.number }}</a>} @else {{{ t.number }}} · {{ t.subject }}</span>
                  <span class="shrink-0"><pc-status-pill [status]="t.status" /></span>
                </li>
              }</ul>
            } @else {<p class="text-sm text-ink-faint">No support requests.</p>}
          </section>
        </div>

        <section pcCustomerCard title="History">
          @if (d()!.history.length) {
            <ul class="divide-y divide-line text-sm">@for (h of d()!.history; track $index) {
              <li class="flex justify-between gap-2 py-1.5">
                <span><b>{{ actions[h.action] || h.action }}</b>@if (h.detail) {<span class="text-ink-soft"> · {{ h.detail }}</span>}@if (h.by) {<span class="text-ink-faint"> · by {{ h.by }}</span>}</span>
                <span class="shrink-0 text-ink-faint">{{ date(h.at) }}</span>
              </li>
            }</ul>
          } @else {<p class="text-sm text-ink-faint">No staff changes yet.</p>}
        </section>

        <pc-modal [open]="editing()" (close)="editing.set(false)" title="Edit account">
          <form (submit)="saveEdit($event)" class="flex flex-col gap-3">
            <pc-error-note [message]="error()" />
            <pc-text-field label="Full name" [value]="f().name" (valueChange)="setF({ name: $event })" [error]="fieldErrors()['name']" [required]="true" />
            <pc-text-field label="Mobile number" type="tel" [value]="f().phone" (valueChange)="setF({ phone: $event })" [error]="fieldErrors()['phone']"
              hint="Changing it signs the customer out; they sign in again with a code sent to the new number." [required]="true" />
            <pc-text-field label="Email" type="email" [value]="f().email" (valueChange)="setF({ email: $event })" [error]="fieldErrors()['email']" hint="Leave empty to remove" />
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="h-4 w-4 accent-peacock" [checked]="f().marketing" (change)="setF({ marketing: $any($event.target).checked })" />Agrees to receive offers</label>
            <button pcButton type="submit" [loading]="busy()">Save</button>
          </form>
        </pc-modal>
        <pc-modal [open]="blocking()" (close)="blocking.set(false)" [title]="'Block ' + (d()!.name || d()!.phone) + '?'">
          <p class="mb-2 text-sm text-ink-soft">They are signed out at once and cannot sign in or order until unblocked.</p>
          <textarea pcTextarea [value]="reason()" (input)="reason.set($any($event.target).value)" placeholder="Reason (kept in the audit log)" aria-label="Reason"></textarea>
          <button pcButton class="mt-3" variant="buy" [loading]="busy()" [disabled]="reason().trim().length < 5" (click)="block()">Block account</button>
        </pc-modal>
      </div>
    }
  `,
})
export class AdminCustomersIdPage {
  readonly id = input.required<string>();
  private readonly toast = inject(Toast);
  private readonly admin = inject(AdminContext);
  protected readonly canOrders = computed(() => this.admin.can("orders"));
  protected readonly canSupport = computed(() => this.admin.can("support"));
  protected readonly ArrowLeft = ArrowLeft;
  protected readonly LogOut = LogOut;
  protected readonly Pencil = Pencil;
  protected readonly ShieldOff = ShieldOff;
  protected readonly ShieldCheck = ShieldCheck;
  protected readonly date = date;
  protected readonly rupees = rupees;
  protected readonly actions = ACTIONS;
  protected readonly d = signal<Detail | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly editing = signal(false);
  protected readonly f = signal({ name: "", phone: "", email: "", marketing: false });
  protected readonly fieldErrors = signal<Record<string, string>>({});
  protected readonly blocking = signal(false);
  protected readonly reason = signal("");
  protected readonly busy = signal(false);
  protected readonly sub = computed(() => { const d = this.d()!; return [d.phone && `+91 ${d.phone}`, d.email].filter(Boolean).join(" · "); });

  constructor() {
    effect(() => {
      this.id();
      this.load();
    });
  }

  private load(): void {
    api<Detail>(`/api/admin/customers/${this.id()}`).then((d) => this.d.set(d)).catch((e) => this.error.set(e instanceof ApiError ? e.message : "Could not load"));
  }

  protected setF(x: Partial<{ name: string; phone: string; email: string; marketing: boolean }>): void {
    this.f.update((f) => ({ ...f, ...x }));
  }

  protected openEdit(): void {
    const d = this.d();
    if (!d) return;
    this.f.set({ name: d.name, phone: d.phone ?? "", email: d.email ?? "", marketing: d.marketing_opt_in });
    this.fieldErrors.set({});
    this.error.set(null);
    this.editing.set(true);
  }

  protected async saveEdit(e: Event): Promise<void> {
    e.preventDefault();
    const d = this.d();
    if (!d) return;
    const f = this.f();
    this.busy.set(true);
    this.error.set(null);
    try {
      const body: Record<string, unknown> = { name: f.name, phone: f.phone, marketing_opt_in: f.marketing };
      if (f.email.trim()) body["email"] = f.email.trim();
      else if (d.email) body["clear_email"] = true;
      this.d.set(await api<Detail>(`/api/admin/customers/${this.id()}`, { method: "PATCH", body }));
      this.toast.show(f.phone.replace(/\D/g, "").slice(-10) !== d.phone ? "Saved. The new mobile number must sign in again." : "Saved");
      this.editing.set(false);
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : "Could not save");
      if (err instanceof ApiError) this.fieldErrors.set(err.fields ?? {});
    } finally {
      this.busy.set(false);
    }
  }

  protected async signOut(): Promise<void> {
    if (!window.confirm("Sign this person out on every device? They can sign in again with a one-time code.")) return;
    const r = await api<{ sessions: number }>(`/api/admin/customers/${this.id()}/sign-out`, { method: "POST" }).catch((e) => {
      this.toast.show(e instanceof ApiError ? e.message : "Failed", "error");
      return null;
    });
    if (r) {
      this.toast.show(`Signed out of ${r.sessions} device(s)`);
      this.load();
    }
  }

  protected async block(): Promise<void> {
    this.busy.set(true);
    try {
      await api(`/api/admin/customers/${this.id()}/block`, { method: "POST", body: { reason: this.reason() } });
      this.toast.show("Account blocked and signed out everywhere");
      this.blocking.set(false);
      this.reason.set("");
      this.load();
    } catch (e) {
      this.toast.show(e instanceof ApiError ? e.message : "Failed", "error");
    } finally {
      this.busy.set(false);
    }
  }

  protected async unblock(): Promise<void> {
    await api(`/api/admin/customers/${this.id()}/unblock`, { method: "POST" }).then(() => { this.toast.show("Account unblocked"); this.load(); }).catch(quietly);
  }
}
