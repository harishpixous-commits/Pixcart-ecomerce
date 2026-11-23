"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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

/* ---------------------------------------------------------------- context */

interface SessionCtx {
  user: User | null;
  ready: boolean;
  signIn: (token: string, user: User) => Promise<void>;
  signOut: () => Promise<void>;
  reloadUser: () => Promise<void>;
  cartCount: number;
  guestLines: GuestLine[];
  /** resolves to a note when the quantity had to be lowered (stock, the per-item limit, a deal's units), else null */
  addToCart: (line: GuestLine) => Promise<string | null>;
  setGuestQty: (variantId: string, qty: number) => void;
  refreshCart: () => Promise<CartView | null>;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [cartCount, setCartCount] = useState(0);
  const [guestLines, setGuestLines] = useState<GuestLine[]>([]);
  // Kept in sync wherever setUser is called, so callbacks read the latest user without re-creating.
  const userRef = useRef<User | null>(null);
  // Settles once the saved sign-in has been restored (or found missing). Adding to the cart waits for it, so a tap
  // during page load goes to the account's cart, not to a guest cart that a signed-in shopper never sees.
  const [restored] = useState(() => {
    let done = () => {};
    const promise = new Promise<void>((r) => { done = r; });
    return { promise, done: () => done() };
  });

  const refreshCart = useCallback(async () => {
    if (!userRef.current) {
      const g = readGuest();
      setGuestLines(g);
      setCartCount(g.reduce((n, l) => n + l.qty, 0));
      return null;
    }
    try {
      const cart = await api<CartView>("/api/cart");
      setCartCount(cart.summary.item_count + cart.groups.flatMap((g) => g.lines).filter((l) => l.problem).reduce((n, l) => n + l.qty, 0));
      return cart;
    } catch {
      return null;
    }
  }, []);

  /** Moves lines added while signed out into the account's cart; keeps them if that fails, so nothing is lost. */
  const mergeGuest = useCallback(async () => {
    const g = readGuest();
    if (!g.length) return;
    try {
      await api("/api/cart/merge", { method: "POST", body: { items: g.map((l) => ({ variant_id: l.variant_id, qty: l.qty })) } });
      writeGuest([]);
      setGuestLines([]);
    } catch {
      /* keep the guest cart */
    }
  }, []);

  const loadUser = useCallback(async () => {
    const me = await api<User>("/api/auth/me");
    setUser(me);
    userRef.current = me;
    return me;
  }, []);

  useEffect(() => {
    (async () => {
      if (hint() && (await refreshSession())) {
        try {
          await loadUser();
        } catch {
          setAccessToken(null);
        }
      } else {
        hint(false);
      }
      if (userRef.current) await mergeGuest(); // e.g. added in another tab while signed out
      setReady(true);
      restored.done();
      await refreshCart();
    })();
  }, [loadUser, refreshCart, mergeGuest, restored]);

  // The session can change outside this page: it expires, the person signs out in another tab, or signs in
  // as someone else in another tab (one browser keeps one sign-in). Follow it instead of showing stale data.
  useEffect(
    () =>
      onTokenChange((token) => {
        const current = userRef.current;
        if (!token) {
          if (current) {
            hint(false);
            userRef.current = null;
            setUser(null); // layouts send the person to sign in
            refreshCart();
          }
          return;
        }
        if (current && tokenSubject(token) !== current.id) loadUser().then(() => refreshCart()).catch(() => setAccessToken(null));
      }),
    [loadUser, refreshCart],
  );

  const signIn = useCallback(
    async (token: string, u: User) => {
      setAccessToken(token);
      hint(true);
      setUser(u);
      userRef.current = u;
      await mergeGuest();
      await refreshCart();
    },
    [refreshCart, mergeGuest],
  );

  const signOut = useCallback(async () => {
    await removePushToken(); // this device stops getting the account's notifications
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      /* already signed out */
    }
    setAccessToken(null);
    hint(false);
    setUser(null);
    userRef.current = null;
    await refreshCart();
  }, [refreshCart]);

  /** Adds to the cart; returns a note for the shopper when the quantity had to be lowered (or null). */
  const addToCart = useCallback(
    async (line: GuestLine): Promise<string | null> => {
      let note: string | null = null;
      await restored.promise;
      if (userRef.current) {
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
      await refreshCart();
      return note;
    },
    [refreshCart, restored],
  );

  const setGuestQty = useCallback((variantId: string, qty: number) => {
    const g = readGuest()
      .map((l) => (l.variant_id === variantId ? { ...l, qty } : l))
      .filter((l) => l.qty > 0);
    writeGuest(g);
    setGuestLines(g);
    setCartCount(g.reduce((n, l) => n + l.qty, 0));
  }, []);

  const reloadUser = useCallback(async () => {
    await loadUser();
  }, [loadUser]);

  const value = useMemo(
    () => ({ user, ready, signIn, signOut, reloadUser, cartCount, guestLines, addToCart, setGuestQty, refreshCart }),
    [user, ready, signIn, signOut, reloadUser, cartCount, guestLines, addToCart, setGuestQty, refreshCart],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}
