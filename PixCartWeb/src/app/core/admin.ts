/*
 * The signed-in staff member's role and permissions in the admin panel (GET /api/admin/me), set by the admin layout.
 * Port of frontend/src/lib/admin.tsx: useAdmin() → inject(AdminContext).me(), useCan(p) → inject(AdminContext).can(p).
 */

import { Injectable, signal } from "@angular/core";

export type AdminMe = {
  role: string; role_label: string; permissions: string[]; totp_enabled: boolean; name?: string; is_owner?: boolean;
  /** the owner requires two-step sign-in for staff and this person has not set it up yet */
  two_step_required?: boolean;
};

/** Ask the admin layout to read /api/admin/me again (e.g. right after two-step sign-in is turned on). */
export const ADMIN_ME_REFRESH = "admin-me:refresh";

@Injectable({ providedIn: "root" })
export class AdminContext {
  readonly me = signal<AdminMe | null>(null);
  can(permission: string): boolean {
    return this.me()?.permissions.includes(permission) ?? false;
  }
}
