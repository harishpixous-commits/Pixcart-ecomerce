"use client";

import { createContext, useContext } from "react";

export type AdminMe = {
  role: string; role_label: string; permissions: string[]; totp_enabled: boolean; name?: string; is_owner?: boolean;
  /** the owner requires two-step sign-in for staff and this person has not set it up yet */
  two_step_required?: boolean;
};

/** Ask the admin layout to read /api/admin/me again (e.g. right after two-step sign-in is turned on). */
export const ADMIN_ME_REFRESH = "admin-me:refresh";
export const AdminCtx = createContext<AdminMe | null>(null);
export function useAdmin() {
  return useContext(AdminCtx);
}
export function useCan(permission: string) {
  return useContext(AdminCtx)?.permissions.includes(permission) ?? false;
}
