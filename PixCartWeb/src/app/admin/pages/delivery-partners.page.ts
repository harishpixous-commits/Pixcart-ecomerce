/* Admin → Delivery → Partners: registrations, approved partners, add a partner. Port of frontend/src/app/admin/delivery/partners/page.tsx. */

import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal, untracked } from "@angular/core";
import { Router } from "@angular/router";
import { ChevronRight, Search, UserPlus } from "lucide-angular";
import { api, ApiError, latestOnly, quietly } from "../../core/api";
import type { Partner } from "../../core/delivery-types";
import { date } from "../../core/format";
import { RouteState } from "../../core/route-state";
import { PageHeader, Tabs } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, ErrorNote, Field, Input, Modal, Pagination, Select, TextField, Toast } from "../../shared/ui/ui";
import { debounced } from "../shared/admin-helpers";
import { KycPill, OnlineDot, PartnerAvatar, PartnerStars } from "../shared/delivery-admin";

type Data = { items: Partner[]; total: number; page: number; page_size: number; counts: Record<string, number> };
type Zone = { id: string; name: string; city: string };

export const VEHICLES: [string, string][] = [["bike", "Motorbike"], ["scooter", "Scooter"], ["ev", "Electric bike or scooter"], ["cycle", "Bicycle"], ["auto", "Auto"], ["van", "Van"]];

