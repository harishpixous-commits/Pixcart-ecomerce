/*
 * Sign-in and sign-up pages in the theme's "sign-in" layout: a centred card (Classic, Fresh), or split with a brand panel
 * on large screens (Bazaar, Luxe). The panel lists only what is true for this shop (from its settings).
 * Port of components/auth/auth-frame.tsx and app/(shop)/login/page.tsx, app/(shop)/signup/page.tsx.
 */

import { NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { BadgeCheck, RotateCcw, ShieldCheck, Wallet, type LucideIconData } from "lucide-angular";
import { SiteService } from "../../core/site";
import { ThemeService } from "../../themes/context";
import { Logo } from "../../shared/shop/shop-chrome";
import { Icon } from "../../shared/ui/icon";
import { SignInForm, SignUpForm } from "./auth-forms";

@Component({
  selector: "pc-brand-panel",
  imports: [Icon, Logo],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "relative hidden flex-col justify-between overflow-hidden bg-peacock p-10 text-white lg:flex", "aria-hidden": "false" },
  template: `
    <div aria-hidden="true" class="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-white/10"></div>
    <div aria-hidden="true" class="pointer-events-none absolute -bottom-32 -left-16 h-80 w-80 rounded-full bg-marigold/20"></div>
    <div class="relative"><a pcLogo></a></div>
    <div class="relative flex flex-col gap-5">
      <p class="max-w-sm font-display text-3xl font-semibold leading-tight">{{ site().tagline || "Welcome to " + site().brand_name }}</p>
      <ul class="flex flex-col gap-3">
        @for (p of points(); track p.text) {
          <li class="flex items-center gap-3 text-white/90">
            <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15"><svg [pcIcon]="p.icon" class="h-5 w-5" /></span>
            {{ p.text }}
          </li>
        }
      </ul>
    </div>
    <p class="relative text-sm text-white/70">{{ site().business.legal_name || site().brand_name }}</p>
  `,
})
export class BrandPanel {
  protected readonly site = inject(SiteService).site;
  protected readonly points = computed(() => {
    const site = this.site();
    return [
      { icon: BadgeCheck, text: "Every seller is verified before they can sell" },
      site.cod_enabled ? { icon: Wallet, text: "Pay online or cash on delivery" } : { icon: ShieldCheck, text: "Secure online payments" },
      site.features.returns ? { icon: RotateCcw, text: "Easy returns from your orders page" } : null,
    ].filter((x): x is { icon: LucideIconData; text: string } => Boolean(x));
  });
}

/** The theme's sign-in frame around the projected form. */
@Component({
  selector: "pc-auth-frame",
  imports: [BrandPanel, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <ng-template #body><ng-content /></ng-template>
    @if (!split()) {
      <div class="mx-auto max-w-md py-6"><ng-container *ngTemplateOutlet="body" /></div>
    } @else {
      <div class="mx-auto grid max-w-5xl overflow-hidden lg:my-4 lg:grid-cols-2 lg:rounded-2xl lg:bg-white lg:shadow-card" data-auth-layout="split">
        <pc-brand-panel />
        <div class="mx-auto w-full max-w-md py-6 lg:px-6 lg:py-12"><ng-container *ngTemplateOutlet="body" /></div>
      </div>
    }
  `,
})
export class AuthFrame {
  private readonly theme = inject(ThemeService);
  protected readonly split = computed(() => this.theme.layout().auth.layout === "split");
}

@Component({
  selector: "pc-login-page",
  imports: [AuthFrame, SignInForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<pc-auth-frame><pc-sign-in-form /></pc-auth-frame>`,
})
export class LoginPage {}

@Component({
  selector: "pc-signup-page",
  imports: [AuthFrame, SignUpForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<pc-auth-frame><pc-sign-up-form /></pc-auth-frame>`,
})
export class SignupPage {}
