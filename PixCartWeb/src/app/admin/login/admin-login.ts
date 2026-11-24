/* Staff sign-in (email, password and, when on, the authenticator code). Port of app/admin/login/page.tsx. */

import { ChangeDetectionStrategy, Component, effect, inject, signal } from "@angular/core";
import { Router } from "@angular/router";
import { ApiError, api } from "../../core/api";
import { SessionService } from "../../core/session";
import type { User } from "../../core/types";
import { Logo } from "../../shared/shop/shop-chrome";
import { Button, ErrorNote, TextField } from "../../shared/ui/ui";

@Component({
  selector: "pc-admin-login",
  imports: [Logo, Button, ErrorNote, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex min-h-screen items-center justify-center bg-peacock px-4" },
  template: `
    <div class="w-full max-w-sm overflow-hidden rounded-2xl bg-white">
      <div class="bg-peacock-dark px-6 py-5">
        <a pcLogo></a>
        <p class="text-white/80">Admin sign in</p>
      </div>
      <form (submit)="submit($event)" class="flex flex-col gap-4 p-6">
        <pc-error-note [message]="error()" />
        <pc-text-field label="Email" type="email" autocomplete="username" [(value)]="email" [required]="true" [autofocus]="true" />
        <pc-text-field label="Password" type="password" autocomplete="current-password" [(value)]="password" [required]="true" />
        @if (needCode()) {
          <pc-text-field label="6-digit code from your authenticator app" inputmode="numeric" autocomplete="one-time-code" [maxlength]="6" [(value)]="code"
            [filter]="digits" [required]="true" [autofocus]="true" />
        }
        <button pcButton type="submit" size="lg" [loading]="busy()">{{ needCode() ? "Verify and sign in" : "Sign in" }}</button>
      </form>
    </div>
  `,
})
export class AdminLogin {
  private readonly router = inject(Router);
  private readonly session = inject(SessionService);
  protected readonly email = signal("");
  protected readonly password = signal("");
  protected readonly code = signal("");
  protected readonly needCode = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly digits = (v: string) => v.replace(/\D/g, "");

  constructor() {
    effect(() => {
      if (this.session.ready() && this.session.user()?.is_admin) void this.router.navigateByUrl("/admin", { replaceUrl: true });
    });
  }

  protected async submit(e: Event): Promise<void> {
    e.preventDefault();
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await api<{ access_token: string; user: User }>("/api/auth/login", { method: "POST", body: { email: this.email(), password: this.password(), totp: this.code() } });
      if (!r.user.is_admin) {
        this.error.set("This account does not have admin access");
        return;
      }
      await this.session.signIn(r.access_token, r.user);
      void this.router.navigateByUrl("/admin", { replaceUrl: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === "totp_required") {
        this.needCode.set(true);
        this.error.set(null);
        return;
      }
      this.error.set(err instanceof ApiError ? err.message : "Could not sign in");
    } finally {
      this.busy.set(false);
    }
  }
}
