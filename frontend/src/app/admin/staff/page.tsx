"use client";

import { ShieldAlert } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, Table } from "@/components/portal-shell";
import { Button, ErrorNote, Field, Modal, PageLoader, Pill, Select, TextField, Textarea, useToast } from "@/components/ui";
import { useAdmin } from "@/lib/admin";
import { api, ApiError } from "@/lib/api";
import { dateTime } from "@/lib/format";

type Staff = {
  can_manage_owners: boolean;
  roles: { code: string; name: string }[];
  items: { id: string; name: string; email: string; role: string; role_name: string; is_active: boolean; is_you: boolean; totp_enabled: boolean; last_login_at: string | null }[];
};
type Role = { code: string; name: string; description: string; permissions: string[]; is_locked: boolean; staff_count: number };
type Perm = { code: string; label: string; group: string; description: string; sensitive: boolean };
type Draft = { code: string | null; name: string; description: string; permissions: string[] };

export default function StaffPage() {
  const toast = useToast();
  const me = useAdmin();
  const [tab, setTab] = useState<"people" | "roles">("people");
  const [staff, setStaff] = useState<Staff | null>(null);
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [perms, setPerms] = useState<Perm[]>([]);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: "", email: "", role: "", password: "" });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      Promise.all([
        api<Staff>("/api/admin/staff"),
        api<{ items: Role[] }>("/api/admin/roles"),
        api<{ items: Perm[] }>("/api/admin/permissions"),
      ]).then(([s, r, p]) => {
        setStaff(s);
        setRoles(r.items);
        setPerms(p.items);
      }),
    [],
  );
  useEffect(() => {
    load().catch((e) => setError(e instanceof ApiError ? e.message : "Could not load staff and roles"));
  }, [load]);

  const groups = useMemo(() => {
    const g = new Map<string, Perm[]>();
    for (const p of perms) g.set(p.group, [...(g.get(p.group) ?? []), p]);
    return [...g.entries()];
  }, [perms]);
  const mine = new Set(me?.permissions ?? []);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setError(null);
    try {
      await fn();
      toast(ok);
      await load();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong");
      return false;
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const done = await run(() => api("/api/admin/staff", { method: "POST", body: f }), "Staff account created. Share the password privately; ask them to change it and turn on two-step sign-in.");
    if (done) { setAdding(false); setF({ name: "", email: "", role: "", password: "" }); }
  }

  async function saveRole(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    const body = { name: draft.name, description: draft.description, permissions: draft.permissions };
    const done = await run(
      () => draft.code ? api(`/api/admin/roles/${draft.code}`, { method: "PUT", body }) : api("/api/admin/roles", { method: "POST", body }),
      draft.code ? "Role saved. It applies to everyone with this role straight away." : "Role created",
    );
    if (done) setDraft(null);
  }

  if (!staff || !roles) return <PageLoader />;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Staff and roles"
        sub="Give each person only the access their job needs. Role changes apply on their next click; every change is in the audit log."
        actions={tab === "people"
          ? <Button onClick={() => { setError(null); setF({ ...f, role: roles.find((r) => !r.is_locked)?.code ?? "" }); setAdding(true); }}>Add staff</Button>
          : <Button onClick={() => { setError(null); setDraft({ code: null, name: "", description: "", permissions: ["dashboard", "assistant"] }); }}>New role</Button>}
      />
      <div role="tablist" className="flex gap-1 rounded-lg bg-white p-1 text-sm font-medium w-fit">
        {(["people", "roles"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`rounded-md px-4 py-1.5 ${tab === t ? "bg-peacock text-white" : "text-ink-soft hover:bg-mist"}`}>
            {t === "people" ? `People (${staff.items.length})` : `Roles (${roles.length})`}
          </button>
        ))}
      </div>
      <ErrorNote message={error} />

      {tab === "people" ? (
        <Table head={["Name", "Role", "Two-step sign-in", "Last sign-in", ""]}>
          {staff.items.map((u) => (
            <tr key={u.id} className={u.is_active ? "" : "opacity-60"}>
              <td className="px-4 py-2.5"><p className="font-medium">{u.name}{u.is_you && <span className="ml-2 text-xs text-ink-faint">(you)</span>}</p><p className="text-sm text-ink-faint">{u.email}</p></td>
              <td className="px-4 py-2.5">
                <Select value={u.role} onChange={(e) => run(() => api(`/api/admin/staff/${u.id}`, { method: "PATCH", body: { role: e.target.value } }), "Role changed")}
                  className="w-auto" aria-label={`Role for ${u.name}`} disabled={u.is_you || (u.role === "owner" && !staff.can_manage_owners)}>
                  {staff.roles.map((r) => <option key={r.code} value={r.code} disabled={r.code === "owner" && !staff.can_manage_owners}>{r.name}</option>)}
                </Select>
              </td>
              <td className="px-4 py-2.5">
                {u.totp_enabled ? <Pill tone="green">On</Pill> : <Pill tone="red">Off</Pill>}
                {u.totp_enabled && staff.can_manage_owners && !u.is_you && (
                  <button className="ml-2 text-xs text-peacock underline" onClick={() => window.confirm(`Reset two-step sign-in for ${u.name}? Use this when they lost their phone.`) && run(() => api(`/api/admin/staff/${u.id}`, { method: "PATCH", body: { reset_two_step: true } }), "Two-step sign-in reset")}>Reset</button>
                )}
              </td>
              <td className="px-4 py-2.5 text-sm">{u.last_login_at ? dateTime(u.last_login_at) : "Never"}</td>
              <td className="px-4 py-2.5">
                {!u.is_you && (u.is_active
                  ? <Button size="sm" variant="danger" onClick={() => window.confirm(`Remove access for ${u.name}? They are signed out at once.`) && run(() => api(`/api/admin/staff/${u.id}`, { method: "PATCH", body: { is_active: false } }), "Access removed")}>Remove access</Button>
                  : <Button size="sm" variant="secondary" onClick={() => run(() => api(`/api/admin/staff/${u.id}`, { method: "PATCH", body: { is_active: true } }), "Access restored")}>Restore</Button>)}
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <section className="rounded-xl bg-white p-5">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr>
                  <th className="py-2 text-left font-medium text-ink-faint">Permission</th>
                  {roles.map((r) => (
                    <th key={r.code} className="px-2 text-center align-bottom font-medium">
                      <button className="hover:text-peacock disabled:hover:text-ink" disabled={r.is_locked} title={r.is_locked ? "The owner role always has everything" : "Edit role"}
                        onClick={() => { setError(null); setDraft({ code: r.code, name: r.name, description: r.description, permissions: r.permissions }); }}>
                        {r.name}
                      </button>
                      <span className="block text-xs font-normal text-ink-faint">{r.staff_count} staff</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map(([group, items]) => (
                  <Fragment key={group}>
                    <tr><td colSpan={roles.length + 1} className="pt-4 pb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">{group}</td></tr>
                    {items.map((p) => (
                      <tr key={p.code} className="border-t border-line">
                        <td className="py-1.5 pr-3"><span className="font-medium">{p.label}</span>{p.sensitive && <ShieldAlert className="ml-1 inline h-3.5 w-3.5 text-amber-600" aria-label="Sensitive" />}<span className="block text-xs text-ink-faint">{p.description}</span></td>
                        {roles.map((r) => <td key={r.code} className="text-center">{r.permissions.includes(p.code) ? <span className="text-leaf" aria-label="Allowed">✓</span> : <span className="text-ink-faint" aria-label="Not allowed">–</span>}</td>)}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-sm text-ink-faint">Select a role name to edit it. The AI assistant follows the same permissions: it can only read and change what the person&apos;s role allows.</p>
        </section>
      )}

      <Modal open={adding} onClose={() => setAdding(false)} title="Add staff">
        <form onSubmit={add} className="flex flex-col gap-3">
          <ErrorNote message={error} />
          <TextField label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          <TextField label="Work email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
          <Field label="Role" htmlFor="sr"><Select id="sr" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{staff.roles.map((r) => <option key={r.code} value={r.code} disabled={r.code === "owner" && !staff.can_manage_owners}>{r.name}</option>)}</Select></Field>
          <TextField label="Temporary password" type="text" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={12} hint="At least 12 characters with upper and lower case letters and a number" />
          <Button type="submit">Create account</Button>
        </form>
      </Modal>

      <Modal open={!!draft} onClose={() => setDraft(null)} title={draft?.code ? `Edit role: ${draft.name}` : "New role"} wide>
        {draft && (
          <form onSubmit={saveRole} className="flex flex-col gap-3">
            <ErrorNote message={error} />
            <div className="grid gap-3 md:grid-cols-2">
              <TextField label="Role name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required minLength={2} maxLength={80} />
              {!draft.code && (
                <Field label="Start from" htmlFor="clone">
                  <Select id="clone" defaultValue="" onChange={(e) => { const r = roles.find((x) => x.code === e.target.value); if (r) setDraft({ ...draft, permissions: r.permissions.filter((p) => me?.is_owner || mine.has(p)) }); }}>
                    <option value="">Blank</option>
                    {roles.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
                  </Select>
                </Field>
              )}
            </div>
            <Field label="What this role is for" htmlFor="rdesc"><Textarea id="rdesc" rows={2} maxLength={300} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>
            <div className="grid gap-x-6 gap-y-1 md:grid-cols-2">
              {groups.map(([group, items]) => (
                <fieldset key={group} className="mt-2">
                  <legend className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{group}</legend>
                  {items.map((p) => {
                    const blocked = !me?.is_owner && !mine.has(p.code);
                    return (
                      <label key={p.code} className={`flex items-start gap-2 py-1 ${blocked ? "opacity-50" : ""}`}>
                        <input type="checkbox" className="mt-1" disabled={blocked || p.code === "dashboard"} checked={draft.permissions.includes(p.code)}
                          onChange={(e) => setDraft({ ...draft, permissions: e.target.checked ? [...draft.permissions, p.code] : draft.permissions.filter((x) => x !== p.code) })} />
                        <span><span className="font-medium">{p.label}</span>{p.sensitive && <ShieldAlert className="ml-1 inline h-3.5 w-3.5 text-amber-600" aria-label="Sensitive" />}<span className="block text-xs text-ink-faint">{p.description}</span></span>
                      </label>
                    );
                  })}
                </fieldset>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button type="submit">{draft.code ? "Save role" : "Create role"}</Button>
              {draft.code && (roles.find((r) => r.code === draft.code)?.staff_count ?? 0) === 0 && (
                <Button type="button" variant="danger" onClick={async () => { if (window.confirm(`Delete the role ${draft.name}?`) && await run(() => api(`/api/admin/roles/${draft.code}`, { method: "DELETE" }), "Role deleted")) setDraft(null); }}>Delete role</Button>
              )}
              {!me?.is_owner && <span className="text-sm text-ink-faint">You can only give permissions you have yourself.</span>}
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
