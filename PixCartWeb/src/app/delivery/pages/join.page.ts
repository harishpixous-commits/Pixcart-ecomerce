/*
 * /delivery/join: the public "become a delivery partner" page: the pitch, a phone mock-up of a request, how it works,
 * what you need, the app, questions and the call to register. Port of frontend/src/app/delivery/join/page.tsx.
 */

import { ChangeDetectionStrategy, Component, DestroyRef, afterNextRender, computed, inject, signal } from "@angular/core";
import {
  BadgeCheck, Bike, CalendarClock, ChevronDown, CircleDollarSign, FileCheck2, IdCard, IndianRupee, MapPin, Package, Phone, ShieldCheck, Smartphone, Timer, UserPlus, Wallet,
} from "lucide-angular";
import type { DeliveryOptions } from "../../core/delivery-types";
import { rupees } from "../../core/format";
import { SiteService } from "../../core/site";
import { Logo } from "../../shared/shop/shop-chrome";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PartnerGetTheApp } from "../components/install";
import { loadDeliveryOptions } from "../components/partner";

const STEPS = [
  { icon: UserPlus, title: "Sign up with your mobile", text: "One-time code, no passwords." },
  { icon: FileCheck2, title: "Add your documents", text: "Licence, ID proof, vehicle and bank or UPI." },
  { icon: BadgeCheck, title: "Get approved", text: "Our team checks your details, usually within a day." },
  { icon: Bike, title: "Go online and earn", text: "Accept requests near you and deliver." },
];

const NEEDS = [
  { icon: Bike, text: "A motorbike, scooter, electric bike or bicycle" },
  { icon: IdCard, text: "Driving licence (not needed for bicycles) and an ID proof" },
  { icon: Smartphone, text: "An Android phone or iPhone with internet and GPS" },
  { icon: Wallet, text: "A bank account or UPI ID for your weekly payouts" },
];

const FAQ = [
  ["How much can I earn?", "You earn a fee for every delivery you complete, shown before you accept a request. Your earnings add up in the app and are paid every week."],
  ["Can I choose my own hours?", "Yes. Switch Online when you want to work and Offline when you are done. You only get requests while you are online."],
  ["What happens with cash on delivery?", "Collect the amount shown in the app, enter it, and deposit the cash with the team. The app shows how much cash you are holding."],
  ["Do I need to buy anything?", "No joining fee. You need your own vehicle and a smartphone."],
  ["Is my information safe?", "Your documents are visible only to you and the verification team. Aadhaar numbers are never stored, only the last 4 digits."],
];

const PERKS = [
  { icon: CircleDollarSign, title: "Clear earnings", text: "See the fee before you accept. Track today, this week and every payout." },
  { icon: ShieldCheck, title: "Safe handovers", text: "Pickup codes at the store and OTP at the door protect you and the customer." },
  { icon: Phone, title: "Help when you need it", text: "Call or message the delivery team from the app at any time." },
];

const MOCK_STATS = [["Today", "₹420"], ["Trips", "12"], ["Rating", "4.9★"]];

