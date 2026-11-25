/* Admin → Sign-in and accounts: on-screen test codes, sign-ups, code rules, staff passwords and two-step sign-in, sessions and
 * sign-in alerts. Port of frontend/src/app/admin/sign-in/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal, type OnInit } from "@angular/core";
import { api, ApiError, quietly } from "../../core/api";
import { PageHeader } from "../../shared/portal-shell";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Pill, Select, TextField, Toast } from "../../shared/ui/ui";

type Rule = readonly [string, string, string];
type Settings = {
  show_dev_otp: boolean; customer_signup: boolean; seller_signup: boolean; signup_email: "optional" | "required" | "hidden";
  password_require_mixed: boolean; staff_require_two_step: boolean; login_alerts: "off" | "staff" | "everyone";
} & Record<string, number | boolean | string>;
type D = {
  settings: Settings;
  dev_otp: { active: boolean; reason: string };
  environment: string;
  sms_provider: string;
  limits: Record<string, [number, number]>;
};

/** [setting, label, help]. The allowed range comes from the API. */
const CODE_RULES: Rule[] = [
  ["otp_length", "Code length (digits)", "Your SMS template (DLT) must allow this length"],
  ["otp_ttl_seconds", "Code valid for (seconds)", "Only the newest code works"],
  ["otp_resend_cooldown_seconds", "Wait before a new code (seconds)", "Stops repeated taps from sending many SMS"],
  ["otp_max_attempts", "Wrong tries per code", "Then a new code is needed"],
  ["otp_max_per_hour", "Codes per mobile number per hour", "Protects your SMS budget"],
  ["otp_max_per_ip_hour", "Codes per network per hour", "Stops someone checking many numbers"],
];
const PASSWORD_RULES: Rule[] = [
  ["password_min_length", "Shortest password (characters)", "For staff passwords, new and changed"],
  ["login_max_attempts", "Sign-in tries before a wait", "Counts every try for one email"],
  ["login_lockout_minutes", "Wait (minutes)", "Also the period the tries are counted over"],
];
const SESSION_RULES: Rule[] = [
  ["customer_session_days", "Customers and sellers stay signed in for (days)", "Renewed while they use the shop"],
  ["staff_session_days", "Staff stay signed in for (days)", "Shorter is safer for the admin panel"],
];

