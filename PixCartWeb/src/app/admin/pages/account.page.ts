/* Admin → My account: layout, two-step sign-in, password, signed-in devices. Port of frontend/src/app/admin/account/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import QRCode from "qrcode";
import { ADMIN_ME_REFRESH, AdminContext } from "../../core/admin";
import { api, ApiError } from "../../core/api";
import { passwordPolicy } from "../../core/password-policy";
import { SessionService } from "../../core/session";
import { LayoutPicker } from "../../shared/admin-shell/admin-shell";
import { PageHeader } from "../../shared/portal-shell";
import { Button, ErrorNote, Pill, TextField, Toast } from "../../shared/ui/ui";
import { SignedInDevices } from "../shared/signed-in-devices";

@Component({
  selector: "pc-admin-account-page",
  imports: [PageHeader, LayoutPicker, SignedInDevices, Button, ErrorNote, Pill, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex max-w-3xl flex-col gap-4" },
  template: `
    <pc-page-header title="My account" [sub]="sub()" />
    <section class="rounded-xl bg-white p-5" aria-labelledby="appearance-h" data-testid="appearance">
      <h2 id="appearance-h" class="text-lg font-semibold">Appearance</h2>
      <p class="mb-3 text-sm text-ink-soft">How the admin panel is laid out for you. Other staff keep their own choice.</p>
      <pc-layout-picker />
    </section>
    <section class="rounded-xl bg-white p-5">
      <div class="mb-2 flex items-center gap-2">
        <h2 class="text-lg font-semibold">Two-step sign-in</h2>
        @if (totpOn()) {<pc-pill tone="green">On</pc-pill>} @else {<pc-pill tone="red">Off</pc-pill>}
      </div>
      <p class="mb-3 text-ink-soft">Ask for a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password) every time you sign in. Strongly recommended for everyone with admin access.</p>
      <pc-error-note [message]="tError()" />
      @if (!totpOn() && !setup()) {<button pcButton (click)="startTotp()">Turn on two-step sign-in</button>}
      @if (setup(); as s) {
        <div class="flex flex-col gap-3 sm:flex-row">
          <img [src]="s.qr" alt="QR code for your authenticator app" class="h-[220px] w-[220px] rounded-lg border border-line" />
          <div class="flex flex-col gap-2">
            <p>1. Scan this code in your authenticator app.</p>
            <p class="text-sm text-ink-soft">Can't scan? Enter this key: <code class="break-all rounded bg-mist px-1">{{ s.secret }}</code></p>
            <p>2. Enter the 6-digit code it shows.</p>
            <pc-text-field label="Code" inputmode="numeric" [maxlength]="6" [value]="code()" (valueChange)="code.set($event)" [filter]="digits" />
            <button pcButton [disabled]="code().length !== 6" (click)="confirmTotp(true)">Turn on</button>
          </div>
        </div>
      }
      @if (totpOn()) {
        <div class="flex flex-col gap-2 sm:flex-row sm:items-end">
          <pc-text-field label="Your password" type="password" autocomplete="current-password" [value]="offPassword()" (valueChange)="offPassword.set($event)" />
          <pc-text-field label="Current code" inputmode="numeric" [maxlength]="6" [value]="code()" (valueChange)="code.set($event)" [filter]="digits" />
          <button pcButton variant="danger" [disabled]="code().length !== 6 || !offPassword()" (click)="confirmTotp(false)">Turn off</button>
        </div>
        <p class="mt-2 text-xs text-ink-faint">Turning it off needs your password and a current code. You get an email when it is turned off.</p>
      }
    </section>
    <section class="rounded-xl bg-white p-5">
      <h2 class="mb-3 text-lg font-semibold">Change password</h2>
      <form (submit)="changePassword($event)" class="flex flex-col gap-3">
        <pc-error-note [message]="pwError()" />
        <pc-text-field label="Current password" type="password" autocomplete="current-password" [value]="pw().current_password" (valueChange)="setPw('current_password', $event)" [required]="true" />
        <pc-text-field label="New password" type="password" autocomplete="new-password" [minlength]="policy().min" [value]="pw().new_password" (valueChange)="setPw('new_password', $event)" [required]="true"
          [hint]="policy().hint + '. You are signed out of every device, including this one.'" />
        <button pcButton type="submit" class="self-start">Change password</button>
      </form>
    </section>
    <pc-signed-in-devices />
  `,
})
export class AdminAccountPage {
  private readonly toast = inject(Toast);
  private readonly session = inject(SessionService);
  private readonly me = inject(AdminContext).me;
  protected readonly policy = passwordPolicy();
  protected readonly digits = (v: string) => v.replace(/\D/g, "");
  protected readonly pw = signal({ current_password: "", new_password: "" });
  protected readonly pwError = signal<string | null>(null);
  protected readonly totpOn = signal(this.me()?.totp_enabled ?? false);
  protected readonly setup = signal<{ secret: string; qr: string } | null>(null);
  protected readonly code = signal("");
  protected readonly offPassword = signal("");
  protected readonly tError = signal<string | null>(null);
  protected readonly sub = computed(() => {
    const user = this.session.user();
    return `${user?.name ?? ""}, ${user?.email ?? ""}, ${this.me()?.role_label ?? ""}`;
  });

  protected setPw(k: "current_password" | "new_password", v: string): void {
    this.pw.update((p) => ({ ...p, [k]: v }));
  }

  protected async changePassword(e: Event): Promise<void> {
    e.preventDefault();
    this.pwError.set(null);
    try {
      await api("/api/auth/password", { method: "POST", body: this.pw() });
      this.toast.show("Password changed. Please sign in again.");
      await this.session.signOut();
      window.location.assign(new URL("/admin/login", window.location.origin));
    } catch (err) {
      this.pwError.set(err instanceof ApiError ? err.message : "Could not change the password");
    }
  }

  protected async startTotp(): Promise<void> {
    this.tError.set(null);
    try {
      const r = await api<{ secret: string; uri: string }>("/api/auth/totp/setup", { method: "POST" });
      this.setup.set({ secret: r.secret, qr: await QRCode.toDataURL(r.uri, { margin: 1, width: 220 }) });
    } catch (err) {
      this.tError.set(err instanceof ApiError ? err.message : "Could not start");
    }
  }

  protected async confirmTotp(enable: boolean): Promise<void> {
    this.tError.set(null);
    try {
      const code = this.code();
      await api(`/api/auth/totp/${enable ? "enable" : "disable"}`, { method: "POST", body: enable ? { code } : { code, password: this.offPassword() } });
      this.totpOn.set(enable);
      window.dispatchEvent(new Event(ADMIN_ME_REFRESH)); // opens the panel if two-step was required
      this.setup.set(null);
      this.code.set("");
      this.offPassword.set("");
      this.toast.show(enable ? "Two-step sign-in is on" : "Two-step sign-in is off");
    } catch (err) {
      this.tError.set(err instanceof ApiError ? err.message : "That code did not work");
    }
  }
}
