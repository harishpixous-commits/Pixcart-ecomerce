"use client";

import { Heart } from "lucide-react";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "./api";
import { useSession } from "./session";
import { useSite } from "./site";

const Ctx = createContext<{ ids: Set<string>; toggle: (id: string) => Promise<void> }>({ ids: new Set(), toggle: async () => {} });

export function WishlistProvider({ children }: { children: React.ReactNode }) {
  const { user } = useSession();
  const [ids, setIds] = useState<Set<string>>(new Set());
  const router = useRouter();
  useEffect(() => {
    if (!user) {
      setIds(new Set());
      return;
    }
    api<{ ids: string[] }>("/api/wishlist").then((r) => setIds(new Set(r.ids))).catch(() => {});
  }, [user]);
  const toggle = useCallback(
    async (id: string) => {
      if (!user) {
        router.push(`/login?next=${encodeURIComponent(window.location.pathname)}`);
        return;
      }
      const on = ids.has(id);
      setIds((s) => {
        const n = new Set(s);
        if (on) n.delete(id);
        else n.add(id);
        return n;
      });
      try {
        await api(`/api/wishlist/${id}`, { method: on ? "DELETE" : "PUT" });
      } catch {
        setIds((s) => {
          const n = new Set(s);
          if (on) n.add(id);
          else n.delete(id);
          return n;
        });
      }
    },
    [ids, user, router],
  );
  return <Ctx.Provider value={{ ids, toggle }}>{children}</Ctx.Provider>;
}

export function useWishlist() {
  return useContext(Ctx);
}

export function WishlistHeart({ productId, className }: { productId: string; className?: string }) {
  const { ids, toggle } = useWishlist();
  const site = useSite();
  if (!site.features.wishlist) return null;
  const on = ids.has(productId);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle(productId);
      }}
      aria-pressed={on}
      aria-label={on ? "Remove from wishlist" : "Save to wishlist"}
      className={className ?? "absolute right-2 top-2 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white/90 shadow-sm ring-1 ring-line hover:bg-white"}
    >
      <Heart className={on ? "h-5 w-5 fill-vermilion text-vermilion" : "h-5 w-5 text-ink-faint"} />
    </button>
  );
}

const RECENT_KEY = "pc_recent_v1";

export function rememberViewed(p: { id: string; slug: string; title: string; image: string; price: number; mrp: number }) {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]").filter((x: { id: string }) => x.id !== p.id);
    list.unshift(p);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 12)));
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