@Component({
  selector: "pc-number-rules",
  imports: [Button, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <form class="grid gap-3 sm:grid-cols-2" (submit)="submit($event)">
      @for (r of rules(); track r[0]) {
        <pc-text-field [label]="r[1]" inputmode="numeric" [value]="draft()[r[0]] ?? ''" (valueChange)="set(r[0], $event)"
          [hint]="r[2] + '. ' + d().limits[r[0]][0] + ' to ' + d().limits[r[0]][1] + '.'" />
      }
      <div class="sm:col-span-2"><button pcButton type="submit" [loading]="busy()" [disabled]="!changed()" size="sm">Save</button></div>
    </form>
  `,
})
export class NumberRules implements OnInit {
  readonly d = input.required<D>();
  readonly rules = input.required<Rule[]>();
  readonly save = input.required<(p: Record<string, number>) => Promise<void>>();
  protected readonly draft = signal<Record<string, string>>({});
  protected readonly busy = signal(false);
  protected readonly changed = computed(() => this.rules().some(([k]) => this.draft()[k] !== String(this.d().settings[k])));

  ngOnInit(): void {
    this.draft.set(Object.fromEntries(this.rules().map(([k]) => [k, String(this.d().settings[k])])));
  }

  protected set(k: string, v: string): void {
    this.draft.update((d) => ({ ...d, [k]: v }));
  }

  protected async submit(e: Event): Promise<void> {
    e.preventDefault();
    this.busy.set(true);
    await this.save()(Object.fromEntries(this.rules().map(([k]) => [k, Number(this.draft()[k])])));
    this.busy.set(false);
  }
}

@Component({
  selector: "pc-sign-in-toggle",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <label [class]="'flex items-start gap-3 rounded-lg border border-line p-4 ' + (disabled() ? 'opacity-60' : 'cursor-pointer hover:border-peacock/40')">
      <span class="relative mt-0.5 inline-flex shrink-0">
        <input type="checkbox" role="switch" class="peer sr-only" [checked]="checked()" [disabled]="disabled()" (change)="changed.emit($any($event.target).checked)" />
        <span class="h-6 w-11 rounded-full bg-line transition peer-checked:bg-leaf peer-focus-visible:ring-2 peer-focus-visible:ring-peacock/40"></span>
        <span class="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition peer-checked:translate-x-5"></span>
      </span>
      <span><span class="block font-semibold">{{ label() }}</span><span class="block text-sm text-ink-soft">{{ help() }}</span></span>
    </label>
  `,
})
export class SignInToggle {
  readonly checked = input.required<boolean>();
  readonly label = input.required<string>();
  readonly help = input.required<string>();
  readonly disabled = input(false);
  readonly changed = output<boolean>();
}

@Component({
  selector: "pc-admin-sign-in-page",
  imports: [PageHeader, PcLink, PageLoader, ErrorNote, Pill, Select, NumberRules, SignInToggle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (!d()) {
      <pc-page-loader />
    } @else {
      @let s = d()!.settings;
      <div class="flex max-w-3xl flex-col gap-4">
        <pc-page-header title="Sign-in and accounts" sub="How customers and sellers sign in and create accounts. Staff sign in with email and password at /admin/login." />
        <pc-error-note [message]="error()" />

        <section class="rounded-xl bg-white p-5">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 class="text-lg font-semibold">One-time code on screen (testing)</h2>
            @if (d()!.dev_otp.active) {<pc-pill tone="blue">Showing codes on screen</pc-pill>} @else {<pc-pill tone="gray">Off</pc-pill>}
          </div>
          <pc-sign-in-toggle [checked]="s.show_dev_otp" [disabled]="blocked()" (changed)="save({ show_dev_otp: $event })" label="Show the code under the code box"
            [help]="'For testing before SMS is connected: the ' + s['otp_length'] + '-digit code appears on the sign-in and create-account screens, with a Fill in button.'" />
          <p class="mt-2 text-sm text-ink-soft">{{ d()!.dev_otp.reason }}</p>
          <ul class="mt-2 list-disc pl-5 text-sm text-ink-faint">
            <li>Never shown in production, whatever this switch says.</li>
            <li>Switches off by itself when real SMS is connected in <a pcLink="/admin/integrations" class="font-semibold text-peacock">Integrations</a> (MSG91). Now: <b>{{ d()!.sms_provider === "console" ? "no SMS provider (test)" : d()!.sms_provider }}</b>.</li>
          </ul>
        </section>

        <section class="flex flex-col gap-3 rounded-xl bg-white p-5">
          <h2 class="text-lg font-semibold">New accounts</h2>
          <pc-sign-in-toggle [checked]="s.customer_signup" (changed)="save({ customer_signup: $event })" label="Customers can create accounts"
            help="Off: the Create account page says sign-ups are paused. Existing customers still sign in." />
          <pc-sign-in-toggle [checked]="s.seller_signup" (changed)="save({ seller_signup: $event })" label="New sellers can register"
            help="Off: Become a seller and seller registration are paused. You can still add sellers yourself in Sellers." />
          <label class="flex flex-col gap-1 rounded-lg border border-line p-4">
            <span class="font-semibold">Email when creating an account</span>
            <span class="text-sm text-ink-soft">Mobile number and name are always asked.</span>
            <select pcSelect (change)="save({ signup_email: $any($event.target).value })" class="mt-1 w-auto self-start" aria-label="Email field">
              <option value="optional" [selected]="s.signup_email === 'optional'">Ask, optional</option>
              <option value="required" [selected]="s.signup_email === 'required'">Ask, required</option>
              <option value="hidden" [selected]="s.signup_email === 'hidden'">Do not ask</option>
            </select>
          </label>
        </section>

        <section class="rounded-xl bg-white p-5" data-testid="code-rules">
          <h2 class="text-lg font-semibold">One-time code rules</h2>
          <p class="mb-3 text-sm text-ink-soft">For customers, sellers and delivery partners, who sign in with a code sent by SMS.</p>
          <pc-number-rules [d]="d()!" [rules]="codeRules" [save]="saver" />
        </section>

        <section class="flex flex-col gap-3 rounded-xl bg-white p-5" data-testid="staff-security">
          <div>
            <h2 class="text-lg font-semibold">Staff passwords and two-step sign-in</h2>
            <p class="text-sm text-ink-soft">Staff sign in to the admin panel with email and password.</p>
          </div>
          <pc-sign-in-toggle [checked]="s.staff_require_two_step" (changed)="save({ staff_require_two_step: $event })" label="Staff must use two-step sign-in"
            help="Staff without an authenticator app are asked to set it up in My account before they can use the admin panel. Turn it on for your own account first." />
          <pc-sign-in-toggle [checked]="s.password_require_mixed" (changed)="save({ password_require_mixed: $event })" label="Passwords need upper and lower case letters and a number"
            help="Off: only the length is checked. A long passphrase is just as strong." />
          <pc-number-rules [d]="d()!" [rules]="passwordRules" [save]="saver" />
        </section>

        <section class="flex flex-col gap-3 rounded-xl bg-white p-5">
          <h2 class="text-lg font-semibold">Staying signed in and sign-in alerts</h2>
          <pc-number-rules [d]="d()!" [rules]="sessionRules" [save]="saver" />
          <label class="flex flex-col gap-1 rounded-lg border border-line p-4">
            <span class="font-semibold">Alert when an account signs in on a new device</span>
            <span class="text-sm text-ink-soft">A message in the app and by email, naming the browser and system. Everyone can also see and sign out their devices in their account.</span>
            <select pcSelect (change)="save({ login_alerts: $any($event.target).value })" class="mt-1 w-auto self-start" aria-label="Sign-in alerts">
              <option value="staff" [selected]="s.login_alerts === 'staff'">Staff only</option>
              <option value="everyone" [selected]="s.login_alerts === 'everyone'">Everyone</option>
              <option value="off" [selected]="s.login_alerts === 'off'">Off</option>
            </select>
          </label>
        </section>
      </div>
    }
  `,
})
export class AdminSignInPage {
  private readonly toast = inject(Toast);
  protected readonly codeRules = CODE_RULES;
  protected readonly passwordRules = PASSWORD_RULES;
  protected readonly sessionRules = SESSION_RULES;
  protected readonly d = signal<D | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly blocked = computed(() => {
    const d = this.d();
    return !!d && (d.environment === "production" || d.sms_provider !== "console");
  });
  protected readonly saver = (p: Record<string, unknown>) => this.save(p);

  constructor() {
    api<D>("/api/admin/auth-settings").then((d) => this.d.set(d)).catch(quietly);
  }

  protected async save(patch: Record<string, unknown>): Promise<void> {
    this.error.set(null);
    try {
      this.d.set(await api<D>("/api/admin/auth-settings", { method: "PUT", body: patch }));
      this.toast.show("Saved");
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not save");
    }
  }
}
