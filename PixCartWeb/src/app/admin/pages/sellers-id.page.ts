/* Admin → one seller: KYC details and documents, approve / send back / suspend, edit details, commission. Port of frontend/src/app/admin/sellers/[id]/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from "@angular/core";
import { FileText, Pencil } from "lucide-angular";
import { AdminContext } from "../../core/admin";
import { api, ApiError, downloadBlob } from "../../core/api";
import { dateTime, pct, STATE_OPTIONS } from "../../core/format";
import type { SellerProfile } from "../../core/types";
import { PageHeader } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Field, Input, Modal, Select, StatusPill, Textarea, TextField, Toast } from "../../shared/ui/ui";
import { RiskBrief } from "../shared/ai";

type Edit = "business" | "pickup-address" | "bank" | "grievance-officer";

const EDITS: [Edit, string][] = [["business", "Business"], ["pickup-address", "Pickup"], ["bank", "Bank"], ["grievance-officer", "Grievance"]];
const BUSINESS_TYPES = [["proprietorship", "Sole proprietorship"], ["individual", "Individual"], ["partnership", "Partnership firm"], ["llp", "LLP"], ["private_limited", "Private limited company"], ["public_limited", "Public limited company"]];

@Component({
  selector: "pc-admin-sellers-id-page",
  imports: [PageHeader, Icon, PcLink, PageLoader, Button, ErrorNote, Field, Input, Modal, Select, StatusPill, Textarea, TextField, RiskBrief],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (!s()) {
      @if (error()) {<pc-error-note [message]="error()" />} @else {<pc-page-loader />}
    } @else {
      @let s = this.seller()!;
      <div class="flex flex-col gap-4">
        <pc-page-header [title]="s.display_name" sub="Check the documents against the details before approving." [withActions]="true">
          @if (s.status === "submitted" || s.status === "suspended" || s.status === "rejected") {<button actions pcButton (click)="act('approve', undefined, 'Seller approved')" [loading]="busy()">{{ s.status === "suspended" ? "Reactivate seller" : "Approve seller" }}</button>}
          @if (s.status === "submitted" || s.status === "approved") {<button actions pcButton variant="secondary" (click)="dialog.set('reject')">Send back for changes</button>}
          @if (s.status === "approved") {<button actions pcButton variant="danger" (click)="dialog.set('suspend')">Suspend</button>}
        </pc-page-header>
        <pc-error-note [message]="error()" />
        <div class="flex items-center gap-3"><pc-status-pill [status]="s.status" />@if (s.rejection_reason) {<span class="text-vermilion">{{ s.rejection_reason }}</span>}</div>
        <div class="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
          <section class="rounded-xl bg-white p-5">
            <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 class="text-lg font-semibold">KYC details</h2>
              <div class="flex flex-wrap gap-1">
                @for (e of edits; track e[0]) {<button pcButton size="sm" variant="ghost" (click)="openEdit(e[0])"><svg [pcIcon]="Pencil" class="h-3.5 w-3.5" />{{ e[1] }}</button>}
              </div>
            </div>
            <dl class="grid grid-cols-[170px_1fr] gap-y-2 text-[15px]">
              <div class="contents"><dt class="text-ink-faint">Legal name</dt><dd>{{ s.legal_name || "—" }}</dd></div>
              <div class="contents"><dt class="text-ink-faint">Business type</dt><dd>{{ s.business_type.replace(underscores, " ") || "—" }}</dd></div>
              <div class="contents"><dt class="text-ink-faint">GSTIN</dt><dd><span class="font-mono">{{ s.gstin }}</span></dd></div>
              <div class="contents"><dt class="text-ink-faint">PAN</dt><dd><span class="font-mono">{{ s.pan }}</span></dd></div>
              <div class="contents"><dt class="text-ink-faint">PAN in GSTIN matches</dt><dd>{{ s.gstin && s.gstin.slice(2, 12) === s.pan ? "Yes" : "No" }}</dd></div>
              <div class="contents"><dt class="text-ink-faint">Contact</dt><dd>{{ s.contact_email }}, {{ s.contact_phone }}</dd></div>
              <div class="contents"><dt class="text-ink-faint">Account owner</dt><dd>@if (s.owner) {<a [pcLink]="'/admin/customers/' + s.owner.id" class="font-semibold text-peacock hover:underline">{{ s.owner.name || "—" }}, {{ s.owner.phone ?? s.owner.email }}</a>} @else {—}</dd></div>
              <div class="contents"><dt class="text-ink-faint">Pickup address</dt><dd>{{ s.pickup.line1 }}{{ s.pickup.line2 ? ", " + s.pickup.line2 : "" }}, {{ s.pickup.city }}, {{ s.pickup.state }} {{ s.pickup.pincode }}</dd></div>
              <div class="contents"><dt class="text-ink-faint">Bank account</dt><dd><span>{{ s.bank.holder_name }}, <span class="font-mono">{{ s.bank.account_number }}</span>, IFSC <span class="font-mono">{{ s.bank.ifsc }}</span></span></dd></div>
              <div class="contents"><dt class="text-ink-faint">Grievance officer</dt><dd>{{ s.grievance.name }}, {{ s.grievance.email }}, {{ s.grievance.phone }}</dd></div>
              <div class="contents"><dt class="text-ink-faint">Submitted</dt><dd>{{ dateTime(s.submitted_at) || "—" }}</dd></div>
              <div class="contents"><dt class="text-ink-faint">Approved</dt><dd>{{ dateTime(s.approved_at) || "—" }}</dd></div>
            </dl>
          </section>
          <div class="flex flex-col gap-4">
            @if (s.status === "approved") {<pc-risk-brief [path]="'/api/admin/ai/briefs/seller/' + id()" title="Seller health (last 90 days)" />}
            <section class="rounded-xl bg-white p-5">
              <h2 class="mb-3 text-lg font-semibold">Documents</h2>
              @if (s.documents.length === 0) {
                <p class="text-ink-faint">None uploaded</p>
              } @else {
                <ul class="flex flex-col gap-2">
                  @for (d of s.documents; track d.kind) {
                    <li>
                      <button (click)="openDoc(d.kind)" class="flex items-center gap-2 font-semibold text-peacock hover:underline">
                        <svg [pcIcon]="FileText" class="h-4 w-4" /> {{ d.kind.replace(underscores, " ") }}
                      </button>
                      <p class="text-xs text-ink-faint">{{ d.filename }}, {{ round(d.size_bytes / 1024) }} KB</p>
                    </li>
                  }
                </ul>
              }
            </section>
            <section class="rounded-xl bg-white p-5">
              <h2 class="mb-1 text-lg font-semibold">Commission</h2>
              <p class="mb-2 text-sm text-ink-soft">Leave empty to use each category's rate. A value here applies to all of this seller's sales.</p>
              <form class="flex gap-2" (submit)="saveCommission($event)">
                <input pcInput [value]="commission()" (input)="commission.set($any($event.target).value)" placeholder="e.g. 8.5" inputmode="decimal" class="w-28" aria-label="Commission percent" />
                <span class="self-center">%</span>
                <button pcButton type="submit" variant="secondary" [loading]="busy()">Save</button>
              </form>
              @if (s.commission_bps_override !== null) {<p class="mt-1 text-sm">Current: {{ pct(s.commission_bps_override) }}</p>}
            </section>
            <section class="rounded-xl bg-white p-5">
              <h2 class="mb-2 text-lg font-semibold">This seller's</h2>
              <ul class="flex flex-col gap-1.5 font-semibold text-peacock">
                <li><a [pcLink]="'/admin/products?status=&seller_id=' + s.id" class="hover:underline">Listings</a></li>
                <li><a [pcLink]="'/admin/orders?seller_id=' + s.id" class="hover:underline">Orders</a></li>
                <li><a [pcLink]="'/admin/returns?seller_id=' + s.id" class="hover:underline">Returns</a></li>
                <li><a [pcLink]="'/admin/payouts?seller_id=' + s.id" class="hover:underline">Payouts</a></li>
              </ul>
            </section>
          </div>
        </div>
        <pc-modal [open]="edit() !== null" (close)="edit.set(null)" [title]="editTitle()" [wide]="true">
          <form (submit)="saveEdit($event)" class="grid gap-3 sm:grid-cols-2">
            <pc-error-note [message]="editErr()" />
            @switch (edit()) {
              @case ("business") {
                <pc-text-field label="Store name" [value]="v('display_name')" (valueChange)="setF('display_name', $event)" [error]="fieldErr()['display_name']" [required]="true" />
                <pc-text-field label="Legal business name" [value]="v('legal_name')" (valueChange)="setF('legal_name', $event)" [error]="fieldErr()['legal_name']" [required]="true" />
                <pc-field label="Business type" for="ebt"><select pcSelect id="ebt" (change)="setF('business_type', $any($event.target).value)">
                  @for (o of businessTypes; track o[0]) {<option [value]="o[0]" [selected]="o[0] === v('business_type')">{{ o[1] }}</option>}
                </select></pc-field>
                <pc-text-field label="GSTIN" [value]="v('gstin')" (valueChange)="setF('gstin', $event)" [error]="fieldErr()['gstin']" [maxlength]="15" class="uppercase" [required]="true" />
                <pc-text-field label="PAN" [value]="v('pan')" (valueChange)="setF('pan', $event)" [error]="fieldErr()['pan']" [maxlength]="10" class="uppercase" [required]="true" hint="Must match characters 3 to 12 of the GSTIN" />
                <pc-text-field label="Business email" type="email" [value]="v('contact_email')" (valueChange)="setF('contact_email', $event)" [error]="fieldErr()['contact_email']" [required]="true" />
                <pc-text-field label="Business mobile" [value]="v('contact_phone')" (valueChange)="setF('contact_phone', $event)" [error]="fieldErr()['contact_phone']" [required]="true" />
                <pc-field label="About the store" class="sm:col-span-2"><textarea pcTextarea [value]="v('description')" (input)="setF('description', $any($event.target).value)" maxlength="2000"></textarea></pc-field>
              }
              @case ("pickup-address") {
                <pc-text-field class="sm:col-span-2" label="Building, street" [value]="v('line1')" (valueChange)="setF('line1', $event)" [error]="fieldErr()['line1']" [required]="true" />
                <pc-text-field class="sm:col-span-2" label="Area (optional)" [value]="v('line2')" (valueChange)="setF('line2', $event)" [error]="fieldErr()['line2']" />
                <pc-text-field label="City" [value]="v('city')" (valueChange)="setF('city', $event)" [error]="fieldErr()['city']" [required]="true" />
                <pc-text-field label="PIN code" [value]="v('pincode')" (valueChange)="setF('pincode', $event)" [error]="fieldErr()['pincode']" [maxlength]="6" [required]="true" />
                <pc-field label="State" for="est"><select pcSelect id="est" (change)="setF('state_code', $any($event.target).value)">
                  @for (o of states; track o[0]) {<option [value]="o[0]" [selected]="o[0] === v('state_code')">{{ o[1] }}</option>}
                </select></pc-field>
              }
              @case ("bank") {
                <p class="rounded-lg bg-marigold-light p-3 text-sm sm:col-span-2">Payouts go to this account from the next payout. Check a cancelled cheque or bank letter first. The seller is told about the change.</p>
                <pc-text-field label="Account holder name" [value]="v('holder_name')" (valueChange)="setF('holder_name', $event)" [error]="fieldErr()['holder_name']" [required]="true" />
                <pc-text-field label="IFSC" [value]="v('ifsc')" (valueChange)="setF('ifsc', $event)" [error]="fieldErr()['ifsc']" [maxlength]="11" class="uppercase" [required]="true" />
                <pc-text-field label="Account number" [value]="v('account_number')" (valueChange)="setF('account_number', $event)" [error]="fieldErr()['account_number']" inputmode="numeric" autocomplete="off" [required]="true" />
                <pc-text-field label="Confirm account number" [value]="v('confirm_account_number')" (valueChange)="setF('confirm_account_number', $event)" [error]="fieldErr()['confirm_account_number']" inputmode="numeric" autocomplete="off" [required]="true" />
                <p class="text-sm text-ink-soft sm:col-span-2">Changing where money goes needs your password{{ totp() ? " and authenticator code" : "" }}. Pending payouts keep the old account until Finance confirms the new one.</p>
                <pc-text-field label="Your password" type="password" autocomplete="current-password" [value]="v('password')" (valueChange)="setF('password', $event)" [error]="fieldErr()['password']" [required]="true" />
                @if (totp()) {<pc-text-field label="Authenticator code" inputmode="numeric" [maxlength]="8" [value]="v('totp')" (valueChange)="setF('totp', $event)" [error]="fieldErr()['totp']" [required]="true" />}
              }
              @case ("grievance-officer") {
                <pc-text-field label="Name" [value]="v('name')" (valueChange)="setF('name', $event)" [error]="fieldErr()['name']" [required]="true" />
                <pc-text-field label="Email" type="email" [value]="v('email')" (valueChange)="setF('email', $event)" [error]="fieldErr()['email']" [required]="true" />
                <pc-text-field label="Mobile" [value]="v('phone')" (valueChange)="setF('phone', $event)" [error]="fieldErr()['phone']" [required]="true" />
              }
            }
            <div class="sm:col-span-2"><button pcButton type="submit" [loading]="busy()">Save</button></div>
          </form>
        </pc-modal>
        <pc-modal [open]="dialog() !== null" (close)="dialog.set(null)" [title]="dialog() === 'suspend' ? 'Suspend seller' : 'Send back for changes'">
          <p class="mb-2 text-ink-soft">{{ dialog() === "suspend" ? "Their listings are hidden at once. Existing orders continue." : "The seller sees this message and can fix and resubmit." }}</p>
          <textarea pcTextarea [value]="reason()" (input)="reason.set($any($event.target).value)" placeholder="Explain what needs to change" aria-label="Reason"></textarea>
          <button pcButton class="mt-3" [variant]="dialog() === 'suspend' ? 'buy' : 'primary'" [disabled]="reason().trim().length < 5" [loading]="busy()"
            (click)="act(dialog() === 'suspend' ? 'suspend' : 'reject', { reason: reason() }, dialog() === 'suspend' ? 'Seller suspended' : 'Sent back to seller')">
            {{ dialog() === "suspend" ? "Suspend seller" : "Send back" }}
          </button>
        </pc-modal>
      </div>
    }
  `,
})
export class AdminSellersIdPage {
  readonly id = input.required<string>();
  private readonly toast = inject(Toast);
  private readonly admin = inject(AdminContext);
  protected readonly FileText = FileText;
  protected readonly Pencil = Pencil;
  protected readonly dateTime = dateTime;
  protected readonly pct = pct;
  protected readonly round = Math.round;
  protected readonly underscores = /_/g;
  protected readonly edits = EDITS;
  protected readonly businessTypes = BUSINESS_TYPES;
  protected readonly states = STATE_OPTIONS;
  protected readonly seller = signal<SellerProfile | null>(null);
  protected readonly s = this.seller.asReadonly();
  protected readonly error = signal<string | null>(null);
  protected readonly dialog = signal<"reject" | "suspend" | null>(null);
  protected readonly reason = signal("");
  protected readonly commission = signal("");
  protected readonly busy = signal(false);
  protected readonly edit = signal<Edit | null>(null);
  protected readonly f = signal<Record<string, string>>({});
  protected readonly fieldErr = signal<Record<string, string>>({});
  protected readonly editErr = signal<string | null>(null);
  protected readonly totp = computed(() => !!this.admin.me()?.totp_enabled);
  protected readonly editTitle = computed(() => {
    const e = this.edit();
    return e === "business" ? "Business details" : e === "pickup-address" ? "Pickup address" : e === "bank" ? "Bank account for payouts" : "Grievance officer";
  });

  constructor() {
    effect(() => {
      this.id();
      this.load();
    });
  }

  private load(): void {
    api<SellerProfile>(`/api/admin/sellers/${this.id()}`)
      .then((x) => { this.seller.set(x); this.commission.set(x.commission_bps_override !== null ? String(x.commission_bps_override / 100) : ""); })
      .catch((e) => this.error.set(e.message));
  }

  protected v(k: string): string {
    return this.f()[k] ?? "";
  }

  protected setF(k: string, v: string): void {
    this.f.update((f) => ({ ...f, [k]: v }));
  }

  protected openEdit(kind: Edit): void {
    const s = this.seller();
    if (!s) return;
    this.editErr.set(null);
    this.fieldErr.set({});
    this.f.set(kind === "business" ? { display_name: s.display_name, legal_name: s.legal_name, business_type: s.business_type, gstin: s.gstin ?? "", pan: s.pan ?? "", contact_email: s.contact_email, contact_phone: s.contact_phone, description: s.description }
      : kind === "pickup-address" ? { line1: s.pickup.line1, line2: s.pickup.line2, city: s.pickup.city, state_code: s.pickup.state_code || "33", pincode: s.pickup.pincode }
      : kind === "bank" ? { holder_name: s.bank.holder_name, ifsc: s.bank.ifsc, account_number: "", confirm_account_number: "" }
      : { name: s.grievance.name, email: s.grievance.email, phone: s.grievance.phone });
    this.edit.set(kind);
  }

  protected async saveEdit(e: Event): Promise<void> {
    e.preventDefault();
    const edit = this.edit(), s = this.seller();
    if (!edit || !s) return;
    this.busy.set(true);
    this.editErr.set(null);
    this.fieldErr.set({});
    try {
      const r = await api<SellerProfile>(`/api/admin/sellers/${this.id()}/${edit}`, { method: "PUT", body: this.f() });
      this.seller.set({ ...s, ...r, owner: s.owner, product_counts: s.product_counts });
      this.toast.show(edit === "bank" ? "Bank account changed. The seller has been told." : "Saved");
      this.edit.set(null);
    } catch (err) {
      this.editErr.set(err instanceof ApiError ? err.message : "Could not save");
      if (err instanceof ApiError) this.fieldErr.set(err.fields ?? {});
    } finally {
      this.busy.set(false);
    }
  }

  protected saveCommission(e: Event): void {
    e.preventDefault();
    const c = this.commission();
    void this.act("commission", { commission_bps_override: c === "" ? null : Math.round(parseFloat(c) * 100) }, "Commission saved");
  }

  protected async act(path: string, body?: object, msg = "Updated"): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await api<SellerProfile>(`/api/admin/sellers/${this.id()}/${path}`, { method: path === "commission" ? "PUT" : "POST", body });
      this.seller.update((cur) => (cur ? { ...cur, ...r, owner: cur.owner, product_counts: cur.product_counts } : r));
      this.toast.show(msg);
      this.dialog.set(null);
      this.reason.set("");
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Failed");
    } finally {
      this.busy.set(false);
    }
  }

  protected async openDoc(kind: string): Promise<void> {
    try {
      const blob = await downloadBlob(`/api/admin/sellers/${this.id()}/documents/${kind}`);
      window.open(URL.createObjectURL(blob), "_blank", "noopener");
    } catch {
      this.toast.show("Could not open the document", "error");
    }
  }
}
