/*
 * Admin → Product reports: what customers reported from product pages (wrong information, fakes, unsafe or banned
 * items, misleading prices). Resolve, take the listing down, or dismiss. Port of frontend/src/app/admin/product-reports/page.tsx.
 */

import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from "@angular/core";
import { ExternalLink } from "lucide-angular";
import { api, ApiError, latestOnly } from "../../core/api";
import { dateTime } from "../../core/format";
import { PageHeader, Tabs } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, Input, Modal, Pagination, Select, Textarea, Toast } from "../../shared/ui/ui";

type Rep = {
  id: string; product_id: string; product: string; slug: string; product_status: string; seller: string; seller_id: string; customer: string; phone: string;
  reason: string; reason_label: string; note: string; url: string; status: string; admin_note: string; seller_note: string; open_for_product: number;
  at: string; resolved_at: string | null;
};
type Res = { items: Rep[]; total: number; reasons: Record<string, string>; counts: Record<string, number> };
type Form = { status: "resolved" | "dismissed"; note: string; takeDown: boolean; notify: boolean };

@Component({
  selector: "pc-admin-product-reports-page",
  imports: [PageHeader, Tabs, Icon, PcLink, PageLoader, Button, EmptyState, Input, Modal, Pagination, Select, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <pc-page-header title="Product reports" sub="Customers report wrong information, fakes, unsafe or banned items and misleading prices from the product page. Sellers see each report without the customer's details and can answer." />
    <pc-tabs [value]="status()" (valueChange)="status.set($event); page.set(1)" [items]="tabs()" />
    <div class="mb-3 flex flex-wrap gap-2">
      <input pcInput placeholder="Product, seller or details" [value]="q()" (input)="q.set($any($event.target).value); page.set(1)" class="max-w-xs" aria-label="Search reports" />
      <select pcSelect (change)="reason.set($any($event.target).value); page.set(1)" class="w-auto" aria-label="Reason">
        <option value="" [selected]="reason() === ''">Every reason</option>
        @for (r of reasons(); track r[0]) {<option [value]="r[0]" [selected]="reason() === r[0]">{{ r[1] }}</option>}
      </select>
    </div>
    @if (!data()) {
      <pc-page-loader />
    } @else if (data()!.items.length === 0) {
      <pc-empty-state [title]="status() === 'open' ? 'No open reports' : 'Nothing here'" body="Reports appear here as customers send them." [hasAction]="false" />
    } @else {
      <div class="flex flex-col gap-3">
        @for (r of data()!.items; track r.id) {
          <section class="rounded-xl bg-white p-4" data-testid="product-report">
            <div class="flex flex-wrap items-center gap-2">
              <span [class]="serious.includes(r.reason) ? 'rounded-full px-2 py-0.5 text-xs font-semibold bg-vermilion-light text-vermilion' : 'rounded-full px-2 py-0.5 text-xs font-semibold bg-marigold-light text-ink'">{{ r.reason_label }}</span>
              <a [pcLink]="'/admin/products/' + r.product_id" class="font-semibold hover:text-peacock">{{ r.product }}</a>
              <a [href]="'/p/' + r.slug" target="_blank" rel="noopener noreferrer" class="text-ink-faint hover:text-peacock" aria-label="Open the product page"><svg [pcIcon]="ExternalLink" class="h-4 w-4" /></a>
              <span class="text-xs text-ink-faint">listing {{ r.product_status }}</span>
              @if (r.open_for_product > 1) {<span class="rounded-full bg-vermilion px-2 py-0.5 text-xs font-semibold text-white">{{ r.open_for_product }} open reports on this listing</span>}
            </div>
            <p class="mt-0.5 text-sm text-ink-faint">
              Seller <a [pcLink]="'/admin/sellers/' + r.seller_id" class="text-peacock hover:underline">{{ r.seller }}</a> · reported by {{ r.customer }}{{ r.phone ? " (" + r.phone + ")" : "" }} · {{ dateTime(r.at) }}
            </p>
            @if (r.note) {<p class="mt-2 whitespace-pre-line">{{ r.note }}</p>}
            @if (r.url) {<p class="mt-1 text-sm">Seen at: <a [href]="r.url" target="_blank" rel="noopener noreferrer nofollow" class="break-all text-peacock hover:underline">{{ r.url }}</a></p>}
            @if (r.seller_note) {<p class="mt-2 rounded-lg bg-mist p-2 text-sm"><span class="font-semibold">Seller's answer:</span> {{ r.seller_note }}</p>}
            @if (r.admin_note) {<p class="mt-2 rounded-lg bg-peacock-light p-2 text-sm"><span class="font-semibold">Staff note:</span> {{ r.admin_note }}</p>}
            @if (r.status === "open") {
              <div class="mt-3 flex flex-wrap gap-2">
                <button pcButton size="sm" (click)="act(r, { status: 'resolved', note: '', takeDown: false, notify: true })">Resolve</button>
                <button pcButton size="sm" variant="danger" [disabled]="r.product_status !== 'approved'" (click)="act(r, { status: 'resolved', note: '', takeDown: true, notify: true })">Take listing down</button>
                <button pcButton size="sm" variant="ghost" (click)="act(r, { status: 'dismissed', note: '', takeDown: false, notify: false })">Dismiss</button>
              </div>
            }
          </section>
        }
      </div>
    }
    @if (data()) {<pc-pagination [page]="page()" [pageSize]="30" [total]="data()!.total" (pageChange)="page.set($event)" />}
    <pc-modal [open]="acting() !== null" (close)="acting.set(null)" [title]="form().status === 'dismissed' ? 'Dismiss this report' : form().takeDown ? 'Take the listing down' : 'Resolve this report'">
      <form (submit)="resolve($event)" class="flex flex-col gap-3">
        <p class="text-sm text-ink-soft">{{ acting()?.product }} · {{ acting()?.reason_label }}</p>
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-semibold">Note {{ form().takeDown ? "(the seller sees this as the reason)" : "(optional)" }}</span>
          <textarea pcTextarea rows="3" maxlength="2000" [value]="form().note" (input)="setForm({ note: $any($event.target).value })" [placeholder]="form().takeDown ? 'e.g. The brand confirmed these are not genuine' : 'What was done'"></textarea>
        </label>
        @if (form().status === "resolved") {
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="accent-peacock" [checked]="form().takeDown" [disabled]="acting()?.product_status !== 'approved'" (change)="setForm({ takeDown: $any($event.target).checked })" /> Take the listing off the store</label>
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="accent-peacock" [checked]="form().notify || form().takeDown" [disabled]="form().takeDown" (change)="setForm({ notify: $any($event.target).checked })" /> Tell the seller</label>
        }
        <button pcButton type="submit" [loading]="busy()" [variant]="form().takeDown ? 'danger' : 'primary'" class="self-start">{{ form().status === "dismissed" ? "Dismiss" : form().takeDown ? "Take down and resolve" : "Resolve" }}</button>
      </form>
    </pc-modal>
  `,
})
export class AdminProductReportsPage {
  private readonly toast = inject(Toast);
  protected readonly ExternalLink = ExternalLink;
  protected readonly dateTime = dateTime;
  protected readonly serious = ["counterfeit", "unsafe", "prohibited"];
  protected readonly status = signal("open");
  protected readonly reason = signal("");
  protected readonly q = signal("");
  protected readonly page = signal(1);
  protected readonly data = signal<Res | null>(null);
  protected readonly acting = signal<Rep | null>(null);
  protected readonly form = signal<Form>({ status: "resolved", note: "", takeDown: false, notify: true });
  protected readonly busy = signal(false);
  private readonly track = latestOnly();
  protected readonly reasons = computed(() => Object.entries(this.data()?.reasons ?? {}));
  protected readonly tabs = computed(() => {
    const c = this.data()?.counts;
    return [
      { value: "open", label: "Open", count: c?.["open"] },
      { value: "resolved", label: "Resolved", count: c?.["resolved"] },
      { value: "dismissed", label: "Dismissed", count: c?.["dismissed"] },
    ];
  });

  constructor() {
    let t: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      const query = { status: this.status(), reason: this.reason() || undefined, q: this.q(), page: this.page() };
      clearTimeout(t);
      t = setTimeout(() => this.load(query), query.q ? 250 : 0);
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(t));
  }

  private lastQuery: Record<string, string | number | undefined> = {};
  private load(query = this.lastQuery): void {
    this.lastQuery = query;
    void this.track(api<Res>("/api/admin/product-reports", { query }), (x) => this.data.set(x));
  }

  protected act(r: Rep, f: Form): void {
    this.acting.set(r);
    this.form.set(f);
  }

  protected setForm(x: Partial<Form>): void {
    this.form.update((f) => ({ ...f, ...x }));
  }

  protected async resolve(e: Event): Promise<void> {
    e.preventDefault();
    const acting = this.acting();
    const form = this.form();
    if (!acting) return;
    this.busy.set(true);
    try {
      const r = await api<{ product_status: string }>(`/api/admin/product-reports/${acting.id}`, {
        method: "POST", body: { status: form.status, admin_note: form.note, take_down: form.takeDown, notify_seller: form.notify },
      });
      this.toast.show(form.takeDown && r.product_status === "rejected" ? "Report resolved and the listing taken down" : form.status === "resolved" ? "Report resolved" : "Report dismissed");
      this.acting.set(null);
      this.load();
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not update", "error");
    } finally {
      this.busy.set(false);
    }
  }
}
