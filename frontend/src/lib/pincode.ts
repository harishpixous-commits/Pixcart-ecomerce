"use client";

import { useSyncExternalStore } from "react";

/*
 * The delivery PIN code the shopper chose ("Deliver to 641001"), shared by the header and every product page,
 * kept in this browser only. Signed-in shoppers start from their default address.
 */

const KEY = "pc_pin";
const listeners = new Set<() => void>();

function read(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function setPincode(pin: string): void {
  try {
    if (pin) localStorage.setItem(KEY, pin);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: the PIN lives for this page only */
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

export function usePincode(): string {
  return useSyncExternalStore(subscribe, read, () => "");
}

export const isPincode = (v: string) => /^[1-9]\d{5}$/.test(v);