@Component({
  selector: "pc-add-partner",
  imports: [Button, ErrorNote, Field, Select, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <form (submit)="save($event)" class="flex flex-col gap-3">
      <pc-error-note [message]="error()" />
      <p class="text-sm text-ink-soft">For partners you hire in person. They sign in to the partner app with this number to upload documents, or you upload them from their page.</p>
      <pc-text-field label="Mobile number" type="tel" [value]="f().phone" (valueChange)="set({ phone: $event })" [required]="true" placeholder="98765 43210" />
      <pc-text-field label="Full name" [value]="f().name" (valueChange)="set({ name: $event })" [required]="true" [minlength]="2" />
      <div class="grid gap-3 sm:grid-cols-2">
        <pc-text-field label="City" [value]="f().city" (valueChange)="set({ city: $event })" />
        <pc-field label="Zone">
          <select pcSelect (change)="set({ zone_id: $any($event.target).value })">
            <option value="" [selected]="f().zone_id === ''">Choose later</option>
            @for (z of zones(); track z.id) {<option [value]="z.id" [selected]="z.id === f().zone_id">{{ z.name }} ({{ z.city }})</option>}
          </select>
        </pc-field>
        <pc-field label="Vehicle">
          <select pcSelect (change)="set({ vehicle_type: $any($event.target).value })">
            @for (v of vehicles; track v[0]) {<option [value]="v[0]" [selected]="v[0] === f().vehicle_type">{{ v[1] }}</option>}
          </select>
        </pc-field>
        @if (f().vehicle_type !== "cycle") {<pc-text-field label="Vehicle number" [value]="f().vehicle_no" (valueChange)="set({ vehicle_no: $event })" [filter]="upper" placeholder="TN 38 AB 1234" />}
      </div>
      <button pcButton type="submit" [loading]="busy()" class="self-start">Add partner</button>
    </form>
  `,
})
export class AddPartner {
  readonly zones = input.required<Zone[]>();
  readonly done = output<Partner>();
  private readonly toast = inject(Toast);
  protected readonly vehicles = VEHICLES;
  protected readonly upper = (v: string) => v.toUpperCase();
  protected readonly f = signal({ phone: "", name: "", city: "", zone_id: "", vehicle_type: "bike", vehicle_no: "" });
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected set(x: Partial<ReturnType<typeof this.f>>): void {
    this.f.update((f) => ({ ...f, ...x }));
  }

  protected async save(e: Event): Promise<void> {
    e.preventDefault();
    const f = this.f();
    this.busy.set(true);
    this.error.set(null);
    try {
      const p = await api<Partner>("/api/admin/delivery/partners", { method: "POST", body: {
        phone: f.phone, name: f.name, city: f.city || undefined, zone_id: f.zone_id || undefined, vehicle_type: f.vehicle_type,
        vehicle_no: f.vehicle_type === "cycle" ? "" : f.vehicle_no || undefined,
      } });
      this.toast.show("Partner added. They sign in with this mobile number to add documents.");
      this.done.emit(p);
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not add the partner");
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: "pc-admin-delivery-partners-page",
  imports: [PageHeader, Tabs, Icon, PageLoader, Button, EmptyState, ErrorNote, Input, Modal, Pagination, Select, KycPill, OnlineDot, PartnerAvatar, PartnerStars, AddPartner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <pc-page-header title="Delivery partners" sub="Review registrations, approve partners for a zone, and switch accounts on or off." [withActions]="true">
      <button actions pcButton (click)="adding.set(true)"><svg [pcIcon]="UserPlus" class="h-4 w-4" /> Add partner</button>
    </pc-page-header>
    <pc-tabs [value]="status()" (valueChange)="status.set($event); page.set(1)" [items]="tabs()" />
    <div class="mb-3 flex flex-wrap gap-2">
      <div class="relative min-w-[240px] flex-1">
        <svg [pcIcon]="Search" class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
        <input pcInput [value]="q()" (input)="q.set($any($event.target).value)" placeholder="Search name, mobile or vehicle number" aria-label="Search partners" class="pl-9" />
      </div>
      <select pcSelect (change)="zone.set($any($event.target).value); page.set(1)" aria-label="Zone" class="w-auto min-w-[200px]">
        <option value="" [selected]="zone() === ''">All zones</option>
        @for (z of zones(); track z.id) {<option [value]="z.id" [selected]="z.id === zone()">{{ z.name }} ({{ z.city }})</option>}
      </select>
    </div>
    <pc-error-note [message]="error()" />
    @if (!d()) {
      @if (!error()) {<pc-page-loader />}
    } @else if (d()!.items.length === 0) {
      <pc-empty-state [title]="status() === 'submitted' ? 'No one is waiting for review' : 'No delivery partners here'"
        [body]="status() === 'submitted' ? 'New registrations from the partner app show up here.' : 'Partners register in the partner app (/delivery/join), or add one with their mobile number.'" [hasAction]="false" />
    } @else {
      <ul class="flex flex-col gap-2" data-testid="partner-list">
        @for (p of d()!.items; track p.id) {
          <li>
            <button type="button" (click)="go(p.id)" class="flex w-full items-center gap-3 rounded-xl bg-white p-3 text-left shadow-sm ring-1 ring-black/5 transition hover:ring-peacock/30 sm:p-4">
              <pc-partner-avatar [p]="p" />
              <span class="min-w-0 flex-1">
                <span class="flex flex-wrap items-center gap-2">
                  <span class="font-semibold">{{ p.name }}</span>
                  <pc-kyc-pill [status]="p.kyc_status" [active]="p.is_active" />
                  @if (p.kyc_status === "approved" && p.is_active) {<pc-online-dot [online]="p.is_online" />}
                </span>
                <span class="block text-sm text-ink-soft">{{ p.phone }} · {{ p.vehicle_label }}{{ p.vehicle_no ? " " + p.vehicle_no : "" }} · {{ p.zone ? p.zone.name + ", " + p.zone.city : p.city || "No zone" }}</span>
                <span class="mt-0.5 flex flex-wrap items-center gap-3 text-xs text-ink-faint">
                  <pc-partner-stars [value]="p.rating_avg" [count]="p.rating_count" />
                  @if (p.created_at) {<span>Joined {{ date(p.created_at) }}</span>}
                  @if (p.kyc_status !== "approved") {<span>{{ doneCount(p) }}/{{ p.checklist.length }} details added</span>}
                </span>
              </span>
              <svg [pcIcon]="ChevronRight" class="h-5 w-5 shrink-0 text-ink-faint" />
            </button>
          </li>
        }
      </ul>
    }
    @if (d()) {<pc-pagination [page]="page()" [pageSize]="d()!.page_size" [total]="d()!.total" (pageChange)="page.set($event)" />}
    <pc-modal [open]="adding()" (close)="adding.set(false)" title="Add a delivery partner">
      @if (adding()) {<pc-add-partner [zones]="zones()" (done)="adding.set(false); go($event.id)" />}
    </pc-modal>
  `,
})
export class AdminDeliveryPartnersPage {
  private readonly router = inject(Router);
  private readonly route = inject(RouteState);
  protected readonly UserPlus = UserPlus;
  protected readonly Search = Search;
  protected readonly ChevronRight = ChevronRight;
  protected readonly date = date;
  protected readonly status = signal(untracked(() => this.route.param("status")) ?? "");
  protected readonly zone = signal(untracked(() => this.route.param("zone")) ?? "");
  protected readonly q = signal("");
  protected readonly page = signal(1);
  protected readonly d = signal<Data | null>(null);
  protected readonly zones = signal<Zone[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly adding = signal(false);
  private readonly track = latestOnly();
  private readonly query = debounced(this.q, 300, () => this.page.set(1));

  protected tabs(): { value: string; label: string; count: number }[] {
    const c = this.d()?.counts ?? {};
    const all = ["draft", "submitted", "approved", "rejected"].reduce((n, k) => n + (c[k] ?? 0), 0);
    return [
      { value: "submitted", label: "Waiting for review", count: c["submitted"] ?? 0 },
      { value: "approved", label: "Approved", count: c["approved"] ?? 0 },
      { value: "rejected", label: "Needs changes", count: c["rejected"] ?? 0 },
      { value: "draft", label: "Not submitted", count: c["draft"] ?? 0 },
      { value: "inactive", label: "Switched off", count: c["inactive"] ?? 0 },
      { value: "", label: "All", count: all },
    ];
  }

  constructor() {
    effect(() => {
      const query = { status: this.status() || undefined, zone_id: this.zone() || undefined, q: this.query() || undefined, page: this.page() };
      this.track(api<Data>("/api/admin/delivery/partners", { query }), (x) => { this.d.set(x); this.error.set(null); })
        .catch((e) => this.error.set(e instanceof ApiError ? e.message : "Could not load partners"));
    });
    api<Zone[]>("/api/admin/delivery/zones").then((z) => this.zones.set(z)).catch(quietly);
  }

  protected doneCount(p: Partner): number {
    return p.checklist.filter((i) => i.done).length;
  }

  protected go(id: string): void {
    void this.router.navigateByUrl(`/admin/delivery/partners/${id}`);
  }
}
