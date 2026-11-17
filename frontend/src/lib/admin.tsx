"use client";

import { createContext, useContext } from "react";

export type AdminMe = { role: string; role_label: string; permissions: string[]; totp_enabled: boolean; name?: string; is_owner?: boolean };
export const AdminCtx = createContext<AdminMe | null>(null);
export function useAdmin() {
  return useContext(AdminCtx);
}
export function useCan(permission: string) {
  return useContext(AdminCtx)?.permissions.includes(permission) ?? false;
}