@Component({
  selector: "pc-delivery-join-page",
  imports: [Icon, PcLink, Logo, PartnerGetTheApp],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block min-h-screen bg-mist" },
  template: `
    <!-- hero -->
    <section class="relative overflow-hidden bg-gradient-to-br from-peacock via-peacock to-peacock-dark text-white">
      <div class="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-white/10 blur-2xl" aria-hidden="true"></div>
      <div class="pointer-events-none absolute -bottom-32 -left-20 h-80 w-80 rounded-full bg-marigold/20 blur-3xl" aria-hidden="true"></div>
      <header class="relative mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
        <a pcLogo></a>
        <span class="rounded-full bg-white/15 px-2 py-0.5 text-xs font-semibold">Delivery partners</span>
        <a pcLink="/delivery/login" class="ml-auto rounded-full px-4 py-2 text-sm font-semibold ring-1 ring-white/50 hover:bg-white/10">Partner sign in</a>
      </header>
      <div class="relative mx-auto grid max-w-6xl items-center gap-10 px-4 pb-16 pt-6 md:grid-cols-[1.1fr_1fr] md:pb-24 md:pt-10">
        <div>
          <p class="mb-3 inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-sm font-semibold"><svg [pcIcon]="MapPin" class="h-4 w-4" /> Deliveries near you{{ cities().length ? " in " + cities().join(", ") : "" }}</p>
          <h1 class="text-4xl font-bold leading-[1.1] sm:text-5xl">Deliver with {{ brand() }}.<br /><span class="text-marigold">Earn on your own time.</span></h1>
          <p class="mt-4 max-w-lg text-lg text-white/85">Pick up packages from local sellers and deliver them to shoppers nearby. Go online when you want, get paid every week.</p>
          <div class="mt-6 flex flex-wrap gap-3">
            @if (open()) {
              <a pcLink="/delivery/login?next=/delivery/register" class="rounded-full bg-marigold px-7 py-3.5 text-lg font-bold text-ink shadow-lg shadow-black/20 transition-transform hover:-translate-y-0.5 hover:bg-marigold-dark" data-testid="join-register">
                Register now
              </a>
            } @else {
              <p class="rounded-xl bg-white/15 px-4 py-3 font-semibold">New registrations are closed right now. Please check back soon.</p>
            }
            <a pcLink="/delivery/login" class="rounded-full px-6 py-3.5 font-semibold ring-1 ring-white/60 hover:bg-white/10">I am already a partner</a>
          </div>
          <ul class="mt-8 flex flex-wrap gap-3 text-sm font-semibold">
            @if (fee()) {<li class="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 ring-1 ring-white/20"><svg [pcIcon]="IndianRupee" class="h-4 w-4 text-marigold" /> {{ fee() }}</li>}
            <li class="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 ring-1 ring-white/20"><svg [pcIcon]="CalendarClock" class="h-4 w-4 text-marigold" /> Weekly payouts</li>
            <li class="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 ring-1 ring-white/20"><svg [pcIcon]="Timer" class="h-4 w-4 text-marigold" /> Your own hours</li>
          </ul>
        </div>
        <!-- phone mock-up of a delivery request -->
        <div class="relative mx-auto w-full max-w-sm" aria-hidden="true">
          <div class="rotate-2 rounded-[2.2rem] bg-ink p-2.5 shadow-2xl shadow-black/40">
            <div class="overflow-hidden rounded-[1.8rem] bg-mist text-ink">
              <div class="flex items-center justify-between bg-peacock px-4 py-3 text-white">
                <span class="font-display font-semibold">{{ brand() }} Partner</span>
                <span class="flex items-center gap-1.5 rounded-full bg-leaf px-2.5 py-1 text-xs font-bold"><span class="h-2 w-2 rounded-full bg-white"></span> Online</span>
              </div>
              <div class="p-3">
                <div class="rounded-2xl bg-white p-4 shadow-sm">
                  <p class="text-xs font-bold uppercase tracking-wider text-vermilion">New delivery request</p>
                  <p class="mt-1 font-display text-2xl font-bold">{{ fee() ? fee()!.split(" ")[0] : "₹35" }} <span class="text-sm font-medium text-ink-soft">earning</span></p>
                  <div class="mt-3 flex flex-col gap-2 text-sm">
                    <p class="flex items-start gap-2"><svg [pcIcon]="Package" class="mt-0.5 h-4 w-4 shrink-0 text-peacock" /> <span><b>Pickup</b> · Local store, 1.2 km away</span></p>
                    <p class="flex items-start gap-2"><svg [pcIcon]="MapPin" class="mt-0.5 h-4 w-4 shrink-0 text-vermilion" /> <span><b>Drop</b> · 3.4 km from the store</span></p>
                  </div>
                  <div class="mt-4 grid grid-cols-[1fr_2fr] gap-2">
                    <span class="rounded-xl bg-mist py-2.5 text-center text-sm font-semibold text-ink-soft">Reject</span>
                    <span class="relative overflow-hidden rounded-xl bg-leaf py-2.5 text-center text-sm font-bold text-white">
                      <span class="absolute inset-y-0 left-0 w-2/3 bg-white/20"></span> <span class="relative">Accept · 0:21</span>
                    </span>
                  </div>
                </div>
                <div class="mt-3 grid grid-cols-3 gap-2 text-center">
                  @for (s of stats; track s[0]) {
                    <div class="rounded-xl bg-white p-2 shadow-sm"><p class="text-[11px] text-ink-faint">{{ s[0] }}</p><p class="font-display font-bold">{{ s[1] }}</p></div>
                  }
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="awning bg-mist" aria-hidden="true" style="transform: scaleY(-1)"></div>
    </section>

    <main class="mx-auto flex max-w-6xl flex-col gap-10 px-4 py-10">
      <section aria-labelledby="how">
        <h2 id="how" class="text-2xl font-semibold sm:text-3xl">How it works</h2>
        <ol class="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          @for (s of steps; track s.title; let i = $index) {
            <li class="relative rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
              <span class="absolute right-4 top-3 font-display text-4xl font-bold text-peacock/10">{{ i + 1 }}</span>
              <span class="flex h-11 w-11 items-center justify-center rounded-xl bg-peacock-light text-peacock"><svg [pcIcon]="s.icon" class="h-6 w-6" /></span>
              <p class="mt-3 font-semibold">{{ s.title }}</p>
              <p class="text-sm text-ink-soft">{{ s.text }}</p>
            </li>
          }
        </ol>
      </section>

      <section class="grid gap-6 lg:grid-cols-2">
        <div class="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5">
          <h2 class="text-xl font-semibold">What you need</h2>
          <ul class="mt-4 flex flex-col gap-3">
            @for (n of needs; track n.text) {
              <li class="flex items-center gap-3"><span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-marigold-light text-marigold-dark"><svg [pcIcon]="n.icon" class="h-5 w-5" /></span>{{ n.text }}</li>
            }
          </ul>
        </div>
        <div class="rounded-2xl bg-gradient-to-br from-white to-peacock-light/60 p-6 shadow-sm ring-1 ring-black/5">
          <h2 class="text-xl font-semibold">Get the partner app</h2>
          <p class="mb-4 mt-1 text-ink-soft">Use it in your phone's browser or install it like any other app. Everything works the same on a computer.</p>
          <pc-partner-get-the-app [options]="opts()" />
        </div>
      </section>

      <section class="grid gap-4 sm:grid-cols-3">
        @for (c of perks; track c.title) {
          <div class="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
            <svg [pcIcon]="c.icon" class="h-7 w-7 text-peacock" />
            <p class="mt-2 font-semibold">{{ c.title }}</p>
            <p class="text-sm text-ink-soft">{{ c.text }}</p>
          </div>
        }
      </section>

      <section aria-labelledby="faq" class="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5">
        <h2 id="faq" class="text-xl font-semibold">Questions</h2>
        <div class="mt-3 divide-y divide-line">
          @for (f of faq; track f[0]) {
            <details class="group py-3">
              <summary class="flex cursor-pointer list-none items-center justify-between gap-3 font-semibold">{{ f[0] }}<svg [pcIcon]="ChevronDown" class="h-5 w-5 shrink-0 text-ink-faint transition-transform group-open:rotate-180" /></summary>
              <p class="mt-2 text-ink-soft">{{ f[1] }}</p>
            </details>
          }
        </div>
      </section>

      @if (open()) {
        <section class="flex flex-col items-center gap-3 rounded-2xl bg-peacock px-6 py-10 text-center text-white">
          <h2 class="text-2xl font-semibold sm:text-3xl">Ready to start?</h2>
          <p class="text-white/85">It takes about 5 minutes. Keep your licence, ID proof and bank details handy.</p>
          <a pcLink="/delivery/login?next=/delivery/register" class="mt-2 rounded-full bg-marigold px-7 py-3.5 text-lg font-bold text-ink hover:bg-marigold-dark">Register now</a>
        </section>
      }
      <p class="text-center text-sm text-ink-faint">
        @if (opts()?.support_phone) {Questions? Call <a class="font-semibold text-peacock" [href]="'tel:' + opts()!.support_phone">{{ opts()!.support_phone }}</a> · }
        <a pcLink="/" class="font-semibold text-peacock">Shop on {{ brand() }}</a>
      </p>
    </main>
  `,
})
export class DeliveryJoinPage {
  private readonly site = inject(SiteService).site;
  protected readonly brand = computed(() => this.site().brand_name);
  protected readonly opts = signal<DeliveryOptions | null>(null);
  protected readonly fee = computed(() => {
    const o = this.opts();
    return !o ? null : o.fee_mode === "fixed" ? `${rupees(o.fee_fixed_paise)} a delivery` : `${rupees(o.fee_base_paise)} + ${rupees(o.fee_per_km_paise)} a km`;
  });
  protected readonly open = computed(() => this.opts()?.registration_open !== false && this.opts()?.enabled !== false);
  protected readonly cities = computed(() => Array.from(new Set((this.opts()?.zones ?? []).map((z) => z.city))).slice(0, 8));
  protected readonly steps = STEPS;
  protected readonly needs = NEEDS;
  protected readonly faq = FAQ;
  protected readonly perks = PERKS;
  protected readonly stats = MOCK_STATS;
  protected readonly MapPin = MapPin;
  protected readonly IndianRupee = IndianRupee;
  protected readonly CalendarClock = CalendarClock;
  protected readonly Timer = Timer;
  protected readonly Package = Package;
  protected readonly ChevronDown = ChevronDown;

  constructor() {
    let live = true;
    inject(DestroyRef).onDestroy(() => (live = false));
    loadDeliveryOptions().then((o) => { if (live) this.opts.set(o); }).catch(() => {});
    // the reference's metadata title sits under the delivery layout's "%s | Delivery partner" template
    afterNextRender(() => { document.title = "Become a delivery partner | Delivery partner"; });
  }
}
