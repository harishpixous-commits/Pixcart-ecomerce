/*
 * Admin → Delivery → Assign: packages the sellers marked "Ready for pickup" that no partner has yet, requests waiting
 * for a partner to accept, and failed attempts that need a decision (try again or bring the package back).
 * Assign by hand (with or without asking the partner), let auto-assign ask the nearest free partner, or hand the
 * package to a courier instead. "Return pickups" lists customers' returns our partners should collect.
 * Port of frontend/src/app/admin/delivery/queue/page.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from "@angular/core";
import { Router } from "@angular/router";
import { Banknote, Bike, Loader2, MapPin, Phone, RotateCcw, Send, Sparkles, Store, Truck, Undo2, UserCheck, Zap } from "lucide-angular";
import { api, ApiError } from "../../core/api";
import type { Candidate, QueuePackage } from "../../core/delivery-types";
import { rupees } from "../../core/format";
import { RouteState } from "../../core/route-state";
import { ago, telUrl, useNow, usePolling } from "../../delivery/components/trip";
import { PageHeader, Tabs } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, ErrorNote, Modal, Pill, Textarea, Toast } from "../../shared/ui/ui";
import { PartnerAvatar } from "../shared/delivery-admin";

type Tab = "waiting" | "offered" | "failed" | "returns";
type Data = { items: QueuePackage[]; counts: Record<Tab, number> };

const TRY_LABEL: Record<string, string | undefined> = { rejected: "declined", expired: "did not answer", cancelled: "taken back", failed: "could not deliver", delivered: "delivered" };

@Component({
  selector: "pc-queue-package-card",
  imports: [Icon, Button, Pill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <article class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:p-5" data-testid="queue-item">
      <header class="flex flex-wrap items-center gap-2">
        <h2 class="font-display text-lg font-semibold">{{ p().return_number ? "Return " + p().return_number : p().order_number }}</h2>
        @if (p().return_number) {<span class="text-sm text-ink-soft">order {{ p().order_number }}</span>}
        @if (p().return_number || a()?.kind === "pickup") {<pc-pill tone="blue">Return pickup</pc-pill>}
        @else if (p().payment === "cod") {<pc-pill tone="amber">Cash on delivery {{ rupees(p().cod_amount) }}</pc-pill>}
        @else {<pc-pill tone="green">Prepaid</pc-pill>}
        @if (p().zone) {<pc-pill tone="blue">{{ p().zone!.name }}</pc-pill>} @else {<pc-pill tone="red">No zone</pc-pill>}
        @if (p().ready_since) {<span class="text-sm text-ink-faint">Ready {{ ago(p().ready_since, now()) }}</span>}
        @if (p().pickup_code) {<span class="ml-auto rounded-lg bg-mist px-2 py-1 font-mono text-sm font-bold tracking-widest" title="The seller gives this code to the partner at pickup">Code {{ p().pickup_code }}</span>}
      </header>
      <div class="mt-3 grid gap-3 sm:grid-cols-2">
        <div class="flex gap-3 rounded-xl bg-mist p-3">
          <svg [pcIcon]="I.Store" class="mt-0.5 h-5 w-5 shrink-0 text-marigold-dark" aria-hidden="true" />
          <div class="min-w-0 text-sm">
            <p class="font-semibold">{{ p().pickup.name }}</p>
            <p class="text-ink-soft">{{ pickupLine() }}</p>
            @if (p().pickup.phone) {<a [href]="tel(p().pickup.phone)" class="mt-1 inline-flex items-center gap-1 font-semibold text-peacock"><svg [pcIcon]="I.Phone" class="h-3.5 w-3.5" aria-hidden="true" />{{ p().pickup.phone }}</a>}
            @if (p().pickup.lat === null) {<p class="mt-1 text-xs text-marigold-dark">Store location not pinned yet; distance can't be measured.</p>}
          </div>
        </div>
        <div class="flex gap-3 rounded-xl bg-mist p-3">
          <svg [pcIcon]="I.MapPin" class="mt-0.5 h-5 w-5 shrink-0 text-vermilion" aria-hidden="true" />
          <div class="min-w-0 text-sm">
            <p class="font-semibold">{{ p().drop.name || "Customer" }}</p>
            <p class="text-ink-soft">{{ dropLine() }}</p>
            @if (p().drop.lat === null) {<p class="mt-1 text-xs text-ink-faint">No map pin on this address</p>}
          </div>
        </div>
      </div>

      @if (p().return_items && p().return_items!.length > 0) {
        <p class="mt-3 text-sm"><span class="font-semibold">Collect: </span>{{ p().return_items!.join(", ") }}</p>
      }

      @if (p().tries.length > 0) {
        <p class="mt-3 text-sm text-ink-soft">
          <span class="font-semibold text-ink">Tried: </span>
          @for (t of p().tries; track $index; let i = $index) {<span>{{ i ? ", " : "" }}{{ t.partner }} {{ tryLabel[t.status] ?? t.status }}{{ t.reason ? " (" + t.reason + ")" : "" }}</span>}
        </p>
      }

      @if (tab() === "offered" && a()) {
        <div class="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-marigold-light/60 p-3 text-sm">
          <svg [pcIcon]="I.Loader2" class="h-4 w-4 animate-spin text-marigold-dark" aria-hidden="true" />
          <span>Asked <b>{{ a()!.partner }}</b>{{ a()!.mode === "auto" ? " (auto-assign)" : "" }}. @if (left() !== null) {<b>{{ left() }} s left</b>} to accept.</span>
          <a [href]="tel(a()!.partner_phone)" class="inline-flex items-center gap-1 font-semibold text-peacock"><svg [pcIcon]="I.Phone" class="h-3.5 w-3.5" aria-hidden="true" />Call</a>
        </div>
      }
      @if (tab() === "failed" && a()) {
        <div class="mt-3 rounded-xl bg-vermilion-light p-3 text-sm text-ink">
          <p><b>{{ a()!.partner }}</b> could not deliver: {{ a()!.fail_reason || "no reason given" }}.</p>
          <p class="text-ink-soft">The partner still has the package. Try again later, or have it brought back to the seller (the order part is then cancelled and refunded).</p>
        </div>
      }

      <footer class="mt-4 flex flex-wrap gap-2">
        @if (tab() === "waiting") {
          <button pcButton (click)="assign.emit()" data-testid="assign-open"><svg [pcIcon]="I.UserCheck" class="h-4 w-4" aria-hidden="true" /> Assign partner</button>
          <button pcButton variant="secondary" [loading]="busy() === 'auto'" (click)="run('auto', '/api/admin/delivery/packages/' + p().sub_order_id + '/auto-assign', {}, 'Asked the nearest free partner')">
            <svg [pcIcon]="I.Zap" class="h-4 w-4" aria-hidden="true" /> Auto-assign
          </button>
          <button pcButton variant="ghost" [loading]="busy() === 'courier'" (click)="courier()">
            <svg [pcIcon]="I.Truck" class="h-4 w-4" aria-hidden="true" /> Use courier instead
          </button>
        }
        @if (tab() === "returns" && p().return_id) {
          <button pcButton (click)="assign.emit()"><svg [pcIcon]="I.UserCheck" class="h-4 w-4" aria-hidden="true" /> Assign partner</button>
          <button pcButton variant="secondary" [loading]="busy() === 'auto'" (click)="run('auto', '/api/admin/delivery/returns/' + p().return_id + '/auto-assign', {}, 'Asked the nearest free partner')">
            <svg [pcIcon]="I.Zap" class="h-4 w-4" aria-hidden="true" /> Auto-assign
          </button>
          <button pcButton variant="ghost" [loading]="busy() === 'courier'" (click)="returnCourier()">
            <svg [pcIcon]="I.Truck" class="h-4 w-4" aria-hidden="true" /> Seller's courier instead
          </button>
        }
        @if (tab() === "offered") {
          <button pcButton variant="secondary" (click)="cancel.emit()"><svg [pcIcon]="I.Undo2" class="h-4 w-4" aria-hidden="true" /> Take back the request</button>
        }
        @if (tab() === "failed" && a()) {
          <button pcButton [loading]="busy() === 'retry'" (click)="run('retry', '/api/admin/delivery/assignments/' + a()!.id + '/resolve', { action: 'retry' }, 'The partner will try the delivery again')">
            <svg [pcIcon]="I.RotateCcw" class="h-4 w-4" aria-hidden="true" /> Try delivery again
          </button>
          <button pcButton variant="danger" [loading]="busy() === 'return'" (click)="bringBack()">
            <svg [pcIcon]="I.Undo2" class="h-4 w-4" aria-hidden="true" /> Bring back to store
          </button>
        }
      </footer>
    </article>
  `,
})
export class QueuePackageCard {
  readonly p = input.required<QueuePackage>();
  readonly tab = input.required<Tab>();
  readonly now = input.required<number>();
  readonly assign = output<void>();
  readonly cancel = output<void>();
  readonly changed = output<void>();
  private readonly toast = inject(Toast);
  protected readonly I = { Store, Phone, MapPin, Loader2, UserCheck, Zap, Truck, Undo2, RotateCcw };
  protected readonly rupees = rupees;
  protected readonly ago = ago;
  protected readonly tel = telUrl;
  protected readonly tryLabel = TRY_LABEL;
  protected readonly busy = signal<string | null>(null);
  protected readonly a = computed(() => this.p().assignment);
  protected readonly left = computed(() => {
    const a = this.a();
    return a?.expires_at ? Math.max(0, Math.round((new Date(a.expires_at).getTime() - this.now()) / 1000)) : null;
  });
  protected readonly pickupLine = computed(() => [this.p().pickup.address, this.p().pickup.city, this.p().pickup.pincode].filter(Boolean).join(", "));
  protected readonly dropLine = computed(() => [this.p().drop.city, this.p().drop.pincode].filter(Boolean).join(" "));

  protected async run(key: string, path: string, body: unknown, ok: string): Promise<void> {
    this.busy.set(key);
    try {
      await api(path, { method: "POST", body });
      this.toast.show(ok);
      this.changed.emit();
    } catch (e) {
      this.toast.show(e instanceof ApiError ? e.message : "Something went wrong", "error");
    } finally {
      this.busy.set(null);
    }
  }

  protected courier(): void {
    if (window.confirm("Send this package by courier instead? The seller books the courier from their order page.")) void this.run("courier", `/api/admin/delivery/packages/${this.p().sub_order_id}/courier`, {}, "Switched to courier");
  }

  protected returnCourier(): void {
    if (window.confirm("Let the seller arrange this pickup with their courier instead? Our partners stop trying.")) void this.run("courier", `/api/admin/delivery/returns/${this.p().return_id}/courier`, {}, "The seller will arrange the pickup");
  }

  protected bringBack(): void {
    const a = this.a();
    if (!a) return;
    if (window.confirm("Bring the package back to the seller? The order part is cancelled and a prepaid amount refunded when it reaches the store.")) void this.run("return", `/api/admin/delivery/assignments/${a.id}/resolve`, { action: "return" }, "The partner will bring the package back to the store");
  }
}

@Component({
  selector: "pc-queue-assign-dialog",
  imports: [Icon, Button, ErrorNote, Modal, Pill, PartnerAvatar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-modal [open]="!!pkg()" (close)="blocked.set(null); close.emit()" [title]="title()" [wide]="true">
      <div class="flex flex-col gap-3" data-testid="assign-dialog">
        <label class="flex cursor-pointer items-start gap-3 rounded-xl bg-mist p-3">
          <input type="checkbox" class="mt-1 h-4 w-4 accent-peacock" [checked]="direct()" (change)="direct.set($any($event.target).checked)" />
          <span class="text-sm">
            <span class="block font-semibold">Assign without asking</span>
            <span class="text-ink-soft">Use when the partner already agreed on the phone. Otherwise they get a request to accept within the time limit.</span>
          </span>
        </label>
        <pc-error-note [message]="error()" />
        @if (!items()) {
          @if (!error()) {<div class="flex h-40 items-center justify-center"><svg [pcIcon]="I.Loader2" class="h-6 w-6 animate-spin text-peacock" /></div>}
        } @else if (items()!.length === 0) {
          <p class="rounded-xl bg-white p-6 text-center text-ink-soft ring-1 ring-line">No approved partners yet. Approve partners in Delivery partners first.</p>
        } @else {
          <ul class="flex flex-col gap-2">
            @for (c of items()!; track c.id; let i = $index) {
              <li [class]="c.ok ? 'rounded-xl p-3 ring-1 ring-leaf/40' : 'rounded-xl p-3 ring-1 ring-line'">
                <div class="flex items-center gap-3">
                  <pc-partner-avatar [p]="c" size="sm" />
                  <div class="min-w-0 flex-1">
                    <p class="flex flex-wrap items-center gap-2">
                      <span class="font-semibold">{{ c.name }}</span>
                      @if (i === 0 && c.ok) {<pc-pill tone="green"><svg [pcIcon]="I.Sparkles" class="mr-1 h-3 w-3" aria-hidden="true" />Best match</pc-pill>}
                      <span [class]="c.online ? 'inline-flex items-center gap-1 text-xs font-semibold text-leaf' : 'inline-flex items-center gap-1 text-xs font-semibold text-ink-faint'">
                        <span [class]="c.online ? 'h-2 w-2 rounded-full bg-leaf' : 'h-2 w-2 rounded-full bg-line'"></span>{{ c.online ? "Online" : "Offline" }}
                      </span>
                    </p>
                    <p class="text-xs text-ink-soft">
                      <svg [pcIcon]="I.Bike" class="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />{{ c.vehicle }}{{ c.zone ? " · " + c.zone : "" }}{{ c.distance_km !== null ? " · " + c.distance_km + " km away" + (c.location_fresh ? "" : " (old location)") : " · distance unknown" }}{{ " · " + c.load + " trip" + (c.load === 1 ? "" : "s") + " now" }}@if (c.cash) { · <svg [pcIcon]="I.Banknote" class="mr-0.5 inline h-3.5 w-3.5" aria-hidden="true" />{{ rupees(c.cash) }} cash}{{ c.rating_avg ? " · ★ " + c.rating_avg.toFixed(1) : "" }}
                    </p>
                    @if (c.reasons.length > 0) {
                      <p class="mt-1 flex flex-wrap gap-1">
                        @for (r of c.reasons; track r) {<span class="rounded-full bg-vermilion-light px-2 py-0.5 text-[11px] font-semibold text-vermilion">{{ r }}</span>}
                      </p>
                    }
                  </div>
                  <button pcButton size="sm" [variant]="c.ok ? 'primary' : 'secondary'" [loading]="busy() === c.id" (click)="assign(c, false)" data-testid="assign-partner">
                    <svg [pcIcon]="I.Send" class="h-3.5 w-3.5" aria-hidden="true" /> {{ direct() ? "Assign" : "Ask" }}
                  </button>
                </div>
                @if (blocked()?.id === c.id) {
                  <div class="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-marigold-light p-2 text-sm">
                    <span class="min-w-0 flex-1">{{ blocked()!.message }}</span>
                    <button pcButton size="sm" variant="danger" [loading]="busy() === c.id" (click)="assign(c, true)">Assign anyway</button>
                  </div>
                }
              </li>
            }
          </ul>
        }
      </div>
    </pc-modal>
  `,
})
export class QueueAssignDialog {
  readonly pkg = input<QueuePackage | null>(null);
  readonly close = output<void>();
  readonly done = output<void>();
  private readonly toast = inject(Toast);
  protected readonly I = { Loader2, Sparkles, Bike, Banknote, Send };
  protected readonly rupees = rupees;
  private readonly list = signal<{ id: string; items: Candidate[] } | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly direct = signal(false);
  protected readonly busy = signal<string | null>(null);
  protected readonly blocked = signal<{ id: string; message: string } | null>(null);
  private readonly id = computed(() => {
    const p = this.pkg();
    return p ? p.return_id ?? p.sub_order_id : null;
  });
  private readonly forReturn = computed(() => !!this.pkg()?.return_id);
  protected readonly items = computed(() => {
    const l = this.list();
    return l && l.id === this.id() ? l.items : null;
  });
  protected readonly title = computed(() => {
    const p = this.pkg();
    return p ? (p.return_number ? `Collect return ${p.return_number}` : `Assign ${p.order_number}`) : "Assign";
  });

  constructor() {
    effect((onCleanup) => {
      const id = this.id();
      const forReturn = this.forReturn();
      if (!id) return;
      let live = true;
      api<Candidate[]>(forReturn ? `/api/admin/delivery/returns/${id}/candidates` : `/api/admin/delivery/packages/${id}/candidates`)
        .then((c) => { if (live) { this.list.set({ id, items: c }); this.error.set(null); } })
        .catch((e) => { if (live) this.error.set(e instanceof ApiError ? e.message : "Could not load partners"); });
      onCleanup(() => { live = false; });
    });
  }

  protected async assign(c: Candidate, force: boolean): Promise<void> {
    const pkg = this.pkg();
    if (!pkg) return;
    const direct = untracked(this.direct);
    this.busy.set(c.id);
    try {
      if (pkg.return_id) await api(`/api/admin/delivery/returns/${pkg.return_id}/assign`, { method: "POST", body: { partner_id: c.id, direct, force } });
      else await api("/api/admin/delivery/assign", { method: "POST", body: { sub_order_id: pkg.sub_order_id, partner_id: c.id, direct, force } });
      this.toast.show(direct ? `Assigned to ${c.name}` : `Request sent to ${c.name}`);
      this.blocked.set(null);
      this.done.emit();
    } catch (e) {
      if (e instanceof ApiError && e.code === "partner_not_free") this.blocked.set({ id: c.id, message: e.message });
      else this.toast.show(e instanceof ApiError ? e.message : "Could not assign", "error");
    } finally {
      this.busy.set(null);
    }
  }
}

@Component({
  selector: "pc-queue-cancel-dialog",
  imports: [Button, ErrorNote, Modal, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-modal [open]="!!pkg()" (close)="close.emit()" title="Take back the request">
      <form (submit)="submit($event)" class="flex flex-col gap-3">
        <p class="text-sm text-ink-soft">{{ pkg()?.assignment?.partner }} is told the request was withdrawn. You can then assign someone else.</p>
        <pc-error-note [message]="error()" />
        <textarea pcTextarea [value]="reason()" (input)="reason.set($any($event.target).value)" placeholder="Why, for the partner and the log (e.g. assigning a closer partner)" rows="3" required minlength="3" maxlength="300" aria-label="Reason"></textarea>
        <button pcButton type="submit" [loading]="busy()" [disabled]="reason().trim().length < 3" class="self-start">Take back</button>
      </form>
    </pc-modal>
  `,
})
export class QueueCancelDialog {
  readonly pkg = input<QueuePackage | null>(null);
  readonly close = output<void>();
  readonly done = output<void>();
  private readonly toast = inject(Toast);
  protected readonly reason = signal("");
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(e: Event): Promise<void> {
    e.preventDefault();
    const pkg = this.pkg();
    if (!pkg?.assignment) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await api(`/api/admin/delivery/assignments/${pkg.assignment.id}/cancel`, { method: "POST", body: { reason: this.reason().trim() } });
      this.toast.show("Request taken back. The package is waiting for a partner again.");
      this.reason.set("");
      this.done.emit();
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not take it back");
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: "pc-admin-delivery-queue-page",
  imports: [PageHeader, Tabs, PageLoader, EmptyState, ErrorNote, QueuePackageCard, QueueAssignDialog, QueueCancelDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="flex flex-col gap-1">
      <pc-page-header title="Assign deliveries" sub="Packages ready for pickup. Assign a partner yourself, or let auto-assign ask the nearest free partner." />
      <pc-tabs [value]="tab()" (valueChange)="go($event)" [items]="tabs()" />
      <pc-error-note [message]="error()" />
      @if (!d()) {
        @if (!error()) {<pc-page-loader />}
      } @else if (d()!.items.length === 0) {
        <pc-empty-state [title]="emptyTitle()" [body]="emptyBody()" [hasAction]="false" />
      } @else {
        <ul class="flex flex-col gap-3" data-testid="queue-list">
          @for (p of d()!.items; track p.return_id ?? p.sub_order_id) {
            <li>
              <pc-queue-package-card [p]="p" [tab]="tab()" [now]="now()" (assign)="assigning.set(p)" (cancel)="cancelling.set(p)" (changed)="load()" />
            </li>
          }
        </ul>
      }
      <pc-queue-assign-dialog [pkg]="assigning()" (close)="assigning.set(null)" (done)="assigning.set(null); load()" />
      <pc-queue-cancel-dialog [pkg]="cancelling()" (close)="cancelling.set(null)" (done)="cancelling.set(null); load()" />
    </div>
  `,
})
export class AdminDeliveryQueuePage {
  private readonly route = inject(RouteState);
  private readonly router = inject(Router);
  protected readonly tab = computed<Tab>(() => {
    const t = this.route.params().get("tab") ?? "";
    return (["waiting", "offered", "failed", "returns"].includes(t) ? t : "waiting") as Tab;
  });
  private readonly data = signal<{ tab: Tab; d: Data } | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly assigning = signal<QueuePackage | null>(null);
  protected readonly cancelling = signal<QueuePackage | null>(null);
  protected readonly now = useNow(1000);
  protected readonly d = computed(() => {
    const x = this.data();
    return x?.tab === this.tab() ? x.d : null;
  });
  protected readonly tabs = computed(() => {
    const counts = this.d()?.counts ?? this.data()?.d.counts;
    return [
      { value: "waiting", label: "Waiting for a partner", count: counts?.waiting },
      { value: "offered", label: "Request sent", count: counts?.offered },
      { value: "failed", label: "Not delivered", count: counts?.failed },
      { value: "returns", label: "Return pickups", count: counts?.returns },
    ];
  });
  protected readonly emptyTitle = computed(() => {
    const t = this.tab();
    return t === "waiting" ? "Every package has a partner" : t === "offered" ? "No requests waiting for an answer" : t === "returns" ? "No returns waiting to be collected" : "No failed deliveries to sort out";
  });
  protected readonly emptyBody = computed(() => {
    const t = this.tab();
    return t === "waiting" ? "Packages show up here when a seller taps Ready for pickup and no partner has taken them yet."
      : t === "returns" ? "Approved returns of packages our partners delivered wait here when no partner has taken the pickup." : undefined;
  });

  constructor() {
    // like the reference, the polling keeps running with the newest tab (a tab change is picked up on the next tick)
    usePolling(() => this.load(), 10_000);
  }

  protected load(): void {
    const tab = untracked(this.tab);
    api<Data>("/api/admin/delivery/queue", { query: { tab } })
      .then((d) => { this.data.set({ tab, d }); this.error.set(null); })
      .catch((e) => this.error.set(e instanceof ApiError ? e.message : "Could not load the queue"));
  }

  protected go(v: string): void {
    void this.router.navigateByUrl(`/admin/delivery/queue?tab=${v}`, { replaceUrl: true });
  }
}
