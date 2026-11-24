/*
 * Sign in and Create account are separate, as on most Indian shopping sites:
 * - Sign in: mobile → one-time code. A number without an account is sent to Create account.
 * - Create account: name, mobile, email (per Admin → Sign-in and accounts), terms → one-time code.
 * Both work for customers and sellers; "next" decides where the person lands (e.g. /seller/onboarding).
 * Port of components/auth/auth-forms.tsx: <pc-auth-card>, <pc-code-step>, <pc-sign-in-form>, <pc-sign-up-form>,
 * safeNext(), pretty(), countdown().
 */

import { ChangeDetectionStrategy, Component, DestroyRef, booleanAttribute, computed, effect, inject, input, output, signal, untracked, type WritableSignal } from "@angular/core";
import { Router } from "@angular/router";
import { CircleCheck, FlaskConical, ShieldCheck, Store } from "lucide-angular";
import { ApiError, api, quietly } from "../../core/api";
import { RouteState } from "../../core/route-state";
import { SessionService } from "../../core/session";
import { SiteService } from "../../core/site";
import type { User } from "../../core/types";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { Button, ErrorNote, TextField } from "../../shared/ui/ui";

type Options = { customer_signup: boolean; seller_signup: boolean; signup_email: "optional" | "required" | "hidden"; otp_length: number; dev_otp: boolean };
type Sent = { resend_in: number; expires_in: number; length: number; dev_otp?: string };
type Verified = { access_token: string; user: User; is_new: boolean };

export function safeNext(raw: string | null) {
  // Only same-site paths; never an absolute or protocol-relative URL (open-redirect guard).
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

const digits = (v: string) => v.replace(/\D/g, "").slice(-10);
export const pretty = (v: string) => { const d = digits(v); return d.length === 10 ? `+91 ${d.slice(0, 5)} ${d.slice(5)}` : v; };

/** Sign-up options (/api/auth/options), null until loaded. */
function options() {
  const o = signal<Options | null>(null);
  api<Options>("/api/auth/options").then((x) => o.set(x)).catch(quietly);
  return o;
}

/** Seconds left before a new code can be sent; set it and it counts down by itself (useCountdown). */
export function countdown(): WritableSignal<number> {
  const wait = signal(0);
  let t: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    const w = wait();
    clearTimeout(t);
    if (w > 0) t = setTimeout(() => wait.set(w - 1), 1000);
  });
  inject(DestroyRef).onDestroy(() => clearTimeout(t));
  return wait;
}

/** Sends a signed-in person on; not after signing in here, so the name step for old accounts still shows. */
function leaveIfSignedIn(next: () => string) {
  const session = inject(SessionService);
  const router = inject(Router);
  let checked = false;
  effect(() => {
    if (!session.ready() || checked) return;
    checked = true;
    if (session.user()) untracked(() => void router.navigateByUrl(next(), { replaceUrl: true }));
  });
}

@Component({
  selector: "pc-auth-card",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block overflow-hidden rounded-2xl bg-white shadow-sm" },
  template: `
    <div class="bg-peacock px-6 pb-5 pt-6 text-white">
      @if (seller()) {<p class="mb-1 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-semibold"><svg [pcIcon]="Store" class="h-3.5 w-3.5" />Seller hub</p>}
      <h1 class="text-2xl font-bold">{{ title() }}</h1>
      <p class="mt-1 text-white/85">{{ subtitle() }}</p>
    </div>
    <div class="awning" aria-hidden="true"></div>
    <div class="flex flex-col gap-4 p-6 pt-3"><ng-content /></div>
  `,
})
export class AuthCard {
  readonly title = input.required<string>();
  readonly subtitle = input.required<string>();
  readonly seller = input(false);
  protected readonly Store = Store;
}

