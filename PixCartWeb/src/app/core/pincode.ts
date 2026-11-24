/*
 * The delivery PIN code the shopper chose ("Deliver to 641001"), shared by the header and every product page,
 * kept in this browser only. Signed-in shoppers start from their default address. Port of frontend/src/lib/pincode.ts:
 * usePincode() → inject(PincodeService).pin().
 */

import { Injectable, signal } from "@angular/core";

const KEY = "pc_pin";

function read(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

@Injectable({ providedIn: "root" })
export class PincodeService {
  readonly pin = signal(read());

  constructor() {
    registerPincodeService(this);
    window.addEventListener("storage", (e) => {
      if (e.key === KEY) this.pin.set(read());
    });
  }

  set(pin: string): void {
    setPincode(pin);
  }
}

let service: PincodeService | null = null;
/** Remembers the PIN (all PincodeService instances follow). */
export function setPincode(pin: string): void {
  try {
    if (pin) localStorage.setItem(KEY, pin);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: the PIN lives for this page only */
  }
  service?.pin.set(pin);
}
export function registerPincodeService(s: PincodeService) {
  service = s;
}

export const isPincode = (v: string) => /^[1-9]\d{5}$/.test(v);
