/* Notifications: order updates and support replies, newest first, with "Mark all as read". Port of frontend/src/app/(shop)/notifications/page.tsx. */

import { NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from "@angular/core";
import { Router } from "@angular/router";
import { api, quietly } from "../../core/api";
import { dateTime } from "../../core/format";
import { SessionService } from "../../core/session";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState } from "../../shared/ui/ui";

type N = { id: string; title: string; body: string; link: string; read: boolean; at: string };

@Component({
  selector: "pc-shop-notifications-page",
  imports: [NgTemplateOutlet, PcLink, PageLoader, Button, EmptyState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!items()) {
      <pc-page-loader />
    } @else {
      <div class="mx-auto flex max-w-2xl flex-col gap-3">
        <div class="flex items-center justify-between px-1">
          <h1 class="text-2xl font-semibold">Notifications</h1>
          @if (unread()) {<button pcButton variant="ghost" size="sm" (click)="readAll()">Mark all as read</button>}
        </div>
        @if (items()!.length === 0) {
          <pc-empty-state title="No notifications" body="Order updates and replies from support will appear here." [hasAction]="false" />
        } @else {
          <ul class="divide-y divide-line overflow-hidden rounded-xl bg-white">
            @for (n of items(); track n.id) {
              <ng-template #body>
                <div [class]="n.read ? 'flex gap-3 px-4 py-3' : 'flex gap-3 px-4 py-3 bg-peacock-light/40'">
                  <span [class]="n.read ? 'mt-2 h-2 w-2 shrink-0 rounded-full bg-transparent' : 'mt-2 h-2 w-2 shrink-0 rounded-full bg-vermilion'" aria-hidden="true"></span>
                  <div>
                    <p class="font-semibold">{{ n.title }}</p>
                    <p class="text-ink-soft">{{ n.body }}</p>
                    <p class="text-xs text-ink-faint">{{ dateTime(n.at) }}</p>
                  </div>
                </div>
              </ng-template>
              <li>
                @if (n.link) {<a [pcLink]="n.link" class="block hover:bg-mist"><ng-container [ngTemplateOutlet]="body" /></a>} @else {<ng-container [ngTemplateOutlet]="body" />}
              </li>
            }
          </ul>
        }
      </div>
    }
  `,
})
export class ShopNotificationsPage {
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  protected readonly items = signal<N[] | null>(null);
  protected readonly unread = computed(() => (this.items() ?? []).some((n) => !n.read));
  protected readonly dateTime = dateTime;

  constructor() {
    effect(() => {
      const user = this.session.user();
      if (this.session.ready() && !user) void this.router.navigateByUrl("/login?next=/notifications", { replaceUrl: true });
      if (user) untracked(() => api<{ items: N[] }>("/api/notifications").then((r) => this.items.set(r.items)).catch(quietly));
    });
  }

  protected readAll(): void {
    const items = this.items() ?? [];
    api("/api/notifications/read-all", { method: "POST" }).then(() => this.items.set(items.map((n) => ({ ...n, read: true })))).catch(quietly);
  }
}
