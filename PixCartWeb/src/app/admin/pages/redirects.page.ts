/* Admin → Redirects: an old address sends visitors to a new one when the shop has no page there. Port of frontend/src/app/admin/redirects/page.tsx. */

import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { ApiError, api } from "../../core/api";
import { PageHeader } from "../../shared/portal-shell";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, ErrorNote, Modal, Select, TextField, Toast } from "../../shared/ui/ui";

type Rule = { id: string; from_path: string; to_path: string; status_code: number; is_active: boolean; hits: number };
type Form = { from_path: string; to_path: string; status_code: string; is_active: boolean };
const EMPTY: Form = { from_path: "", to_path: "", status_code: "301", is_active: true };

@Component({
  selector: "pc-admin-redirects-page",
  imports: [PageHeader, PageLoader, Button, EmptyState, ErrorNote, Modal, TextField, Select],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <pc-page-header title="Redirects" sub="Send an old address to a new one, for example after changing a product's link name. It only applies where the shop has no page, so it never hides a working page." [withActions]="true">
      <button actions pcButton (click)="open()">New redirect</button>
    </pc-page-header>
    @if (!items()) { <pc-page-loader /> }
    @else if (items()!.length === 0) { <pc-empty-state title="No redirects yet" /> }
    @else {
      <ul class="flex flex-col gap-2">
        @for (r of items()!; track r.id) {
          <li class="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white p-4">
            <div>
              <p class="font-semibold">{{ r.from_path }} → {{ r.to_path }} @if (!r.is_active) { <span class="text-sm text-ink-faint">(off)</span> }</p>
              <p class="text-sm text-ink-soft">{{ r.status_code === 301 ? 'Permanent (301)' : 'Temporary (302)' }} · used {{ r.hits }} times</p>
            </div>
            <div class="flex gap-2">
              <button pcButton variant="secondary" (click)="open(r)">Edit</button>
              <button pcButton variant="ghost" (click)="remove(r)">Delete</button>
            </div>
          </li>
        }
      </ul>
    }
    <pc-modal [open]="edit() !== null" (close)="edit.set(null)" [title]="editId() ? 'Edit redirect' : 'New redirect'">
      @if (edit(); as f) {
        <div class="flex flex-col gap-3">
          <pc-text-field label="Old address" hint="Starts with /, like /p/old-shirt. Capital letters and a last slash do not matter." [value]="f.from_path" maxlength="300" (valueChange)="set({ from_path: $event })" />
          <pc-text-field label="New address" hint="Starts with / for a page in the shop, or https:// for another site." [value]="f.to_path" maxlength="500" (valueChange)="set({ to_path: $event })" />
          <label class="flex flex-col gap-1 text-sm font-medium">Kind
            <select pcSelect [value]="f.status_code" (change)="set({ status_code: $any($event.target).value })">
              <option value="301">Permanent (301)</option>
              <option value="302">Temporary (302)</option>
            </select>
            <span class="text-xs font-normal text-ink-faint">Permanent tells search engines to move to the new address. Temporary is for a short change.</span>
          </label>
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" [checked]="f.is_active" (change)="set({ is_active: $any($event.target).checked })" />Turned on</label>
          <pc-error-note [message]="error()" />
          <button pcButton [loading]="busy()" (click)="save()">Save redirect</button>
        </div>
      }
    </pc-modal>
  `,
})
export class AdminRedirectsPage {
  private readonly toast = inject(Toast);
  protected readonly items = signal<Rule[] | null>(null);
  protected readonly edit = signal<Form | null>(null);
  protected readonly editId = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.items.set((await api<{ items: Rule[] }>("/api/admin/redirects")).items);
    } catch {
      this.items.set([]);
    }
  }

  protected set(patch: Partial<Form>): void {
    this.edit.update((f) => (f ? { ...f, ...patch } : f));
  }

  protected open(r?: Rule): void {
    this.error.set(null);
    this.editId.set(r?.id ?? null);
    this.edit.set(r ? { from_path: r.from_path, to_path: r.to_path, status_code: String(r.status_code), is_active: r.is_active } : EMPTY);
  }

  protected async save(): Promise<void> {
    const f = this.edit();
    if (!f) return;
    this.busy.set(true);
    this.error.set(null);
    const id = this.editId();
    try {
      await api(id ? `/api/admin/redirects/${id}` : "/api/admin/redirects", { method: id ? "PUT" : "POST", body: { from_path: f.from_path, to_path: f.to_path, status_code: Number(f.status_code), is_active: f.is_active } });
      this.toast.show("Redirect saved");
      this.edit.set(null);
      await this.load();
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not save the redirect");
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove(r: Rule): Promise<void> {
    if (!window.confirm(`Delete the redirect from ${r.from_path}?`)) return;
    try {
      await api(`/api/admin/redirects/${r.id}`, { method: "DELETE" });
      this.toast.show("Redirect deleted");
      await this.load();
    } catch (e) {
      this.toast.show(e instanceof ApiError ? e.message : "Could not delete", "error");
    }
  }
}
