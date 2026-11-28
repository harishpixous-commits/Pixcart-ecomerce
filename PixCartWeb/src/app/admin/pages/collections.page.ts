/* Admin → Collections: pages of chosen products at /collections/<link name>. Port of frontend/src/app/admin/collections/page.tsx. */

import { ChangeDetectionStrategy, Component, signal } from "@angular/core";
import { ApiError, api } from "../../core/api";
import { PageHeader } from "../../shared/portal-shell";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, ErrorNote, Modal, TextField, Textarea, Toast } from "../../shared/ui/ui";
import { inject } from "@angular/core";

type Col = {
  id: string; slug: string; title: string; description: string; image_url: string; is_active: boolean; position: number;
  product_slugs: string[]; category_slug: string; brand: string; tag?: string; min_price_paise: number | null; max_price_paise: number | null;
};
type Form = { title: string; slug: string; description: string; image_url: string; is_active: boolean; products: string; category_slug: string; brand: string; tag: string; min: string; max: string };
const EMPTY: Form = { title: "", slug: "", description: "", image_url: "", is_active: true, products: "", category_slug: "", brand: "", tag: "", min: "", max: "" };
const toPaise = (v: string) => (v.trim() ? Math.round(Number(v) * 100) : null);

@Component({
  selector: "pc-admin-collections-page",
  imports: [PageHeader, PageLoader, Button, EmptyState, ErrorNote, Modal, TextField, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <pc-page-header title="Collections" sub="Pages of chosen products, like Diwali gifts or Under 999. Customers open them at /collections/<link name>." [withActions]="true">
      <button actions pcButton (click)="open()">New collection</button>
    </pc-page-header>
    @if (!items()) { <pc-page-loader /> }
    @else if (items()!.length === 0) { <pc-empty-state title="No collections yet" /> }
    @else {
      <ul class="flex flex-col gap-2">
        @for (c of items()!; track c.id) {
          <li class="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white p-4">
            <div>
              <p class="font-semibold">{{ c.title }} @if (!c.is_active) { <span class="text-sm text-ink-faint">(hidden)</span> }</p>
              <p class="text-sm text-ink-soft">/collections/{{ c.slug }} · {{ c.product_slugs.length ? c.product_slugs.length + ' chosen products' : 'by rules' }}</p>
            </div>
            <div class="flex gap-2">
              <button pcButton variant="secondary" (click)="open(c)">Edit</button>
              <button pcButton variant="ghost" (click)="remove(c)">Delete</button>
            </div>
          </li>
        }
      </ul>
    }
    <pc-modal [open]="edit() !== null" (close)="edit.set(null)" [title]="editId() ? 'Edit collection' : 'New collection'" [wide]="true">
      @if (edit(); as f) {
        <div class="flex flex-col gap-3">
          <pc-text-field label="Title" [value]="f.title" maxlength="120" (valueChange)="set({ title: $event })" />
          <pc-text-field label="Link name" hint="Leave empty to make it from the title." [value]="f.slug" maxlength="80" (valueChange)="set({ slug: $event })" />
          <label class="flex flex-col gap-1 text-sm font-medium">Description
            <textarea pcTextarea rows="2" maxlength="1000" [value]="f.description" (input)="set({ description: $any($event.target).value })"></textarea>
          </label>
          <pc-text-field label="Banner image address (optional)" [value]="f.image_url" maxlength="500" (valueChange)="set({ image_url: $event })" />
          <label class="flex flex-col gap-1 text-sm font-medium">Chosen products
            <textarea pcTextarea rows="2" [value]="f.products" (input)="set({ products: $any($event.target).value })"></textarea>
            <span class="text-xs font-normal text-ink-faint">Product link names (the last part of a product page address), comma separated, in the order shown. If you fill this, the rules below are not used.</span>
          </label>
          <div class="grid gap-3 sm:grid-cols-2">
            <pc-text-field label="Rule: category link name" [value]="f.category_slug" (valueChange)="set({ category_slug: $event })" />
            <pc-text-field label="Rule: brand" [value]="f.brand" (valueChange)="set({ brand: $event })" />
            <pc-text-field label="Rule: product tag" [value]="f.tag" (valueChange)="set({ tag: $event })" />
            <pc-text-field label="Rule: lowest price (₹)" type="number" min="0" [value]="f.min" (valueChange)="set({ min: $event })" />
            <pc-text-field label="Rule: highest price (₹)" type="number" min="0" [value]="f.max" (valueChange)="set({ max: $event })" />
          </div>
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" [checked]="f.is_active" (change)="set({ is_active: $any($event.target).checked })" />Shown to customers</label>
          <pc-error-note [message]="error()" />
          <button pcButton [loading]="busy()" (click)="save()">Save collection</button>
        </div>
      }
    </pc-modal>
  `,
})
export class AdminCollectionsPage {
  private readonly toast = inject(Toast);
  protected readonly items = signal<Col[] | null>(null);
  protected readonly edit = signal<Form | null>(null);
  protected readonly editId = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.items.set((await api<{ items: Col[] }>("/api/admin/collections")).items);
    } catch {
      this.items.set([]);
    }
  }

  protected set(patch: Partial<Form>): void {
    this.edit.update((f) => (f ? { ...f, ...patch } : f));
  }

  protected open(c?: Col): void {
    this.error.set(null);
    this.editId.set(c?.id ?? null);
    this.edit.set(c ? { title: c.title, slug: c.slug, description: c.description, image_url: c.image_url, is_active: c.is_active, products: c.product_slugs.join(", "),
      category_slug: c.category_slug, brand: c.brand, tag: c.tag ?? "", min: c.min_price_paise == null ? "" : String(c.min_price_paise / 100), max: c.max_price_paise == null ? "" : String(c.max_price_paise / 100) } : EMPTY);
  }

  protected async save(): Promise<void> {
    const f = this.edit();
    if (!f) return;
    this.busy.set(true);
    this.error.set(null);
    const body = { title: f.title, slug: f.slug, description: f.description, image_url: f.image_url, is_active: f.is_active, position: 0,
      product_slugs: f.products.split(",").map((s) => s.trim()).filter(Boolean), category_slug: f.category_slug, brand: f.brand, tag: f.tag, min_price_paise: toPaise(f.min), max_price_paise: toPaise(f.max) };
    const id = this.editId();
    try {
      await api(id ? `/api/admin/collections/${id}` : "/api/admin/collections", { method: id ? "PUT" : "POST", body });
      this.toast.show("Collection saved");
      this.edit.set(null);
      await this.load();
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not save the collection");
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove(c: Col): Promise<void> {
    if (!window.confirm(`Delete the collection "${c.title}"? Its page stops working. Products are not touched.`)) return;
    try {
      await api(`/api/admin/collections/${c.id}`, { method: "DELETE" });
      this.toast.show("Collection deleted");
      await this.load();
    } catch (e) {
      this.toast.show(e instanceof ApiError ? e.message : "Could not delete", "error");
    }
  }
}
