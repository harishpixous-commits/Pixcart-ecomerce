/* Edit a listing. Port of frontend/src/app/seller/products/[id]/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, effect, input, signal } from "@angular/core";
import { api } from "../../core/api";
import type { SellerProduct } from "../../core/types";
import { PageLoader } from "../../shared/ui/page-loader";
import { ErrorNote } from "../../shared/ui/ui";
import { ProductEditor } from "../shared/product-editor";

@Component({
  selector: "pc-seller-products-id-page",
  imports: [PageLoader, ErrorNote, ProductEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (error()) {
      <pc-error-note [message]="error()" />
    } @else if (!p()) {
      <pc-page-loader />
    } @else {
      <!-- a new editor after each save (status or time changed), like the reference's key -->
      @for (x of keyed(); track x.updated_at + "-" + x.status) {<pc-product-editor [product]="x" (saved)="p.set($event)" />}
    }
  `,
})
export class SellerProductsIdPage {
  readonly id = input.required<string>();
  protected readonly p = signal<SellerProduct | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly keyed = computed(() => (this.p() ? [this.p()!] : []));

  constructor() {
    effect(() => {
      const id = this.id();
      api<SellerProduct>(`/api/seller/products/${id}`).then((p) => this.p.set(p)).catch((e: Error) => this.error.set(e.message));
    });
  }
}
