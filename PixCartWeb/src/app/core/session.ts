/*
 * The signed-in person, their cart count and the guest cart. Port of frontend/src/lib/session.tsx with the same restore
 * order: (1) if the "probably signed in" hint is set, refresh the access token and read /api/auth/me; (2) merge a guest
 * cart into the account; (3) ready; (4) count the cart. useSession() → inject(SessionService).
 */

import { Injectable, signal } from "@angular/core";
import { api, onTokenChange, refreshSession, setAccessToken } from "./api";
import { removePushToken } from "./push";
import type { CartView, User } from "./types";

/** The user id inside an access token (not verified here; the server verifies every request). */
function tokenSubject(token: string): string | null {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return (JSON.parse(atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), "="))) as { sub?: string }).sub ?? null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- guest cart (signed out) */

export interface GuestLine {
  variant_id: string;
  qty: number;
  title: string;
  image: string;
  price: number;
  mrp: number;
  slug: string;
  variant_label: string;
  seller_name: string;
  /** most units allowed when added (stock, the per-item limit, units left at a deal price); the server checks again */
  max?: number;
}

const GUEST_KEY = "pc_guest_cart_v1";
// Non-secret hint that a refresh cookie probably exists, so signed-out visitors skip the refresh call.
const SESSION_HINT = "pc_signed_in";

function hint(on?: boolean): boolean {
  try {
    if (on === true) window.localStorage.setItem(SESSION_HINT, "1");
    else if (on === false) window.localStorage.removeItem(SESSION_HINT);
    return window.localStorage.getItem(SESSION_HINT) === "1";
  } catch {
    return true;
  }
}

function readGuest(): GuestLine[] {
  try {
    const raw = window.localStorage.getItem(GUEST_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((l) => l && typeof l.variant_id === "string") : [];
  } catch {
    return [];
  }
}

function writeGuest(lines: GuestLine[]) {
  try {
    window.localStorage.setItem(GUEST_KEY, JSON.stringify(lines));
  } catch {
    /* storage unavailable (private mode) — the cart lives for this page only */
  }
}

@Injectable({ providedIn: "root" })
export class SessionService {
  readonly user = signal<User | null>(null);
  /** true once the saved sign-in has been restored (or found missing) */
  readonly ready = signal(false);
  readonly cartCount = signal(0);
  readonly guestLines = signal<GuestLine[]>([]);

  // Settles once the saved sign-in has been restored. Adding to the cart waits for it, so a tap during page load goes
  // to the account's cart, not to a guest cart that a signed-in shopper never sees.
  private restoredDone: () => void = () => {};
  private readonly restored = new Promise<void>((r) => (this.restoredDone = r));
  private started = false;

  /** Restores the saved sign-in (called once at start-up; does not block the first render). */
  start(): void {
    if (this.started) return;
    this.started = true;
    // The session can change outside this page: it expires, the person signs out in another tab, or signs in as
    // someone else in another tab (one browser keeps one sign-in). Follow it instead of showing stale data.
    onTokenChange((token) => {
      const current = this.user();
      if (!token) {
        if (current) {
          hint(false);
          this.user.set(null); // layouts send the person to sign in
          void this.refreshCart();
        }
        return;
      }
      if (current && tokenSubject(token) !== current.id) this.loadUser().then(() => this.refreshCart()).catch(() => setAccessToken(null));
    });
    void (async () => {
      if (hint() && (await refreshSession())) {
        try {
          await this.loadUser();
        } catch {
          setAccessToken(null);
        }
      } else {
        hint(false);
      }
      if (this.user()) await this.mergeGuest(); // e.g. added in another tab while signed out
      this.ready.set(true);
      this.restoredDone();
      await this.refreshCart();
    })();
  }

  private async loadUser(): Promise<User> {
    const me = await api<User>("/api/auth/me");
    this.user.set(me);
    return me;
  }

  async refreshCart(): Promise<CartView | null> {
    if (!this.user()) {
      const g = readGuest();
      this.guestLines.set(g);
      this.cartCount.set(g.reduce((n, l) => n + l.qty, 0));
      return null;
    }
    try {
      const cart = await api<CartView>("/api/cart");
      this.cartCount.set(cart.summary.item_count + cart.groups.flatMap((g) => g.lines).filter((l) => l.problem).reduce((n, l) => n + l.qty, 0));
      return cart;
    } catch {
      return null;
    }
  }

  /** Moves lines added while signed out into the account's cart; keeps them if that fails, so nothing is lost. */
  private async mergeGuest(): Promise<void> {
    const g = readGuest();
    if (!g.length) return;
    try {
      await api("/api/cart/merge", { method: "POST", body: { items: g.map((l) => ({ variant_id: l.variant_id, qty: l.qty })) } });
      writeGuest([]);
      this.guestLines.set([]);
    } catch {
      /* keep the guest cart */
    }
  }

  async signIn(token: string, u: User): Promise<void> {
    setAccessToken(token);
    hint(true);
    this.user.set(u);
    await this.mergeGuest();
    await this.refreshCart();
  }

  async signOut(): Promise<void> {
    await removePushToken(); // this device stops getting the account's notifications
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      /* already signed out */
    }
    setAccessToken(null);
    hint(false);
    this.user.set(null);
    await this.refreshCart();
  }

  async reloadUser(): Promise<void> {
    await this.loadUser();
  }

  /** Adds to the cart; returns a note for the shopper when the quantity had to be lowered (or null). */
  async addToCart(line: GuestLine): Promise<string | null> {
    let note: string | null = null;
    await this.restored;
    if (this.user()) {
      const r = await api<CartView>("/api/cart/items", { method: "POST", body: { variant_id: line.variant_id, qty: line.qty } });
      note = r.notice || null;
    } else {
      const g = readGuest();
      const cap = Math.max(1, line.max ?? 10);
      const existing = g.find((l) => l.variant_id === line.variant_id);
      const wanted = (existing?.qty ?? 0) + line.qty;
      if (wanted > cap) note = `You can add at most ${cap} of this item, so your cart has ${cap}.`;
      if (existing) Object.assign(existing, { qty: Math.min(cap, wanted), max: cap });
      else g.push({ ...line, qty: Math.min(cap, line.qty), max: cap });
      writeGuest(g);
    }
    await this.refreshCart();
    return note;
  }

  setGuestQty(variantId: string, qty: number): void {
    const g = readGuest()
      .map((l) => (l.variant_id === variantId ? { ...l, qty } : l))
      .filter((l) => l.qty > 0);
    writeGuest(g);
    this.guestLines.set(g);
    this.cartCount.set(g.reduce((n, l) => n + l.qty, 0));
  }
}
