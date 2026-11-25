/*
 * A small editor for a group of marketplace settings (Admin → Deals → Rules, Admin → Advertising → Settings, ...).
 * It reads the current values, edits only its own keys, checks the ranges the server accepts and saves them together.
 * Port of components/settings-block.tsx:
 *   <pc-settings-block title="Deal rules" sub="..." [fields]="FIELDS" saveLabel="Save deal rules" (saved)="..." />
 */

import { ChangeDetectionStrategy, Component, DestroyRef, type OnInit, inject, input, output, signal } from "@angular/core";
import { api, ApiError, quietly } from "../../core/api";
import { paiseToInput, rupees, toPaise } from "../../core/format";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, TextField, Toast } from "../../shared/ui/ui";

export type SettingField =
  | { k: string; kind: "bool"; label: string; hint: string }
  | { k: string; kind: "int"; label: string; hint: string; min: number; max: number; needs?: string }
  | { k: string; kind: "rupees"; label: string; hint: string; min: number; max: number; needs?: string };

type Values = Record<string, boolean | number>;

@Component({
  selector: "pc-settings-block",
  imports: [PageLoader, Button, ErrorNote, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!draft()) {
      @if (error()) {<pc-error-note [message]="error()" />} @else {<pc-page-loader />}
    } @else {
      <form (submit)="save($event)" class="flex max-w-3xl flex-col gap-3 rounded-xl bg-white p-5" data-testid="settings-block">
        <div>
          <h2 class="text-lg font-semibold">{{ title() }}</h2>
          @if (sub()) {<p class="text-sm text-ink-soft">{{ sub() }}</p>}
        </div>
        <pc-error-note [message]="error()" />
        <div class="grid gap-3 sm:grid-cols-2">
          @for (f of fields(); track f.k) {
            @if (f.kind === "bool") {
              <label class="flex items-start gap-3 rounded-lg border border-line p-3 sm:col-span-2">
                <input type="checkbox" class="mt-1 h-4 w-4 accent-peacock" [checked]="!!draft()![f.k]" (change)="set(f.k, $any($event.target).checked)" [attr.data-testid]="'toggle-' + f.k" />
                <span><span class="font-semibold">{{ f.label }}</span><br /><span class="text-sm text-ink-soft">{{ f.hint }}</span></span>
              </label>
            } @else {
              <pc-text-field [label]="f.label" [hint]="f.hint" [inputmode]="f.kind === 'rupees' ? 'decimal' : 'numeric'" [value]="str(f.k)" [disabled]="off(f)"
                [filter]="f.kind === 'rupees' ? undefined : digits" (valueChange)="set(f.k, $event)" />
            }
          }
        </div>
        <button pcButton type="submit" [loading]="busy()" class="self-start">{{ saveLabel() }}</button>
      </form>
    }
  `,
})
export class SettingsBlock implements OnInit {
  readonly title = input.required<string>();
  readonly sub = input<string | undefined>(undefined);
  readonly fields = input.required<SettingField[]>();
  readonly saveLabel = input("Save");
  readonly saved = output<Values>();
  private readonly toast = inject(Toast);
  protected readonly draft = signal<Record<string, string | boolean> | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly digits = (v: string) => v.replace(/\D/g, "");

  private live = true;
  constructor() {
    inject(DestroyRef).onDestroy(() => (this.live = false));
  }

  // the field list is fixed for each page: read once
  ngOnInit(): void {
    api<Values>("/api/admin/settings").then((v) => {
      if (!this.live) return;
      this.draft.set(Object.fromEntries(this.fields().map((f) => [f.k, f.kind === "bool" ? Boolean(v[f.k]) : f.kind === "rupees" ? paiseToInput(Number(v[f.k] ?? 0)) : String(v[f.k] ?? "")])));
    }).catch((e) => {
      quietly(e);
      if (this.live) this.error.set(e instanceof ApiError ? e.message : "Could not load the settings");
    });
  }

  protected str(k: string): string {
    return String(this.draft()?.[k] ?? "");
  }

  protected off(f: SettingField): boolean {
    return "needs" in f && f.needs ? !this.draft()?.[f.needs] : false;
  }

  protected set(k: string, v: string | boolean): void {
    this.draft.update((d) => (d ? { ...d, [k]: v } : d));
  }

  protected async save(e: Event): Promise<void> {
    e.preventDefault();
    const draft = this.draft();
    if (!draft) return;
    this.error.set(null);
    const body: Values = {};
    for (const f of this.fields()) {
      if (f.kind === "bool") {
        body[f.k] = Boolean(draft[f.k]);
        continue;
      }
      const raw = String(draft[f.k] ?? "");
      const n = f.kind === "rupees" ? toPaise(raw) : /^\d+$/.test(raw) ? Number(raw) : null;
      if (n === null || n < f.min || n > f.max) {
        this.error.set(f.kind === "rupees" ? `${f.label}: enter ${rupees(f.min)} to ${rupees(f.max)}` : `${f.label}: enter ${f.min} to ${f.max}`);
        return;
      }
      body[f.k] = n;
    }
    this.busy.set(true);
    try {
      const saved = await api<Values>("/api/admin/settings", { method: "PUT", body });
      this.toast.show(`${this.title()} saved`);
      this.saved.emit(saved);
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not save");
    } finally {
      this.busy.set(false);
    }
  }
}
