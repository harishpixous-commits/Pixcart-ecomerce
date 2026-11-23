"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

/** The owner's password policy (Admin → Sign-in and accounts), for password fields' hints and minimum length. */
export function usePasswordPolicy() {
  const [p, setP] = useState({ min: 12, mixed: true });
  useEffect(() => {
    let live = true;
    api<{ password_min_length?: number; password_require_mixed?: boolean }>("/api/auth/options")
      .then((o) => { if (live) setP({ min: o.password_min_length ?? 12, mixed: o.password_require_mixed ?? true }); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return { ...p, hint: `At least ${p.min} characters${p.mixed ? " with upper and lower case letters and a number" : ""}` };
}
