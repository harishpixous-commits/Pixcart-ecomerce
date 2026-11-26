/* Admin → Staff and roles: staff accounts (add, role, two-step reset, remove access) and roles with their permission matrix.
 * Port of frontend/src/app/admin/staff/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { ShieldAlert } from "lucide-angular";
import { AdminContext } from "../../core/admin";
import { api, ApiError } from "../../core/api";
import { dateTime } from "../../core/format";
import { passwordPolicy } from "../../core/password-policy";
import { PageHeader, Table } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Field, Modal, Pill, Select, TextField, Textarea, Toast } from "../../shared/ui/ui";

type Staff = {
  can_manage_owners: boolean;
  roles: { code: string; name: string }[];
  items: { id: string; name: string; email: string; role: string; role_name: string; is_active: boolean; is_you: boolean; totp_enabled: boolean; last_login_at: string | null }[];
};
type Role = { code: string; name: string; description: string; permissions: string[]; is_locked: boolean; staff_count: number };
type Perm = { code: string; label: string; group: string; description: string; sensitive: boolean };
type Draft = { code: string | null; name: string; description: string; permissions: string[] };
type F = { name: string; email: string; role: string; password: string };

@Component({
  selector: "pc-admin-staff-page",
  imports: [PageHeader, Table, Icon, PageLoader, Button, ErrorNote, Field, Modal, Pill, Select, TextField, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (!staff() || !roles()) {
      <pc-page-loader />
    } @else {
      @let st = staff()!;
      @let rs = roles()!;
      <div class="flex flex-col gap-4">
        <pc-page-header title="Staff and roles" sub="Give each person only the access their job needs. Role changes apply on their next click; every change is in the audit log." [withActions]="true">
          @if (tab() === "people") {
            <button actions pcButton (click)="openAdd()">Add staff</button>
          } @else {
            <button actions pcButton (click)="error.set(null); draft.set({ code: null, name: '', description: '', permissions: ['dashboard', 'assistant'] })">New role</button>
          }
        </pc-page-header>
        <div role="tablist" class="flex gap-1 rounded-lg bg-white p-1 text-sm font-medium w-fit">
          @for (t of tabNames; track t) {
            <button role="tab" [attr.aria-selected]="tab() === t" (click)="tab.set(t)"
              [class]="'rounded-md px-4 py-1.5 ' + (tab() === t ? 'bg-peacock text-white' : 'text-ink-soft hover:bg-mist')">
              {{ t === "people" ? "People (" + st.items.length + ")" : "Roles (" + rs.length + ")" }}
            </button>
          }
        </div>
        <pc-error-note [message]="error()" />

        @if (tab() === "people") {
          <pc-table [head]="['Name', 'Role', 'Two-step sign-in', 'Last sign-in', '']">
            @for (u of st.items; track u.id) {
              <tr [class]="u.is_active ? '' : 'opacity-60'">
                <td class="px-4 py-2.5"><p class="font-medium">{{ u.name }}@if (u.is_you) {<span class="ml-2 text-xs text-ink-faint">(you)</span>}</p><p class="text-sm text-ink-faint">{{ u.email }}</p></td>
                <td class="px-4 py-2.5">
                  <select pcSelect (change)="changeRole(u.id, u.role, $any($event.target))" class="w-auto" [attr.aria-label]="'Role for ' + u.name" [disabled]="u.is_you || (u.role === 'owner' && !st.can_manage_owners)">
                    @for (r of st.roles; track r.code) {<option [value]="r.code" [selected]="r.code === u.role" [disabled]="r.code === 'owner' && !st.can_manage_owners">{{ r.name }}</option>}
                  </select>
                </td>
                <td class="px-4 py-2.5">
                  @if (u.totp_enabled) {<pc-pill tone="green">On</pc-pill>} @else {<pc-pill tone="red">Off</pc-pill>}
                  @if (u.totp_enabled && st.can_manage_owners && !u.is_you) {
                    <button class="ml-2 text-xs text-peacock underline" (click)="resetTwoStep(u.id, u.name)">Reset</button>
                  }
                </td>
                <td class="px-4 py-2.5 text-sm">{{ u.last_login_at ? dateTime(u.last_login_at) : "Never" }}</td>
                <td class="px-4 py-2.5">
                  @if (!u.is_you) {
                    @if (u.is_active) {
                      <button pcButton size="sm" variant="danger" (click)="removeAccess(u.id, u.name)">Remove access</button>
                    } @else {
                      <button pcButton size="sm" variant="secondary" (click)="patch(u.id, { is_active: true }, 'Access restored')">Restore</button>
                    }
                  }
                </td>
              </tr>
            }
          </pc-table>
        } @else {
          <section class="rounded-xl bg-white p-5">
            <div class="overflow-x-auto">
              <table class="w-full min-w-[720px] text-sm">
                <thead>
                  <tr>
                    <th class="py-2 text-left font-medium text-ink-faint">Permission</th>
                    @for (r of rs; track r.code) {
                      <th class="px-2 text-center align-bottom font-medium">
                        <button class="hover:text-peacock disabled:hover:text-ink" [disabled]="r.is_locked" [title]="r.is_locked ? 'The owner role always has everything' : 'Edit role'"
                          (click)="editRole(r)">{{ r.name }}</button>
                        <span class="block text-xs font-normal text-ink-faint">{{ r.staff_count }} staff</span>
                      </th>
                    }
                  </tr>
                </thead>
                <tbody>
                  @for (g of groups(); track g[0]) {
                    <tr><td [attr.colspan]="rs.length + 1" class="pt-4 pb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">{{ g[0] }}</td></tr>
                    @for (p of g[1]; track p.code) {
                      <tr class="border-t border-line">
                        <td class="py-1.5 pr-3"><span class="font-medium">{{ p.label }}</span>@if (p.sensitive) {<svg [pcIcon]="ShieldAlert" class="ml-1 inline h-3.5 w-3.5 text-amber-600" aria-label="Sensitive" />}<span class="block text-xs text-ink-faint">{{ p.description }}</span></td>
                        @for (r of rs; track r.code) {<td class="text-center">@if (r.permissions.includes(p.code)) {<span class="text-leaf" aria-label="Allowed">✓</span>} @else {<span class="text-ink-faint" aria-label="Not allowed">–</span>}</td>}
                      </tr>
                    }
                  }
                </tbody>
              </table>
            </div>
            <p class="mt-3 text-sm text-ink-faint">Select a role name to edit it. The AI assistant follows the same permissions: it can only read and change what the person's role allows.</p>
          </section>
        }

        <pc-modal [open]="adding()" (close)="adding.set(false)" title="Add staff">
          <form (submit)="add($event)" class="flex flex-col gap-3">
            <pc-error-note [message]="error()" />
            <pc-text-field label="Name" [value]="f().name" (valueChange)="setF('name', $event)" [required]="true" />
            <pc-text-field label="Work email" type="email" [value]="f().email" (valueChange)="setF('email', $event)" [required]="true" />
            <pc-field label="Role" for="sr"><select pcSelect id="sr" (change)="setF('role', $any($event.target).value)">
              @for (r of st.roles; track r.code) {<option [value]="r.code" [selected]="r.code === f().role" [disabled]="r.code === 'owner' && !st.can_manage_owners">{{ r.name }}</option>}
            </select></pc-field>
            <pc-text-field label="Temporary password" type="text" autocomplete="new-password" [value]="f().password" (valueChange)="setF('password', $event)" [required]="true" [minlength]="policy().min" [hint]="policy().hint" />
            <button pcButton type="submit">Create account</button>
          </form>
        </pc-modal>

        <pc-modal [open]="!!draft()" (close)="draft.set(null)" [title]="draft()?.code ? 'Edit role: ' + draft()!.name : 'New role'" [wide]="true">
          @if (draft(); as d) {
            <form (submit)="saveRole($event)" class="flex flex-col gap-3">
              <pc-error-note [message]="error()" />
              <div class="grid gap-3 md:grid-cols-2">
                <pc-text-field label="Role name" [value]="d.name" (valueChange)="setDraft({ name: $event })" [required]="true" [minlength]="2" [maxlength]="80" />
                @if (!d.code) {
                  <pc-field label="Start from" for="clone">
                    <select pcSelect id="clone" (change)="cloneFrom($any($event.target).value)">
                      <option value="">Blank</option>
                      @for (r of rs; track r.code) {<option [value]="r.code">{{ r.name }}</option>}
                    </select>
                  </pc-field>
                }
              </div>
              <pc-field label="What this role is for" for="rdesc"><textarea pcTextarea id="rdesc" rows="2" maxlength="300" [value]="d.description" (input)="setDraft({ description: $any($event.target).value })"></textarea></pc-field>
              <div class="grid gap-x-6 gap-y-1 md:grid-cols-2">
                @for (g of groups(); track g[0]) {
                  <fieldset class="mt-2">
                    <legend class="text-xs font-semibold uppercase tracking-wide text-ink-faint">{{ g[0] }}</legend>
                    @for (p of g[1]; track p.code) {
                      <label [class]="'flex items-start gap-2 py-1 ' + (blocked(p.code) ? 'opacity-50' : '')">
                        <input type="checkbox" class="mt-1" [disabled]="blocked(p.code) || p.code === 'dashboard'" [checked]="d.permissions.includes(p.code)"
                          (change)="togglePerm(p.code, $any($event.target).checked)" />
                        <span><span class="font-medium">{{ p.label }}</span>@if (p.sensitive) {<svg [pcIcon]="ShieldAlert" class="ml-1 inline h-3.5 w-3.5 text-amber-600" aria-label="Sensitive" />}<span class="block text-xs text-ink-faint">{{ p.description }}</span></span>
                      </label>
                    }
                  </fieldset>
                }
              </div>
              <div class="mt-2 flex flex-wrap items-center gap-2">
                <button pcButton type="submit">{{ d.code ? "Save role" : "Create role" }}</button>
                @if (d.code && (staffCount(d.code) === 0)) {
                  <button pcButton type="button" variant="danger" (click)="deleteRole(d)">Delete role</button>
                }
                @if (!isOwner()) {<span class="text-sm text-ink-faint">You can only give permissions you have yourself.</span>}
              </div>
            </form>
          }
        </pc-modal>
      </div>
    }
  `,
})
export class AdminStaffPage {
  protected readonly policy = passwordPolicy();
  private readonly toast = inject(Toast);
  private readonly admin = inject(AdminContext);
  protected readonly ShieldAlert = ShieldAlert;
  protected readonly dateTime = dateTime;
  protected readonly tabNames = ["people", "roles"] as const;
  protected readonly tab = signal<"people" | "roles">("people");
  protected readonly staff = signal<Staff | null>(null);
  protected readonly roles = signal<Role[] | null>(null);
  protected readonly perms = signal<Perm[]>([]);
  protected readonly adding = signal(false);
  protected readonly f = signal<F>({ name: "", email: "", role: "", password: "" });
  protected readonly draft = signal<Draft | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly isOwner = computed(() => !!this.admin.me()?.is_owner);
  private readonly mine = computed(() => new Set(this.admin.me()?.permissions ?? []));
  protected readonly groups = computed(() => {
    const g = new Map<string, Perm[]>();
    for (const p of this.perms()) g.set(p.group, [...(g.get(p.group) ?? []), p]);
    return [...g.entries()];
  });

  constructor() {
    this.load().catch((e) => this.error.set(e instanceof ApiError ? e.message : "Could not load staff and roles"));
  }

  private load(): Promise<void> {
    return Promise.all([
      api<Staff>("/api/admin/staff"),
      api<{ items: Role[] }>("/api/admin/roles"),
      api<{ items: Perm[] }>("/api/admin/permissions"),
    ]).then(([s, r, p]) => {
      this.staff.set(s);
      this.roles.set(r.items);
      this.perms.set(p.items);
    });
  }

  protected blocked(code: string): boolean {
    return !this.isOwner() && !this.mine().has(code);
  }

  protected staffCount(code: string): number {
    return this.roles()?.find((r) => r.code === code)?.staff_count ?? 0;
  }

  private async run(fn: () => Promise<unknown>, ok: string): Promise<boolean> {
    this.error.set(null);
    try {
      await fn();
      this.toast.show(ok);
      await this.load();
      return true;
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Something went wrong");
      return false;
    }
  }

  protected patch(id: string, body: object, ok: string): void {
    void this.run(() => api(`/api/admin/staff/${id}`, { method: "PATCH", body }), ok);
  }

  protected async changeRole(id: string, was: string, el: HTMLSelectElement): Promise<void> {
    const ok = await this.run(() => api(`/api/admin/staff/${id}`, { method: "PATCH", body: { role: el.value } }), "Role changed");
    if (!ok) el.value = was; // the select shows the saved role again, as the reference's controlled select does
  }

  protected resetTwoStep(id: string, name: string): void {
    if (window.confirm(`Reset two-step sign-in for ${name}? Use this when they lost their phone.`)) this.patch(id, { reset_two_step: true }, "Two-step sign-in reset");
  }

  protected removeAccess(id: string, name: string): void {
    if (window.confirm(`Remove access for ${name}? They are signed out at once.`)) this.patch(id, { is_active: false }, "Access removed");
  }

  protected setF(k: keyof F, v: string): void {
    this.f.update((f) => ({ ...f, [k]: v }));
  }

  protected openAdd(): void {
    this.error.set(null);
    this.f.update((f) => ({ ...f, role: this.roles()?.find((r) => !r.is_locked)?.code ?? "" }));
    this.adding.set(true);
  }

  protected async add(e: Event): Promise<void> {
    e.preventDefault();
    const body = this.f();
    const done = await this.run(() => api("/api/admin/staff", { method: "POST", body }), "Staff account created. Share the password privately; ask them to change it and turn on two-step sign-in.");
    if (done) {
      this.adding.set(false);
      this.f.set({ name: "", email: "", role: "", password: "" });
    }
  }

  protected editRole(r: Role): void {
    this.error.set(null);
    this.draft.set({ code: r.code, name: r.name, description: r.description, permissions: r.permissions });
  }

  protected setDraft(patch: Partial<Draft>): void {
    this.draft.update((d) => (d ? { ...d, ...patch } : d));
  }

  protected cloneFrom(code: string): void {
    const r = this.roles()?.find((x) => x.code === code);
    if (r) this.setDraft({ permissions: r.permissions.filter((p) => this.isOwner() || this.mine().has(p)) });
  }

  protected togglePerm(code: string, on: boolean): void {
    const d = this.draft();
    if (d) this.setDraft({ permissions: on ? [...d.permissions, code] : d.permissions.filter((x) => x !== code) });
  }

  protected async saveRole(e: Event): Promise<void> {
    e.preventDefault();
    const draft = this.draft();
    if (!draft) return;
    const body = { name: draft.name, description: draft.description, permissions: draft.permissions };
    const done = await this.run(
      () => (draft.code ? api(`/api/admin/roles/${draft.code}`, { method: "PUT", body }) : api("/api/admin/roles", { method: "POST", body })),
      draft.code ? "Role saved. It applies to everyone with this role straight away." : "Role created",
    );
    if (done) this.draft.set(null);
  }

  protected async deleteRole(d: Draft): Promise<void> {
    if (window.confirm(`Delete the role ${d.name}?`) && (await this.run(() => api(`/api/admin/roles/${d.code}`, { method: "DELETE" }), "Role deleted"))) this.draft.set(null);
  }
}