@Component({
  selector: "pc-code-step",
  imports: [Icon, TextField, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <form (submit)="$event.preventDefault(); verify.emit(code())" class="flex flex-col gap-4">
      <p class="text-sm text-ink-soft">Enter the {{ length() }}-digit code sent to <b class="text-ink">{{ pretty(phone()) }}</b>.</p>
      <pc-text-field label="One-time code" inputmode="numeric" autocomplete="one-time-code" [maxlength]="length()" [(value)]="code" [filter]="onlyDigits"
        required autofocus class="[&_input]:text-lg [&_input]:tracking-[0.4em]" />
      @if (devOtp()) {
        <div class="flex items-center justify-between gap-3 rounded-lg border border-dashed border-marigold bg-marigold-light px-3 py-2 text-sm" role="status">
          <span class="flex items-center gap-2">
            <svg [pcIcon]="FlaskConical" class="h-4 w-4 shrink-0 text-marigold-dark" />
            <span>Test mode, no SMS sent. Your code is <b class="font-mono text-base tracking-widest" data-testid="dev-otp">{{ devOtp() }}</b></span>
          </span>
          <button type="button" (click)="code.set(devOtp()!)" class="shrink-0 rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-peacock ring-1 ring-peacock/30">Fill in</button>
        </div>
      }
      <button pcButton type="submit" size="lg" [loading]="busy()" [disabled]="code().length < length()">{{ verifyLabel() }}</button>
      <div class="flex items-center justify-between text-sm">
        <button type="button" class="font-semibold text-peacock" (click)="changeNumber.emit()">Change number</button>
        <button type="button" class="font-semibold text-peacock disabled:text-ink-faint" [disabled]="wait() > 0 || busy()" (click)="resend.emit()">
          {{ wait() > 0 ? "Resend code in " + wait() + "s" : "Resend code" }}
        </button>
      </div>
      <p class="flex items-center gap-1.5 text-xs text-ink-faint"><svg [pcIcon]="ShieldCheck" class="h-3.5 w-3.5" />We never ask for this code on a call. Do not share it.</p>
    </form>
  `,
})
export class CodeStep {
  readonly phone = input.required<string>();
  readonly length = input.required<number>();
  readonly devOtp = input<string | undefined>(undefined);
  readonly wait = input.required<number>();
  readonly busy = input(false, { transform: booleanAttribute });
  readonly verifyLabel = input.required<string>();
  readonly verify = output<string>();
  readonly resend = output<void>();
  readonly changeNumber = output<void>();
  protected readonly code = signal("");
  protected readonly pretty = pretty;
  protected readonly onlyDigits = (v: string) => v.replace(/\D/g, "");
  protected readonly FlaskConical = FlaskConical;
  protected readonly ShieldCheck = ShieldCheck;
}

/* ---------------------------------------------------------------- sign in */

@Component({
  selector: "pc-sign-in-form",
  imports: [AuthCard, CodeStep, TextField, Button, ErrorNote, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-auth-card [seller]="seller()" [title]="title()" [subtitle]="subtitle()">
      <pc-error-note [message]="error()" />
      @if (step() === "phone") {
        <form (submit)="send($event)" class="flex flex-col gap-4">
          <pc-text-field label="Mobile number" type="tel" inputmode="numeric" autocomplete="tel-national" placeholder="98765 43210" [value]="phone()"
            (valueChange)="phone.set($event); noAccount.set(false)" required autofocus hint="10-digit Indian mobile number" />
          @if (noAccount()) {
            <div class="rounded-lg border border-peacock/30 bg-peacock-light p-3 text-sm" role="alert">
              <p class="font-semibold">No account uses {{ pretty(phone()) }} yet.</p>
              @if (canSignup()) {
                <p class="mt-0.5">New here? <a [pcLink]="signupHref()" class="font-semibold text-peacock underline">Create {{ seller() ? "your seller account" : "an account" }}</a> with this number.</p>
              } @else {
                <p class="mt-0.5">New accounts are paused right now. Please try again later.</p>
              }
            </div>
          }
          <button pcButton type="submit" size="lg" [loading]="busy()">Send code</button>
        </form>
      }
      @if (step() === "code" && sent()) {
        <pc-code-step [phone]="phone()" [length]="sent()!.length || 6" [devOtp]="sent()!.dev_otp" [wait]="wait()" [busy]="busy()" verifyLabel="Verify and continue"
          (verify)="verify($event)" (resend)="send()" (changeNumber)="step.set('phone'); sent.set(null)" />
      }
      @if (step() === "name") {
        <form (submit)="saveName($event)" class="flex flex-col gap-4">
          <pc-text-field label="Your name" autocomplete="name" [(value)]="name" required minlength="1" autofocus />
          <button pcButton type="submit" size="lg" [loading]="busy()">Continue</button>
        </form>
      }
      @if (step() === "phone" && canSignup()) {
        <div class="border-t border-line pt-4 text-center text-sm">
          {{ seller() ? "New seller?" : "New to " + site().brand_name + "?" }}
          <a [pcLink]="signupHref()" class="font-semibold text-peacock">{{ seller() ? "Create your seller account" : "Create an account" }}</a>
        </div>
      }
    </pc-auth-card>
  `,
})
export class SignInForm {
  protected readonly site = inject(SiteService).site;
  private readonly router = inject(Router);
  private readonly route = inject(RouteState);
  private readonly session = inject(SessionService);
  protected readonly next = computed(() => safeNext(this.route.param("next")));
  protected readonly seller = computed(() => this.next().startsWith("/seller"));
  private readonly options = options();
  protected readonly step = signal<"phone" | "code" | "name">("phone");
  protected readonly phone = signal(this.route.param("phone") ?? "");
  protected readonly sent = signal<Sent | null>(null);
  protected readonly name = signal("");
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly noAccount = signal(false);
  protected readonly wait = countdown();
  protected readonly pretty = pretty;
  protected readonly signupHref = computed(() =>
    `/signup?next=${encodeURIComponent(this.next())}${this.seller() ? "&seller=1" : ""}${digits(this.phone()).length === 10 ? `&phone=${digits(this.phone())}` : ""}`);
  protected readonly canSignup = computed(() => { const o = this.options(); return o ? (this.seller() ? o.seller_signup : o.customer_signup) : true; });
  protected readonly title = computed(() => (this.step() === "name" ? `Welcome to ${this.site().brand_name}` : this.seller() ? "Seller sign in" : "Sign in"));
  protected readonly subtitle = computed(() => this.step() === "phone"
    ? (this.seller() ? "Use the mobile number of your seller account." : "Sign in with your mobile number. We will send you a one-time code.")
    : this.step() === "code" ? "Check your messages." : "What should we call you?");

  constructor() {
    leaveIfSignedIn(() => this.next());
  }

  protected async send(e?: Event): Promise<void> {
    e?.preventDefault();
    this.busy.set(true);
    this.error.set(null);
    this.noAccount.set(false);
    try {
      const r = await api<Sent>("/api/auth/otp/request", { method: "POST", body: { phone: this.phone(), purpose: "signin" } });
      this.sent.set(r);
      this.step.set("code");
      this.wait.set(r.resend_in);
    } catch (err) {
      if (err instanceof ApiError && err.code === "no_account") this.noAccount.set(true);
      else this.error.set(err instanceof ApiError ? err.message : "Could not send the code");
    } finally {
      this.busy.set(false);
    }
  }

  protected async verify(code: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await api<Verified>("/api/auth/otp/verify", { method: "POST", body: { phone: this.phone(), code, purpose: "signin" } });
      await this.session.signIn(r.access_token, r.user);
      if (!r.user.name) this.step.set("name");
      else void this.router.navigateByUrl(this.next(), { replaceUrl: true });
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : "Could not verify the code");
    } finally {
      this.busy.set(false);
    }
  }

  protected async saveName(e: Event): Promise<void> {
    e.preventDefault();
    this.busy.set(true);
    try {
      await api("/api/auth/me", { method: "PATCH", body: { name: this.name() } });
      void this.router.navigateByUrl(this.next(), { replaceUrl: true });
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : "Could not save your name");
    } finally {
      this.busy.set(false);
    }
  }
}

