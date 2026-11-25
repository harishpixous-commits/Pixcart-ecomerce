/*
 * A big, thumb-friendly upload box for the partner's photo and KYC documents. On phones it opens the camera
 * (back camera for documents, front camera for the selfie); PDFs work from a computer.
 * Port of components/delivery/upload-tile.tsx: <pc-upload-tile kind label hint [done] [preview] (doneChange)="set($event)" />
 */

import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, output, signal, viewChild } from "@angular/core";
import { Camera, CircleCheck, FileUp, Loader2, RefreshCw } from "lucide-angular";
import { ApiError, api } from "../../core/api";
import type { Partner } from "../../core/delivery-types";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { Toast, uid } from "../../shared/ui/ui";

@Component({
  selector: "pc-upload-tile",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-1.5", "[attr.data-testid]": "'upload-' + kind()" },
  template: `
    <label [attr.for]="id" [class]="labelCls()">
      @if (photo() && preview()) {
        <img [src]="preview()" alt="" class="h-16 w-16 shrink-0 rounded-full object-cover ring-4 ring-white" />
      } @else {
        <span [class]="done() ? 'flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-leaf text-white' : 'flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-peacock-light text-peacock'">
          @if (busy()) {<svg [pcIcon]="Loader2" class="h-6 w-6 animate-spin" />} @else if (done()) {<svg [pcIcon]="CircleCheck" class="h-7 w-7" />} @else if (photo()) {<svg [pcIcon]="Camera" class="h-7 w-7" />} @else {<svg [pcIcon]="FileUp" class="h-7 w-7" />}
        </span>
      }
      <span class="min-w-0 flex-1">
        <span class="block font-semibold">{{ label() }}</span>
        <span class="block text-sm text-ink-soft">{{ busy() ? "Uploading…" : done() ? "Uploaded. Tap to replace." : hint() ?? (photo() ? "Take a clear selfie" : "Photo or PDF, up to 5 MB") }}</span>
      </span>
      @if (done() && !busy()) {<svg [pcIcon]="RefreshCw" class="h-5 w-5 shrink-0 text-ink-faint group-hover:text-peacock" />}
      <input #file [id]="id" type="file" class="sr-only" [disabled]="disabled() || busy()"
        [accept]="photo() ? 'image/*' : 'image/*,application/pdf'" [attr.capture]="photo() ? 'user' : null" (change)="picked($event)" />
    </label>
  `,
})
export class UploadTile {
  readonly kind = input.required<"photo" | "license" | "id_proof" | "vehicle_rc">();
  readonly label = input.required<string>();
  readonly hint = input<string | undefined>(undefined);
  readonly done = input(false);
  readonly preview = input<string | undefined>(undefined);
  readonly disabled = input(false);
  /** the reference's onDone(partner) */
  readonly uploaded = output<Partner>();
  private readonly toast = inject(Toast);
  private readonly file = viewChild<ElementRef<HTMLInputElement>>("file");
  protected readonly id = uid("upload");
  protected readonly busy = signal(false);
  protected readonly photo = computed(() => this.kind() === "photo");
  protected readonly Camera = Camera;
  protected readonly CircleCheck = CircleCheck;
  protected readonly FileUp = FileUp;
  protected readonly Loader2 = Loader2;
  protected readonly RefreshCw = RefreshCw;
  protected readonly labelCls = computed(() => cx("group relative flex cursor-pointer items-center gap-4 rounded-2xl border-2 border-dashed p-4 transition-colors",
    this.done() ? "border-leaf/40 bg-leaf-light/40" : "border-line bg-white hover:border-peacock hover:bg-peacock-light/30",
    (this.disabled() || this.busy()) && "pointer-events-none opacity-60"));

  protected picked(e: Event): void {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void this.upload(f);
  }

  private async upload(file: File): Promise<void> {
    this.busy.set(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const p = await api<Partner>(`/api/delivery/me/docs/${this.kind()}`, { method: "POST", form });
      this.uploaded.emit(p);
      this.toast.show(this.photo() ? "Photo saved" : `${this.label()} uploaded`);
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not upload. Try a clearer photo or a smaller file.", "error");
    } finally {
      this.busy.set(false);
      const el = this.file()?.nativeElement;
      if (el) el.value = "";
    }
  }
}
