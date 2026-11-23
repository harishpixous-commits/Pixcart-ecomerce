/** The owner's password policy (Admin → Sign-in and accounts), for password fields' hints and minimum length.
 *  usePasswordPolicy() → passwordPolicy() inside an injection context (a component field initialiser). */

import { computed, signal, type Signal } from "@angular/core";
import { api } from "./api";

export function passwordPolicy(): Signal<{ min: number; mixed: boolean; hint: string }> {
  const p = signal({ min: 12, mixed: true });
  api<{ password_min_length?: number; password_require_mixed?: boolean }>("/api/auth/options")
    .then((o) => p.set({ min: o.password_min_length ?? 12, mixed: o.password_require_mixed ?? true }))
    .catch(() => {});
  return computed(() => ({ ...p(), hint: `At least ${p().min} characters${p().mixed ? " with upper and lower case letters and a number" : ""}` }));
}
