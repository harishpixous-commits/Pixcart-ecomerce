/* Rewards: loyalty points (turn into a coupon), your referral code, and gift card redeem. Each part shows only when staff
   switched it on. Mirror of frontend/src/app/(shop)/rewards/page.tsx. */

import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { Gift, Heart, Users } from "lucide-angular";
import { ApiError, api, quietly } from "../../core/api";
import { date, rupees } from "../../core/format";
import { Icon } from "../../shared/ui/icon";
import { Toast } from "../../shared/ui/ui";

type Loyalty = { enabled: boolean; balance: number; lifetime: number; tier: string; value_paise: number; history: { kind: string; points: number; note: string; at: string }[] };
type Referral = { enabled: boolean; code: string; referrer_reward_paise: number; friend_reward_paise: number; min_order_paise: number; joined: number; rewarded: number; earned_paise: number; used_code: boolean };
type Made = { code: string; discount_paise: number; min_order_paise: number; valid_days: number };
type CardInfo = { balance_paise: number; status: string; expires_at: string };

@Component({
  selector: "pc-shop-rewards-page",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="flex flex-col gap-4">
      <header class="rounded-xl bg-white p-4 sm:p-6">
        <h1 class="flex items-center gap-2 text-2xl font-semibold sm:text-3xl"><svg [pcIcon]="Gift" class="h-7 w-7 text-vermilion" /> Rewards</h1>
        <p class="text-ink-soft">Points, referrals and gift cards turn into a coupon you apply at checkout.</p>
      </header>
      @if (made(); as m) {
        <div class="rounded-xl border-2 border-dashed border-peacock bg-peacock-light p-4" data-testid="made-coupon">
          <p class="font-semibold">Your coupon: {{ rupees(m.discount_paise) }} off, valid {{ m.valid_days }} days</p>
          <button type="button" (click)="copy(m.code)" class="mt-2 rounded-lg border border-dashed border-peacock px-3 py-2 font-mono font-semibold text-peacock">{{ m.code }}</button>
          <p class="mt-1 text-sm text-ink-soft">Needs an order of at least {{ rupees(m.min_order_paise) }}. One use only.</p>
        </div>
      }
      @if (loyalty(); as l) {
        @if (l.enabled) {
          <section class="rounded-xl bg-white p-4 sm:p-6">
            <h2 class="flex items-center gap-2 text-xl font-semibold"><svg [pcIcon]="Heart" class="h-5 w-5 text-vermilion" /> Loyalty points</h2>
            <p class="mt-1">{{ l.balance }} points ({{ rupees(l.value_paise) }}) · {{ l.tier }} tier</p>
            <div class="mt-3 flex gap-2">
              <input [value]="points()" (input)="points.set($any($event.target).value.replace(NON_DIGIT, ''))" inputmode="numeric" placeholder="Points to use" aria-label="Points to use" class="w-40 rounded-lg border border-line px-3 py-2" />
              <button type="button" [disabled]="busy() || !points()" (click)="redeemPoints()" class="rounded-full bg-peacock px-5 py-2 font-semibold text-white disabled:opacity-50">Get coupon</button>
            </div>
            <ul class="mt-3 divide-y divide-line text-sm">
              @for (h of l.history.slice(0, 10); track $index) {
                <li class="flex justify-between py-1.5"><span>{{ h.note || h.kind }} <span class="text-ink-soft">{{ date(h.at) }}</span></span><span [class]="h.points < 0 ? 'text-vermilion' : 'text-peacock'">{{ h.points > 0 ? "+" : "" }}{{ h.points }}</span></li>
              }
            </ul>
          </section>
        }
      }
      @if (referral(); as r) {
        @if (r.enabled) {
          <section class="rounded-xl bg-white p-4 sm:p-6">
            <h2 class="flex items-center gap-2 text-xl font-semibold"><svg [pcIcon]="Users" class="h-5 w-5 text-vermilion" /> Refer a friend</h2>
            <p class="mt-1 text-ink-soft">Share your code. After their first delivered order of {{ rupees(r.min_order_paise) }} or more, you get {{ rupees(r.referrer_reward_paise) }} and they get {{ rupees(r.friend_reward_paise) }}, as loyalty points.</p>
            <button type="button" (click)="copy(r.code)" class="mt-2 rounded-lg border border-dashed border-peacock bg-peacock-light px-3 py-2 font-mono font-semibold text-peacock">{{ r.code }}</button>
            <p class="mt-2 text-sm text-ink-soft">{{ r.joined }} joined, {{ r.rewarded }} rewarded.</p>
            @if (!r.used_code) {
              <div class="mt-3 flex gap-2">
                <input [value]="friendCode()" (input)="friendCode.set($any($event.target).value)" placeholder="Friend's code" aria-label="Friend's referral code" class="w-48 rounded-lg border border-line px-3 py-2" />
                <button type="button" [disabled]="busy() || !friendCode().trim()" (click)="applyFriend()" class="rounded-full border border-peacock px-5 py-2 font-semibold text-peacock disabled:opacity-50">Add code</button>
              </div>
            }
          </section>
        }
      }
      <section class="rounded-xl bg-white p-4 sm:p-6">
        <h2 class="flex items-center gap-2 text-xl font-semibold"><svg [pcIcon]="Gift" class="h-5 w-5 text-vermilion" /> Gift card</h2>
        <div class="mt-2 flex flex-wrap gap-2">
          <input [value]="card()" (input)="card.set($any($event.target).value); cardInfo.set(null)" placeholder="Gift card code" aria-label="Gift card code" class="w-56 rounded-lg border border-line px-3 py-2 font-mono" />
          <button type="button" [disabled]="busy() || card().trim().length < 4" (click)="checkCard()" class="rounded-full border border-peacock px-5 py-2 font-semibold text-peacock disabled:opacity-50">Check balance</button>
          @if (cardInfo(); as c) {
            @if (c.status === "active") {
              <button type="button" [disabled]="busy()" (click)="redeemCard()" class="rounded-full bg-peacock px-5 py-2 font-semibold text-white">Turn {{ rupees(c.balance_paise) }} into a coupon</button>
            }
          }
        </div>
        @if (cardInfo(); as c) {<p class="mt-2 text-sm">Balance {{ rupees(c.balance_paise) }}, {{ c.status }}, expires {{ date(c.expires_at) }}.</p>}
      </section>
    </div>
  `,
})
export class ShopRewardsPage {
  private readonly toast = inject(Toast);
  protected readonly Gift = Gift;
  protected readonly Heart = Heart;
  protected readonly Users = Users;
  protected readonly NON_DIGIT = /\D/g;
  protected readonly rupees = rupees;
  protected readonly date = date;
  protected readonly loyalty = signal<Loyalty | null>(null);
  protected readonly referral = signal<Referral | null>(null);
  protected readonly points = signal("");
  protected readonly friendCode = signal("");
  protected readonly card = signal("");
  protected readonly cardInfo = signal<CardInfo | null>(null);
  protected readonly made = signal<Made | null>(null);
  protected readonly busy = signal(false);

  constructor() {
    this.load();
  }

  private load() {
    api<Loyalty>("/api/loyalty").then((d) => this.loyalty.set(d)).catch(quietly);
    api<Referral>("/api/referral").then((d) => this.referral.set(d)).catch(quietly);
  }

  private async run(fn: () => Promise<void>) {
    this.busy.set(true);
    try {
      await fn();
    } catch (e) {
      this.toast.show(e instanceof ApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      this.busy.set(false);
    }
  }

  protected redeemPoints() {
    return this.run(async () => {
      this.made.set(await api<Made>("/api/loyalty/redeem", { method: "POST", body: { points: Number(this.points()) } }));
      this.points.set("");
      this.load();
    });
  }
  protected applyFriend() {
    return this.run(async () => {
      await api("/api/referral/apply", { method: "POST", body: { code: this.friendCode().trim() } });
      this.toast.show("Referral code added. You both earn after your first delivered order.");
      this.friendCode.set("");
      this.load();
    });
  }
  protected checkCard() {
    return this.run(async () => this.cardInfo.set(await api<CardInfo>("/api/gift-cards/balance", { method: "POST", body: { code: this.card().trim() } })));
  }
  protected redeemCard() {
    return this.run(async () => {
      this.made.set(await api<Made>("/api/gift-cards/redeem", { method: "POST", body: { code: this.card().trim() } }));
      this.cardInfo.set(null);
      this.card.set("");
    });
  }
  protected copy(code: string) {
    navigator.clipboard?.writeText(code).catch(() => undefined);
    this.toast.show(`Code ${code} copied. Apply it at checkout.`);
  }
}