/* ---------------------------------------------------------------- create account */

@Component({
  selector: "pc-sign-up-form",
  imports: [AuthCard, CodeStep, TextField, Button, ErrorNote, PcLink, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (options() && !open()) {
      <pc-auth-card [seller]="seller()" [title]="seller() ? 'Seller registration' : 'Create account'" subtitle="New accounts are paused right now.">
        <p class="text-sm text-ink-soft">Please try again later. If you already have an account, you can <a [pcLink]="signinHref()" class="font-semibold text-peacock">sign in</a>.</p>
      </pc-auth-card>
    } @else {
      <pc-auth-card [seller]="seller()" [title]="seller() ? 'Create your seller account' : 'Create your ' + site().brand_name + ' account'"
        [subtitle]="step() === 'code' ? 'Almost done. Check your messages.' : seller() ? 'Step 1 of 3: your login. Next, your business details, then our team verifies them.' : 'It takes less than a minute.'">
        @if (seller() && step() === "details") {
          <ol class="grid grid-cols-3 gap-2 text-center text-xs">
            @for (s of steps; track s; let i = $index) {
              <li [class]="i === 0 ? 'rounded-lg px-2 py-1.5 bg-peacock text-white' : 'rounded-lg px-2 py-1.5 bg-mist text-ink-soft'">{{ i + 1 }}. {{ s }}</li>
            }
          </ol>
        }
        <pc-error-note [message]="error()" />
        @if (step() === "details") {
          <form (submit)="send($event)" class="flex flex-col gap-4" novalidate>
            <pc-text-field [label]="seller() ? 'Your full name (owner)' : 'Full name'" autocomplete="name" [(value)]="name" [error]="fields()['name']" autofocus />
            <pc-text-field label="Mobile number" type="tel" inputmode="numeric" autocomplete="tel-national" placeholder="98765 43210" [value]="phone()"
              (valueChange)="phone.set($event); exists.set(false)" [error]="fields()['phone']" hint="You will sign in with this number" />
            @if (exists()) {
              <div class="rounded-lg border border-peacock/30 bg-peacock-light p-3 text-sm" role="alert">
                <p class="font-semibold">{{ pretty(phone()) }} already has an account.</p>
                <p class="mt-0.5"><a [pcLink]="signinHref()" class="font-semibold text-peacock underline">Sign in instead</a>{{ seller() ? " and continue to your seller registration." : "." }}</p>
              </div>
            }
            @if (emailMode() !== "hidden") {
              <pc-text-field [label]="'Email' + (emailMode() === 'optional' ? ' (optional)' : '')" type="email" autocomplete="email" [(value)]="email"
                [error]="fields()['email']" hint="For invoices and order updates" />
            }
            <label class="flex items-start gap-2 text-sm">
              <input type="checkbox" class="mt-0.5 h-4 w-4 accent-peacock" [checked]="terms()" (change)="terms.set($any($event.target).checked)" />
              <span>I agree to the <a pcLink="/pages/terms" target="_blank" class="font-semibold text-peacock">terms of use</a> and <a pcLink="/pages/privacy" target="_blank" class="font-semibold text-peacock">privacy policy</a>.
                @if (fields()["terms"]) {<span class="block text-vermilion">{{ fields()["terms"] }}</span>}</span>
            </label>
            <label class="flex items-start gap-2 text-sm text-ink-soft">
              <input type="checkbox" class="mt-0.5 h-4 w-4 accent-peacock" [checked]="offers()" (change)="offers.set($any($event.target).checked)" />
              <span>Send me offers and new arrivals (you can turn this off any time)</span>
            </label>
            <button pcButton type="submit" size="lg" [loading]="busy()">Continue</button>
          </form>
        }
        @if (step() === "code" && sent()) {
          <pc-code-step [phone]="phone()" [length]="sent()!.length || 6" [devOtp]="sent()!.dev_otp" [wait]="wait()" [busy]="busy()" verifyLabel="Verify and create account"
            (verify)="verify($event)" (resend)="send()" (changeNumber)="step.set('details'); sent.set(null)" />
        }
        @if (step() === "details") {
          <div class="border-t border-line pt-4 text-center text-sm">
            Already have an account? <a [pcLink]="signinHref()" class="font-semibold text-peacock">Sign in</a>
          </div>
        }
        @if (step() === "details" && !seller()) {
          <p class="flex items-center justify-center gap-1.5 text-xs text-ink-faint"><svg [pcIcon]="CircleCheck" class="h-3.5 w-3.5" />Want to sell on {{ site().brand_name }}? <a pcLink="/sell" class="font-semibold text-peacock">Become a seller</a></p>
        }
      </pc-auth-card>
    }
  `,
})
export class SignUpForm {
  protected readonly site = inject(SiteService).site;
  private readonly router = inject(Router);
  private readonly route = inject(RouteState);
  private readonly session = inject(SessionService);
  protected readonly seller = computed(() => this.route.param("seller") === "1" || safeNext(this.route.param("next")).startsWith("/seller"));
  protected readonly next = computed(() => safeNext(this.route.param("next") ?? (this.seller() ? "/seller/onboarding" : "/")));
  protected readonly options = options();
  protected readonly step = signal<"details" | "code">("details");
  protected readonly name = signal("");
  protected readonly phone = signal(this.route.param("phone") ?? "");
  protected readonly email = signal("");
  protected readonly terms = signal(false);
  protected readonly offers = signal(false);
  protected readonly sent = signal<Sent | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly fields = signal<Record<string, string>>({});
  protected readonly exists = signal(false);
  protected readonly wait = countdown();
  protected readonly pretty = pretty;
  protected readonly steps = ["Your login", "Business details", "Verification"];
  protected readonly CircleCheck = CircleCheck;
  protected readonly emailMode = computed(() => this.options()?.signup_email ?? "optional");
  protected readonly open = computed(() => { const o = this.options(); return o ? (this.seller() ? o.seller_signup : o.customer_signup) : true; });
  protected readonly signinHref = computed(() => `/login?next=${encodeURIComponent(this.next())}${digits(this.phone()).length === 10 ? `&phone=${digits(this.phone())}` : ""}`);

  constructor() {
    leaveIfSignedIn(() => this.next());
  }

  protected async send(e?: Event): Promise<void> {
    e?.preventDefault();
    this.error.set(null);
    this.exists.set(false);
    const problems: Record<string, string> = {};
    if (this.name().trim().length < 2) problems["name"] = "Enter your full name";
    if (digits(this.phone()).length !== 10) problems["phone"] = "Enter a 10-digit mobile number";
    if (this.emailMode() === "required" && !this.email().trim()) problems["email"] = "Enter your email";
    if (!this.terms()) problems["terms"] = "Please accept to continue";
    this.fields.set(problems);
    if (Object.keys(problems).length) return;
    this.busy.set(true);
    try {
      const r = await api<Sent>("/api/auth/otp/request", { method: "POST", body: { phone: this.phone(), purpose: "signup", for_seller: this.seller() } });
      this.sent.set(r);
      this.step.set("code");
      this.wait.set(r.resend_in);
    } catch (err) {
      if (err instanceof ApiError && err.code === "account_exists") this.exists.set(true);
      else this.error.set(err instanceof ApiError ? err.message : "Could not send the code");
    } finally {
      this.busy.set(false);
    }
  }

  protected async verify(code: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await api<Verified>("/api/auth/otp/verify", {
        method: "POST",
        body: {
          phone: this.phone(), code, purpose: "signup", for_seller: this.seller(), name: this.name(),
          email: this.emailMode() === "hidden" ? null : this.email().trim() || null, accept_terms: this.terms(), marketing_opt_in: this.offers(),
        },
      });
      await this.session.signIn(r.access_token, r.user);
      void this.router.navigateByUrl(this.next(), { replaceUrl: true });
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields ?? {}).length) { this.step.set("details"); this.fields.set(err.fields ?? {}); }
      this.error.set(err instanceof ApiError ? err.message : "Could not verify the code");
    } finally {
      this.busy.set(false);
    }
  }
}
