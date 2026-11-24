/* Delivery partner sign-in with a one-time code (new or registered partners). Port of app/delivery/login/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from "@angular/core";
import { Router } from "@angular/router";
import { Bike, ShieldCheck } from "lucide-angular";
import { ApiError, api } from "../../core/api";
import { RouteState } from "../../core/route-state";
import { SessionService } from "../../core/session";
import type { User } from "../../core/types";
import { Logo } from "../../shared/shop/shop-chrome";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { Button, ErrorNote, TextField } from "../../shared/ui/ui";
import { CodeStep, countdown, safeNext } from "../../shop/auth/auth-forms";
import { FullLoader } from "../shell/delivery-app";

type Sent = { resend_in: number; expires_in: number; length: number; dev_otp?: string };

/** Where a partner goes after signing in: the app when approved, otherwise registration (which shows the review status). */
function landing(user: User, next: string) {
  if (user.delivery?.kyc_status === "approved") return next.startsWith("/delivery") && !next.startsWith("/delivery/login") ? next : "/delivery";
  return "/delivery/register";
}

@Component({
  selector: "pc-delivery-login",
  imports: [Icon, PcLink, Logo, Button, ErrorNote, TextField, CodeStep, FullLoader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!session.ready() || session.user()) {
      <pc-full-loader label="Signing you in" />
    } @else {
      <div class="flex min-h-screen flex-col bg-gradient-to-b from-peacock via-peacock to-peacock-dark">
        <header class="mx-auto flex w-full max-w-md items-center gap-3 px-4 py-3 text-white">
          <a pcLogo></a>
          <span class="rounded-full bg-white/15 px-2 py-0.5 text-xs font-semibold">Delivery partner</span>
        </header>
        <main class="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 pb-10">
          <div class="mb-6 text-white">
            <span class="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/15"><svg [pcIcon]="Bike" class="h-8 w-8" /></span>
            <h1 class="text-3xl font-bold">{{ step() === "phone" ? "Partner sign in" : "Enter the code" }}</h1>
            <p class="mt-1 text-white/80">{{ step() === "phone" ? "New or registered, just use your mobile number." : "We sent a one-time code by SMS." }}</p>
          </div>
          <div class="flex flex-col gap-4 rounded-3xl bg-white p-6 shadow-2xl shadow-black/30">
            <pc-error-note [message]="error()" />
            @if (step() === "phone") {
              <form (submit)="send($event)" class="flex flex-col gap-4">
                <pc-text-field label="Mobile number" type="tel" inputmode="numeric" autocomplete="tel-national" placeholder="98765 43210" [(value)]="phone"
                  [required]="true" [autofocus]="true" hint="10-digit Indian mobile number" class="[&_input]:h-12 [&_input]:text-lg" />
                <button pcButton type="submit" size="lg" [loading]="busy()" class="rounded-xl">Send code</button>
                <p class="text-center text-xs text-ink-faint">
                  By continuing you agree to the <a pcLink="/pages/terms" class="font-semibold text-peacock">terms of use</a> and <a pcLink="/pages/privacy" class="font-semibold text-peacock">privacy policy</a>.
                </p>
              </form>
            } @else if (sent(); as s) {
              <pc-code-step [phone]="phone()" [length]="s.length || 6" [devOtp]="s.dev_otp" [wait]="wait()" [busy]="busy()" verifyLabel="Verify and continue"
                (verify)="verify($event)" (resend)="send()" (changeNumber)="step.set('phone'); sent.set(null)" />
            }
          </div>
          <p class="mt-6 flex items-center justify-center gap-1.5 text-sm text-white/75"><svg [pcIcon]="ShieldCheck" class="h-4 w-4" /> Your number is only used to sign you in and contact you about deliveries.</p>
          <p class="mt-2 text-center text-sm text-white/75">Not a partner yet? <a pcLink="/delivery/join" class="font-semibold text-marigold">See how it works</a></p>
        </main>
      </div>
    }
  `,
})
export class DeliveryLogin {
  protected readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly route = inject(RouteState);
  private readonly next = computed(() => safeNext(this.route.param("next") ?? "/delivery"));
  protected readonly step = signal<"phone" | "code">("phone");
  protected readonly phone = signal("");
  protected readonly sent = signal<Sent | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly wait = countdown();
  protected readonly Bike = Bike;
  protected readonly ShieldCheck = ShieldCheck;
  private left = false;

  constructor() {
    // already signed in: go straight on
    effect(() => {
      const user = this.session.user();
      if (this.session.ready() && user && !this.left) {
        this.left = true;
        void this.router.navigateByUrl(landing(user, this.next()), { replaceUrl: true });
      }
    });
  }

  protected async send(e?: Event): Promise<void> {
    e?.preventDefault();
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await api<Sent>("/api/auth/otp/request", { method: "POST", body: { phone: this.phone(), purpose: "any" } });
      this.sent.set(r);
      this.step.set("code");
      this.wait.set(r.resend_in);
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not send the code");
    } finally {
      this.busy.set(false);
    }
  }

  protected async verify(code: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await api<{ access_token: string; user: User }>("/api/auth/otp/verify", { method: "POST", body: { phone: this.phone(), code, purpose: "any", accept_terms: true } });
      this.left = true;
      await this.session.signIn(r.access_token, r.user);
      void this.router.navigateByUrl(landing(r.user, this.next()), { replaceUrl: true });
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not verify the code");
      this.busy.set(false);
    }
  }
}
