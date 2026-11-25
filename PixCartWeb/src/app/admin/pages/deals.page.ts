/* Admin → Deals: approve, reject or stop sellers' deals, and the deal rules. Port of frontend/src/app/admin/deals/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from "@angular/core";
import { Search } from "lucide-angular";
import { AdminContext } from "../../core/admin";
import { api, ApiError, latestOnly } from "../../core/api";
import { DealItem, type DealRow, type DealRules } from "../../shared/portal/deal-list";
import { PageHeader, Tabs } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Autofocus, Button, EmptyState, ErrorNote, Input, Modal, Pagination, Textarea, Toast } from "../../shared/ui/ui";
import { debounced } from "../shared/admin-helpers";
import { SettingsBlock, type SettingField } from "../shared/settings-block";

type Data = { items: DealRow[]; total: number; page: number; page_size: number; counts: Record<string, number>; rules: DealRules };
type Act = { d: DealRow; action: "approve" | "reject" | "cancel" };

const RULE_FIELDS: SettingField[] = [
  { k: "feature_deals", kind: "bool", label: "Deals are on", hint: "Sellers can create deals and shoppers see Today's Deals, deal badges and countdowns. Off ends running deals at their next check." },
  { k: "deals_need_approval", kind: "bool", label: "Check every deal before it starts", hint: "New deals wait here for approval. Off: deals start on time without a check." },
  { k: "deal_min_discount_pct", kind: "int", label: "Minimum discount (%)", hint: "Below the seller's current selling price. 1 to 90.", min: 1, max: 90 },
  { k: "deal_max_hours_lightning", kind: "int", label: "Lightning deal: longest (hours)", hint: "1 to 24", min: 1, max: 24 },
  { k: "deal_max_hours_day", kind: "int", label: "Deal of the Day: longest (hours)", hint: "1 to 48", min: 1, max: 48 },
  { k: "deal_max_days_limited", kind: "int", label: "Limited time deal: longest (days)", hint: "1 to 60", min: 1, max: 60 },
];

@Component({
  selector: "pc-admin-deals-page",
  imports: [PageHeader, Tabs, DealItem, SettingsBlock, Icon, PageLoader, Autofocus, Button, EmptyState, ErrorNote, Input, Modal, Pagination, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <pc-page-header title="Deals" sub="Lightning deals, Deal of the Day and Limited time deals proposed by sellers. Approve them before they start, or stop a running deal." />
    <pc-tabs [value]="tab()" (valueChange)="tab.set($event); page.set(1)" [items]="tabs()" />
    @if (tab() === "rules") {
      <pc-settings-block title="Deal rules" sub="What sellers may offer. Shoppers see deals in Today's Deals, on product cards and on product pages." [fields]="fields" saveLabel="Save deal rules" />
    } @else {
      <div class="relative mb-3 max-w-md">
        <svg [pcIcon]="Search" class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
        <input pcInput [value]="q()" (input)="q.set($any($event.target).value)" placeholder="Search by product or seller" aria-label="Search deals" class="pl-9" />
      </div>
      <pc-error-note [message]="error()" />
      @if (!d()) {
        @if (!error()) {<pc-page-loader />}
      } @else if (d()!.items.length === 0) {
        <pc-empty-state [title]="tab() === 'pending' ? 'Nothing waiting' : 'No deals here'" [body]="tab() === 'pending' ? 'New deals from sellers show up here for approval.' : undefined" [hasAction]="false" />
      } @else {
        <div class="flex flex-col gap-3">
          @for (x of d()!.items; track x.id) {
            <pc-deal-item [d]="x" [showSeller]="true" [withActions]="x.status === 'pending' || x.status === 'approved' || x.status === 'active'">
              @if (x.status === "pending") {<button actions pcButton size="sm" [loading]="busy() === x.id + 'approve'" (click)="run({ d: x, action: 'approve' }, '')">Approve</button>}
              @if (x.status === "pending") {<button actions pcButton size="sm" variant="danger" (click)="ask(x, 'reject')">Reject</button>}
              @if (x.status === "approved" || x.status === "active") {
                <button actions pcButton size="sm" variant="danger" (click)="ask(x, 'cancel')">{{ x.status === "active" ? "Stop deal" : "Cancel deal" }}</button>
              }
            </pc-deal-item>
          }
        </div>
      }
      @if (d()) {<pc-pagination [page]="page()" [pageSize]="d()!.page_size" [total]="d()!.total" (pageChange)="page.set($event)" />}
    }

    <pc-modal [open]="act() !== null" (close)="act.set(null)" [title]="act()?.action === 'reject' ? 'Reject this deal' : 'Stop this deal'">
      @if (act(); as a) {
        <form class="flex flex-col gap-3" (submit)="$event.preventDefault(); run(a, reason().trim())">
          <p class="text-sm text-ink-soft"><b class="text-ink">{{ a.d.product }}</b> from {{ a.d.seller }}. The seller sees your reason.</p>
          <textarea pcTextarea rows="3" maxlength="300" [value]="reason()" (input)="reason.set($any($event.target).value)" aria-label="Reason"
            [placeholder]="a.action === 'reject' ? 'e.g. The M.R.P. was raised just before the deal' : 'e.g. Pricing complaint from customers'" pcAutofocus></textarea>
          <div class="flex gap-2">
            <button pcButton type="submit" variant="danger" [loading]="busy() === a.d.id + a.action" [disabled]="reason().trim().length < 5">{{ a.action === "reject" ? "Reject deal" : "Stop deal" }}</button>
            <button pcButton type="button" variant="ghost" (click)="act.set(null)">Back</button>
          </div>
        </form>
      }
    </pc-modal>
  `,
})
export class AdminDealsPage {
  private readonly toast = inject(Toast);
  private readonly admin = inject(AdminContext);
  protected readonly Search = Search;
  protected readonly fields = RULE_FIELDS;
  protected readonly tab = signal("pending");
  protected readonly q = signal("");
  protected readonly page = signal(1);
  protected readonly d = signal<Data | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly act = signal<Act | null>(null);
  protected readonly reason = signal("");
  protected readonly busy = signal<string | null>(null);
  private readonly track = latestOnly();
  private readonly query = debounced(this.q, 300, () => this.page.set(1));
  protected readonly tabs = computed(() => {
    const counts = this.d()?.counts ?? {};
    const all = Object.values(counts).reduce((a, b) => a + b, 0);
    return [
      { value: "pending", label: "Waiting for approval", count: counts["pending"] ?? 0 },
      { value: "active", label: "Running", count: counts["active"] ?? 0 },
      { value: "approved", label: "Scheduled", count: counts["approved"] ?? 0 },
      { value: "ended", label: "Ended", count: counts["ended"] ?? 0 },
      { value: "rejected", label: "Rejected", count: counts["rejected"] ?? 0 },
      { value: "cancelled", label: "Cancelled", count: counts["cancelled"] ?? 0 },
      { value: "all", label: "All", count: all },
      ...(this.admin.can("settings") ? [{ value: "rules", label: "Rules" }] : []),
    ];
  });

  constructor() {
    effect(() => this.load());
  }

  protected load(): void {
    const tab = this.tab();
    const query = this.query();
    const page = this.page();
    if (tab === "rules") return;
    this.track(api<Data>("/api/admin/deals", { query: { status: tab, q: query || undefined, page } }), (x) => { this.d.set(x); this.error.set(null); })
      .catch((e) => this.error.set(e instanceof ApiError ? e.message : "Could not load deals"));
  }

  protected ask(d: DealRow, action: Act["action"]): void {
    this.reason.set("");
    this.act.set({ d, action });
  }

  protected async run(a: Act, why: string): Promise<void> {
    this.busy.set(a.d.id + a.action);
    try {
      await api(`/api/admin/deals/${a.d.id}/${a.action}`, { method: "POST", body: { reason: why } });
      this.toast.show(a.action === "approve" ? "Deal approved. The seller was told." : a.action === "reject" ? "Deal rejected. The seller was told why." : "Deal stopped. The price is back to normal.");
      this.act.set(null);
      this.reason.set("");
      this.load();
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not update the deal", "error");
    } finally {
      this.busy.set(null);
    }
  }
}
