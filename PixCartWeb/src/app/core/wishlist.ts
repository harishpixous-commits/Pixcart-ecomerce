/*
 * The shopper's wishlist (ids of saved products) and the recently viewed list. Port of frontend/src/lib/wishlist.tsx:
 * useWishlist() → inject(WishlistService); the heart button is shared/ui/wishlist-heart.ts.
 */

import { Injectable, computed, effect, inject, signal } from "@angular/core";
import { Router } from "@angular/router";
import { api } from "./api";
import { SessionService } from "./session";

@Injectable({ providedIn: "root" })
export class WishlistService {
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  // The saved ids belong to one account; after signing out (or switching accounts) the old set is simply not shown.
  private readonly saved = signal<{ uid: string | null; ids: Set<string> }>({ uid: null, ids: new Set() });
  readonly ids = computed(() => {
    const user = this.session.user();
    const s = this.saved();
    return user && s.uid === user.id ? s.ids : new Set<string>();
  });

  constructor() {
    effect(() => {
      const user = this.session.user();
      if (!user) return;
      api<{ ids: string[] }>("/api/wishlist").then((r) => this.saved.set({ uid: user.id, ids: new Set(r.ids) })).catch(() => {});
    });
  }

  private setIds(fn: (cur: Set<string>) => Set<string>) {
    const user = this.session.user();
    this.saved.update((s) => ({ uid: user?.id ?? null, ids: fn(user && s.uid === user.id ? s.ids : new Set()) }));
  }

  async toggle(id: string): Promise<void> {
    if (!this.session.user()) {
      void this.router.navigateByUrl(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    const on = this.ids().has(id);
    this.setIds((s) => {
      const n = new Set(s);
      if (on) n.delete(id);
      else n.add(id);
      return n;
    });
    try {
      await api(`/api/wishlist/${id}`, { method: on ? "DELETE" : "PUT" });
    } catch {
      this.setIds((s) => {
        const n = new Set(s);
        if (on) n.add(id);
        else n.delete(id);
        return n;
      });
    }
  }
}

const RECENT_KEY = "pc_recent_v1";

export function rememberViewed(p: { id: string; slug: string; title: string; image: string; price: number; mrp: number }, max = 12) {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]").filter((x: { id: string }) => x.id !== p.id);
    list.unshift(p);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, Math.max(1, max))));
  } catch {
    /* storage unavailable */
  }
}

export function readViewed(): { id: string; slug: string; title: string; image: string; price: number; mrp: number }[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
  } catch {
    return [];
  }
}
