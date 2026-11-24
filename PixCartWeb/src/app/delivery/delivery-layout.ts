/*
 * Every /delivery page: the public pages (join, sign-in, download) render bare; the rest need a signed-in partner.
 * Before approval only registration, help and notifications open (in the simple frame); approved partners get the app
 * shell. Port of DeliveryApp and Gate in components/delivery/app.tsx (the shell parts are in shell/delivery-app.ts).
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject } from "@angular/core";
import { Router, RouterOutlet } from "@angular/router";
import { RouteState } from "../core/route-state";
import { SessionService } from "../core/session";
import { DeliveryShell, FullLoader, PartnerService, SimpleFrame } from "./shell/delivery-app";

const PUBLIC = ["/delivery/join", "/delivery/login", "/delivery/download"];
const BEFORE_APPROVAL = ["/delivery/register", "/delivery/help", "/delivery/notifications"];

@Component({
  selector: "pc-delivery-layout",
  imports: [RouterOutlet, FullLoader, SimpleFrame, DeliveryShell],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (isPublic()) {
      <router-outlet />
    } @else if (!session.ready() || !session.user()) {
      <pc-full-loader />
    } @else if (partner.status() === "loading") {
      <pc-full-loader label="Opening your partner app" />
    } @else if (partner.status() === "error") {
      <pc-simple-frame>
        <div class="mx-auto mt-10 max-w-sm rounded-2xl bg-white p-6 text-center shadow-sm">
          <p class="font-display text-xl font-semibold">Could not open the app</p>
          <p class="mt-1 text-ink-soft">Check your internet connection and try again.</p>
          <button type="button" (click)="reload()" class="mt-4 rounded-full bg-peacock px-5 py-2 font-semibold text-white">Try again</button>
        </div>
      </pc-simple-frame>
    } @else if (!approved()) {
      <pc-simple-frame>@if (allowedEarly()) {<router-outlet />} @else {<pc-full-loader />}</pc-simple-frame>
    } @else {
      <!-- a switched-off partner still gets the app, to finish (or bring back) packages already in hand; no new requests -->
      <pc-delivery-shell><router-outlet /></pc-delivery-shell>
    }
  `,
})
export class DeliveryLayout {
  protected readonly session = inject(SessionService);
  protected readonly partner = inject(PartnerService);
  private readonly router = inject(Router);
  private readonly path = inject(RouteState).pathname;
  protected readonly isPublic = computed(() => PUBLIC.some((p) => this.path().startsWith(p)));
  protected readonly approved = computed(() => this.partner.partner()?.kyc_status === "approved");
  protected readonly allowedEarly = computed(() => BEFORE_APPROVAL.some((p) => this.path().startsWith(p)));

  constructor() {
    effect(() => {
      if (!this.isPublic() && this.session.ready() && !this.session.user())
        void this.router.navigateByUrl(`/delivery/login?next=${encodeURIComponent(this.path())}`, { replaceUrl: true });
    });
    effect(() => {
      const user = this.session.user();
      if (user && !this.isPublic()) this.partner.start(user.id);
    });
    effect(() => {
      if (this.isPublic()) return;
      const status = this.partner.status();
      const approved = this.approved();
      if ((status === "none" || (status === "ready" && !approved)) && !this.allowedEarly()) void this.router.navigateByUrl("/delivery/register", { replaceUrl: true });
      if (status === "ready" && approved && this.path().startsWith("/delivery/register")) void this.router.navigateByUrl("/delivery", { replaceUrl: true });
    });
  }

  protected reload(): void {
    window.location.reload();
  }
}
