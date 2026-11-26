/*
 * The partner's messages: new requests, approvals, payouts. Links to the shop are opened in the partner app where they
 * exist. Port of frontend/src/app/delivery/notifications/page.tsx.
 */

import { NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from "@angular/core";
import { Bell } from "lucide-angular";
import { api, quietly } from "../../core/api";
import { dateTime } from "../../core/format";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { Button } from "../../shared/ui/ui";
import { FullLoader } from "../shell/delivery-app";

type N = { id: string; title: string; body: string; link: string; read: boolean; at: string };

@Component({
  selector: "pc-delivery-notifications-page",
  imports: [NgTemplateOutlet, Icon, PcLink, Button, FullLoader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (items(); as items) {
      <div class="flex flex-col gap-3 pt-2">
        <div class="flex items-center justify-between">
          <h1 class="text-2xl font-bold">Notifications</h1>
          @if (anyUnread()) {
            <button pcButton variant="ghost" size="sm" (click)="readAll()">Mark all as read</button>
          }
        </div>
        @if (items.length === 0) {
          <div class="flex flex-col items-center gap-2 rounded-3xl bg-white p-10 text-center shadow-sm">
            <svg [pcIcon]="Bell" class="h-10 w-10 text-ink-faint" />
            <p class="font-semibold">Nothing yet</p>
            <p class="text-sm text-ink-soft">Delivery requests, approvals and payouts show up here.</p>
          </div>
        } @else {
          <ul class="divide-y divide-line overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-black/5">
            @for (n of items; track n.id) {
              <li>
                <ng-template #body>
                  <div [class]="n.read ? 'flex gap-3 px-4 py-3.5' : 'flex gap-3 px-4 py-3.5 bg-peacock-light/40'">
                    <span [class]="n.read ? 'mt-2 h-2 w-2 shrink-0 rounded-full bg-transparent' : 'mt-2 h-2 w-2 shrink-0 rounded-full bg-vermilion'" aria-hidden="true"></span>
                    <div>
                      <p class="font-semibold">{{ n.title }}</p>
                      <p class="text-ink-soft">{{ n.body }}</p>
                      <p class="text-xs text-ink-faint">{{ dateTime(n.at) }}</p>
                    </div>
                  </div>
                </ng-template>
                @if (n.link && n.link.startsWith("/delivery")) {
                  <a [pcLink]="n.link" class="block hover:bg-mist"><ng-container [ngTemplateOutlet]="body" /></a>
                } @else {
                  <ng-container [ngTemplateOutlet]="body" />
                }
              </li>
            }
          </ul>
        }
      </div>
    } @else {
      <pc-full-loader />
    }
  `,
})
export class DeliveryNotificationsPage {
  protected readonly items = signal<N[] | null>(null);
  protected readonly anyUnread = computed(() => (this.items() ?? []).some((n) => !n.read));
  protected readonly dateTime = dateTime;
  protected readonly Bell = Bell;

  constructor() {
    let live = true;
    inject(DestroyRef).onDestroy(() => (live = false));
    api<{ items: N[] }>("/api/notifications").then((r) => { if (live) this.items.set(r.items); }).catch(quietly);
  }

  protected readAll(): void {
    const items = this.items() ?? [];
    api("/api/notifications/read-all", { method: "POST" }).then(() => this.items.set(items.map((n) => ({ ...n, read: true })))).catch(quietly);
  }
}
