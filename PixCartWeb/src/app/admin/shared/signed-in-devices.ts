/*
 * Signed-in devices: where this account is signed in, and one button to sign every other device out (a lost phone,
 * a shared computer). Used on the shopper's Account page and on Admin → My account. This device stays signed in.
 * Port of components/signed-in-devices.tsx: <pc-signed-in-devices />
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { Laptop, LogOut, Smartphone } from "lucide-angular";
import { api, ApiError, quietly, refreshSession } from "../../core/api";
import { dateTime } from "../../core/format";
import { Icon } from "../../shared/ui/icon";
import { Button, ErrorNote, Modal, Toast } from "../../shared/ui/ui";

type Device = { id: string; device: string; last_active: string; expires_at: string; current: boolean };

const PHONE = /Android|iPhone|iPad|Partner app/;

@Component({
  selector: "pc-signed-in-devices",
  imports: [Icon, Button, ErrorNote, Modal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <section class="rounded-xl bg-white p-5" aria-labelledby="devices-h" data-testid="signed-in-devices">
      <div class="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="devices-h" class="text-lg font-semibold">Signed-in devices</h2>
          <p class="text-sm text-ink-soft">Where your account is signed in now. Sign the others out if you lost a phone or used a shared computer.</p>
        </div>
        <button pcButton variant="secondary" size="sm" [disabled]="others() === 0" (click)="confirm.set(true)" data-testid="sign-out-others">
          <svg [pcIcon]="LogOut" class="h-4 w-4" /> Sign out other devices
        </button>
      </div>
      @if (rows() === null) {
        <ul class="space-y-2" aria-hidden="true">@for (i of [0, 1]; track i) {<li class="h-12 animate-pulse rounded-lg bg-mist"></li>}</ul>
      } @else {
        <ul class="divide-y divide-line">
          @for (r of rows(); track r.id) {
            <li class="flex items-center gap-3 py-2.5">
              <svg [pcIcon]="phone.test(r.device) ? Smartphone : Laptop" class="h-5 w-5 shrink-0 text-ink-soft" />
              <div class="min-w-0 flex-1">
                <p class="font-medium">{{ r.device }}{{ " " }}@if (r.current) {<span class="ml-1 rounded-full bg-leaf-light px-2 text-xs font-bold leading-5 text-leaf">This device</span>}</p>
                <p class="text-xs text-ink-faint">Last active {{ dateTime(r.last_active) }}</p>
              </div>
            </li>
          }
          @if (rows()!.length === 0) {<li class="py-2 text-sm text-ink-soft">No other devices.</li>}
        </ul>
      }
      <pc-modal [open]="confirm()" (close)="confirm.set(false)" title="Sign out other devices?">
        <p class="text-ink-soft">{{ others() === 1 ? "1 other device" : others() + " other devices" }} will be signed out straight away and must sign in again. This device stays signed in.</p>
        <pc-error-note [message]="error()" />
        <div class="mt-4 flex justify-end gap-2">
          <button pcButton variant="ghost" (click)="confirm.set(false)">Cancel</button>
          <button pcButton [loading]="busy()" (click)="signOutOthers()" data-testid="sign-out-others-confirm">Sign them out</button>
        </div>
      </pc-modal>
    </section>
  `,
})
export class SignedInDevices {
  private readonly toast = inject(Toast);
  protected readonly LogOut = LogOut;
  protected readonly Smartphone = Smartphone;
  protected readonly Laptop = Laptop;
  protected readonly phone = PHONE;
  protected readonly dateTime = dateTime;
  protected readonly rows = signal<Device[] | null>(null);
  protected readonly confirm = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly others = computed(() => (this.rows() ?? []).filter((r) => !r.current).length);

  constructor() {
    void this.load();
  }

  private load(): Promise<void> {
    return api<{ sessions: Device[] }>("/api/auth/sessions").then((r) => this.rows.set(r.sessions)).catch(quietly);
  }

  protected async signOutOthers(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await api<{ signed_out: number }>("/api/auth/sessions/sign-out-others", { method: "POST" });
      await refreshSession(); // this device renews its access with its own session, which was kept
      this.confirm.set(false);
      this.toast.show(r.signed_out === 1 ? "1 other device was signed out" : `${r.signed_out} other devices were signed out`);
      await this.load();
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not sign the other devices out. Try again.");
    } finally {
      this.busy.set(false);
    }
  }
}
