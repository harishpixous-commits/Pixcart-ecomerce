/* Admin → Delivery → Zones: the PIN codes each delivery team covers, by city; add, edit and delete zones. Port of frontend/src/app/admin/delivery/zones/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from "@angular/core";
import { MapPinned, Pencil, Plus, Trash2, Users } from "lucide-angular";
import { api, ApiError, quietly } from "../../core/api";
import { PageHeader } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, ErrorNote, Field, Modal, Pill, Textarea, TextField, Toast } from "../../shared/ui/ui";

type Zone = { id: string; name: string; city: string; pincodes: string[]; is_active: boolean; center_lat: number | null; center_lng: number | null; partners: number; approved: number; online: number };

@Component({
  selector: "pc-zone-form",
  imports: [Button, ErrorNote, Field, Textarea, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <form (submit)="save($event)" class="grid gap-3 sm:grid-cols-2">
      <div class="sm:col-span-2"><pc-error-note [message]="error()" /></div>
      <pc-text-field label="Zone name" [value]="f().name" (valueChange)="set({ name: $event })" [required]="true" [minlength]="2" [maxlength]="80" placeholder="e.g. Coimbatore Central" />
      <pc-text-field label="City" [value]="f().city" (valueChange)="set({ city: $event })" [required]="true" [minlength]="2" [maxlength]="80" />
      <pc-field [label]="'PIN codes (' + pins().length + ')'" class="sm:col-span-2" [error]="bad().length ? 'Not 6-digit PIN codes: ' + bad().slice(0, 5).join(', ') : undefined"
        hint="Separate with commas, spaces or new lines. A PIN code can be in only one active zone.">
        <textarea pcTextarea rows="4" [value]="f().pins" (input)="set({ pins: $any($event.target).value })" required class="font-mono text-sm" placeholder="641001, 641002, 641018"></textarea>
      </pc-field>
      <pc-text-field label="Map centre latitude (optional)" inputmode="decimal" [value]="f().lat" (valueChange)="set({ lat: $event })" placeholder="11.0168" />
      <pc-text-field label="Map centre longitude (optional)" inputmode="decimal" [value]="f().lng" (valueChange)="set({ lng: $event })" placeholder="76.9558" />
      <label class="flex items-center gap-2 sm:col-span-2"><input type="checkbox" class="h-4 w-4 accent-peacock" [checked]="f().is_active" (change)="set({ is_active: $any($event.target).checked })" /> Zone is active (switching it off takes its partners offline)</label>
      <button pcButton type="submit" [loading]="busy()" [disabled]="bad().length > 0 || pins().length === 0" class="sm:col-span-2 sm:justify-self-start">Save zone</button>
    </form>
  `,
})
export class ZoneForm {
  readonly zone = input<Zone | null>(null);
  readonly done = output<void>();
  protected readonly f = signal({ name: "", city: "", pins: "", is_active: true, lat: "", lng: "" });
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly pins = computed(() => Array.from(new Set(this.f().pins.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))));
  protected readonly bad = computed(() => this.pins().filter((p) => !/^[1-9]\d{5}$/.test(p)));

  ngOnInit(): void {
    const zone = this.zone();
    this.f.set({
      name: zone?.name ?? "", city: zone?.city ?? "", pins: zone?.pincodes.join(", ") ?? "", is_active: zone?.is_active ?? true,
      lat: zone?.center_lat?.toString() ?? "", lng: zone?.center_lng?.toString() ?? "",
    });
  }

  protected set(x: Partial<ReturnType<typeof this.f>>): void {
    this.f.update((f) => ({ ...f, ...x }));
  }

  protected async save(e: Event): Promise<void> {
    e.preventDefault();
    const f = this.f();
    const zone = this.zone();
    this.busy.set(true);
    this.error.set(null);
    const body = { name: f.name, city: f.city, pincodes: this.pins(), is_active: f.is_active, center_lat: f.lat ? Number(f.lat) : null, center_lng: f.lng ? Number(f.lng) : null };
    try {
      if (zone) await api(`/api/admin/delivery/zones/${zone.id}`, { method: "PUT", body });
      else await api("/api/admin/delivery/zones", { method: "POST", body });
      this.done.emit();
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not save the zone");
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: "pc-admin-delivery-zones-page",
  imports: [PageHeader, Icon, PcLink, PageLoader, Button, EmptyState, Modal, Pill, ZoneForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <pc-page-header title="Delivery zones" sub="The PIN codes your delivery partners cover. Packages from a store in a zone to a customer in a zone of the same city go to your partners." [withActions]="true">
      <button actions pcButton (click)="edit.set('new')"><svg [pcIcon]="I.Plus" class="h-4 w-4" /> New zone</button>
    </pc-page-header>
    @if (!zones()) {
      <pc-page-loader />
    } @else if (zones()!.length === 0) {
      <pc-empty-state title="No zones yet" body="Create a zone with the PIN codes your partners can reach, for example one zone per part of a city.">
        <button action pcButton (click)="edit.set('new')">Create the first zone</button>
      </pc-empty-state>
    } @else {
      <div class="flex flex-col gap-6">
        @for (city of cities(); track city) {
          <section>
            <h2 class="mb-2 text-lg font-semibold">{{ city }}</h2>
            <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              @for (z of inCity(city); track z.id) {
                <article [class]="z.is_active ? 'flex flex-col gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5' : 'flex flex-col gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 opacity-70'" data-testid="zone-card">
                  <div class="flex items-start gap-3">
                    <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-peacock-light text-peacock"><svg [pcIcon]="I.MapPinned" class="h-5 w-5" aria-hidden="true" /></span>
                    <div class="min-w-0 flex-1">
                      <p class="font-semibold">{{ z.name }}</p>
                      <p class="text-sm text-ink-soft">{{ z.pincodes.length }} PIN code{{ z.pincodes.length === 1 ? "" : "s" }}</p>
                    </div>
                    @if (!z.is_active) {<pc-pill tone="gray">Off</pc-pill>}
                  </div>
                  <p class="line-clamp-2 font-mono text-xs text-ink-soft">{{ z.pincodes.join(", ") }}</p>
                  <div class="grid grid-cols-3 gap-2 rounded-xl bg-mist p-2 text-center">
                    <div><p class="text-xs text-ink-faint">Partners</p><p class="font-bold">{{ z.partners }}</p></div>
                    <div><p class="text-xs text-ink-faint">Approved</p><p class="font-bold">{{ z.approved }}</p></div>
                    <div><p class="text-xs text-ink-faint">Online</p><p [class]="z.online ? 'font-bold text-leaf' : 'font-bold'">{{ z.online }}</p></div>
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <button pcButton size="sm" variant="secondary" (click)="edit.set(z)"><svg [pcIcon]="I.Pencil" class="h-4 w-4" /> Edit</button>
                    <a [pcLink]="'/admin/delivery/partners?zone=' + z.id" class="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-peacock hover:bg-peacock-light"><svg [pcIcon]="I.Users" class="h-4 w-4" /> Partners</a>
                    @if (z.partners === 0) {<button pcButton size="sm" variant="ghost" (click)="remove(z)" [attr.aria-label]="'Delete ' + z.name"><svg [pcIcon]="I.Trash2" class="h-4 w-4" /></button>}
                  </div>
                </article>
              }
            </div>
          </section>
        }
      </div>
    }
    <pc-modal [open]="edit() !== null" (close)="edit.set(null)" [title]="editTitle()" [wide]="true">
      @if (edit() !== null) {<pc-zone-form [zone]="edit() === 'new' ? null : $any(edit())" (done)="saved()" />}
    </pc-modal>
  `,
})
export class AdminDeliveryZonesPage {
  private readonly toast = inject(Toast);
  protected readonly I = { Plus, MapPinned, Pencil, Users, Trash2 };
  protected readonly zones = signal<Zone[] | null>(null);
  protected readonly edit = signal<Zone | "new" | null>(null);
  protected readonly cities = computed(() => {
    const z = this.zones();
    return z ? Array.from(new Set(z.map((x) => x.city))) : [];
  });
  protected readonly editTitle = computed(() => {
    const e = this.edit();
    return e === "new" ? "New delivery zone" : `Edit ${e?.name ?? ""}`;
  });

  constructor() {
    this.load();
  }

  protected load(): void {
    api<Zone[]>("/api/admin/delivery/zones").then((z) => this.zones.set(z)).catch(quietly);
  }

  protected inCity(city: string): Zone[] {
    return (this.zones() ?? []).filter((z) => z.city === city);
  }

  protected saved(): void {
    this.edit.set(null);
    this.toast.show("Zone saved");
    this.load();
  }

  protected async remove(z: Zone): Promise<void> {
    if (!window.confirm(`Delete the zone ${z.name}?`)) return;
    try {
      await api(`/api/admin/delivery/zones/${z.id}`, { method: "DELETE" });
      this.toast.show("Zone deleted");
      this.load();
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not delete", "error");
    }
  }
}
