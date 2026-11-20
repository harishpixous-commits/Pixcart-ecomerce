"use client";

import clsx from "clsx";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Button, ErrorNote, Field, PageLoader, TextField, useToast } from "@/components/ui";
import { api, ApiError, quietly, uploadWithProgress } from "@/lib/api";
import { paiseToInput, rupees, toPaise } from "@/lib/format";

type Values = Record<string, boolean | number | string>;

const MODES: { value: string; title: string; text: string }[] = [
  { value: "zones", title: "Zones only", text: "Your partners deliver when the store and the customer are both in your zones of the same city. Everything else goes by courier." },
  { value: "all", title: "Every order", text: "Your partners deliver every package. Packages outside your zones wait in the queue for you to assign by hand." },
  { value: "seller_choice", title: "Seller chooses", text: "Inside your zones the seller picks \"Ready for pickup\" (your partner) or \"Ship by courier\" for each order." },
  { value: "off", title: "Couriers only", text: "Your partners get no packages; sellers ship every order by courier." },
];

const MONEY = ["fee_fixed_paise", "fee_base_paise", "fee_per_km_paise", "fee_min_paise", "fee_max_paise", "weather_bonus_paise", "cod_limit_paise"];

function Toggle({ k, v, set, label, hint }: { k: string; v: Values; set: (k: string, x: boolean) => void; label: string; hint: string }) {
  return (
    <label className="flex items-start gap-3 rounded-lg border border-line p-3">
      <input type="checkbox" className="mt-1 h-4 w-4 accent-peacock" checked={Boolean(v[k])} onChange={(e) => set(k, e.target.checked)} data-testid={`toggle-${k}`} />
      <span><span className="font-semibold">{label}</span><br /><span className="text-sm text-ink-soft">{hint}</span></span>
    </label>
  );
}

/** Upload the partner APK: checked by the server, published at /media/apps/…, and set as the download link. */
function AppUpload({ current, version, onUploaded }: { current: string; version: string; onUploaded: (values: Values) => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [ver, setVer] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function upload() {
    if (!file) return;
    setError(null);
    setProgress(0);
    try {
      const r = await uploadWithProgress<{ values: Values; size: number }>(`/api/admin/delivery/app?version=${encodeURIComponent(ver.trim())}`, file, setProgress);
      onUploaded({ android_apk_url: r.values.android_apk_url, app_version: r.values.app_version });
      toast(`App published (${(r.size / 1024 / 1024).toFixed(1)} MB). Partners can download it now.`);
      setFile(null);
      setVer("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Upload failed");
    } finally {
      setProgress(null);
    }
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-dashed border-line p-4 sm:col-span-2">
      {current ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded-full bg-leaf-light px-2.5 py-0.5 text-xs font-semibold text-leaf">Published</span>
          <span className="font-semibold">{version ? `Version ${version}` : "Current app"}</span>
          <a href={current} className="break-all font-semibold text-peacock" download>Download to check</a>
        </p>
      ) : (
        <p className="text-sm text-ink-soft">No app uploaded yet. Partners can still use the web app and add it to their home screen.</p>
      )}
      <ErrorNote message={error} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium">
          New APK file
          <input type="file" accept=".apk,application/vnd.android.package-archive" onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-peacock-light file:px-3 file:py-2 file:font-semibold file:text-peacock" data-testid="apk-file" />
        </label>
        <div className="w-32"><TextField label="Version" value={ver} onChange={(e) => setVer(e.target.value)} placeholder="1.0.1" maxLength={20} /></div>
        <Button type="button" onClick={upload} disabled={!file || progress !== null} loading={progress !== null}>Upload and publish</Button>
      </div>
      {progress !== null && (
        <div className="h-2 overflow-hidden rounded-full bg-mist" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Upload progress">
          <div className="h-full rounded-full bg-peacock transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

export default function DeliverySettings() {
  const toast = useToast();
  const [v, setV] = useState<Values | null>(null);
  const [money, setMoney] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ values: Values }>("/api/admin/delivery/settings").then((r) => {
      setV(r.values);
      setMoney(Object.fromEntries(MONEY.map((k) => [k, paiseToInput(Number(r.values[k]))])));
    }).catch(quietly);
  }, []);
  if (!v) return <PageLoader />;
  const set = (k: string, x: boolean | number | string) => setV({ ...v, [k]: x });
  const num = (k: string) => ({ value: String(v[k] ?? ""), inputMode: "numeric" as const, onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value.replace(/\D/g, "")) || 0) });
  const rs = (k: string) => ({ value: money[k] ?? "", inputMode: "decimal" as const, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setMoney({ ...money, [k]: e.target.value }) });
  const p = (k: string) => toPaise(money[k] ?? "") ?? 0;
  const example = (km: number) => v.fee_mode === "fixed" ? p("fee_fixed_paise") : Math.min(Math.max(p("fee_base_paise") + Math.round(p("fee_per_km_paise") * km), p("fee_min_paise")), p("fee_max_paise"));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!v) return;
    setError(null);
    const body: Values = { ...v };
    for (const k of MONEY) {
      const paise = toPaise(money[k] ?? "");
      if (paise === null) return setError("Enter amounts in rupees, like 30 or 12.50");
      body[k] = paise;
    }
    setBusy(true);
    try {
      const r = await api<{ values: Values }>("/api/admin/delivery/settings", { method: "PUT", body });
      setV(r.values);
      toast("Delivery settings saved");
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  const card = "grid gap-3 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5 sm:grid-cols-2";
  return (
    <form onSubmit={save} className="flex max-w-4xl flex-col gap-4" data-testid="delivery-settings">
      <PageHeader title="Delivery settings" sub="How your own delivery fleet works: which orders it carries, how packages are assigned, what partners earn and the safety checks." />
      <ErrorNote message={error} />

      <section className={card}>
        <h2 className="text-lg font-semibold sm:col-span-2">Delivery fleet</h2>
        <Toggle k="enabled" v={v} set={set} label="Own delivery fleet is on" hint="The partner app, assignment and live tracking. Off pauses everything (sellers ship by courier)." />
        <Toggle k="registration_open" v={v} set={set} label="New partners can register" hint="The Become a delivery partner page and the registration in the app." />
        <fieldset className="sm:col-span-2">
          <legend className="mb-2 font-semibold">Which orders your partners deliver</legend>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
            {MODES.map((m) => (
              <label key={m.value} className={clsx("flex cursor-pointer gap-3 rounded-xl border-2 p-3", v.fleet_mode === m.value ? "border-peacock bg-peacock-light/40" : "border-line hover:border-peacock/40")}>
                <input type="radio" name="fleet_mode" className="mt-1 accent-peacock" checked={v.fleet_mode === m.value} onChange={() => set("fleet_mode", m.value)} />
                <span><span className="font-semibold">{m.title}</span><br /><span className="text-sm text-ink-soft">{m.text}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
      </section>

      <section className={card}>
        <div className="sm:col-span-2"><h2 className="text-lg font-semibold">Assigning packages</h2><p className="text-sm text-ink-soft">With auto-assign on, a package ready for pickup is offered to the nearest free partner in the store&apos;s zone. If they do not accept in time, the next partner gets it.</p></div>
        <Toggle k="auto_assign" v={v} set={set} label="Auto-assign" hint="Off: staff assign every package from the queue." />
        <TextField label="Seconds to accept a request" {...num("offer_seconds")} hint="10 to 180 (30 is common)" />
        <TextField label="Search radius around the store (km)" {...num("radius_km")} hint="1 to 100" />
        <TextField label="Packages a partner carries at once" {...num("max_active")} hint="1 to 10" />
        <TextField label="Partners to try before the queue" {...num("max_offers")} hint="1 to 30. Then staff are alerted." />
      </section>

      <section className={card}>
        <div className="sm:col-span-2"><h2 className="text-lg font-semibold">Partner earnings</h2><p className="text-sm text-ink-soft">What a partner earns for each delivery. Shown on every request before they accept, and paid weekly.</p></div>
        <div className="flex gap-2 sm:col-span-2" role="radiogroup">
          {(["fixed", "distance"] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={v.fee_mode === m} onClick={() => set("fee_mode", m)}
              className={clsx("rounded-full px-4 py-2 font-semibold ring-1", v.fee_mode === m ? "bg-peacock text-white ring-peacock" : "ring-line hover:ring-peacock/50")}>
              {m === "fixed" ? "Same fee for every delivery" : "By distance"}
            </button>
          ))}
        </div>
        {v.fee_mode === "fixed" ? (
          <TextField label="Fee per delivery (₹)" {...rs("fee_fixed_paise")} />
        ) : (
          <>
            <TextField label="Base fee (₹)" {...rs("fee_base_paise")} />
            <TextField label="Per km (₹)" {...rs("fee_per_km_paise")} hint="Distance from the store to the customer" />
            <TextField label="Lowest fee (₹)" {...rs("fee_min_paise")} />
            <TextField label="Highest fee (₹)" {...rs("fee_max_paise")} />
          </>
        )}
        <p className="rounded-xl bg-mist px-4 py-3 text-sm sm:col-span-2">
          Example: a 2 km delivery earns <b>{rupees(example(2))}</b>, a 6 km delivery earns <b>{rupees(example(6))}</b>.
        </p>
        <div className="flex flex-col gap-3 border-t border-line pt-3 sm:col-span-2 sm:flex-row sm:items-start" id="partner-pay">
          <TextField label="Bad weather bonus per trip (₹)" {...rs("weather_bonus_paise")} className="sm:w-56" data-testid="weather-bonus" />
          <p className="text-sm text-ink-soft sm:pt-7">
            Added to every trip a partner finishes while the bad weather fee is on (Checkout and fees). Partners see it on each request and in their earnings. 0 for no bonus.
          </p>
        </div>
      </section>

      <section className={card}>
        <div className="sm:col-span-2"><h2 className="text-lg font-semibold">Cash on delivery</h2><p className="text-sm text-ink-soft">Partners collect cash and deposit it with you. The app shows each partner&apos;s cash in hand.</p></div>
        <TextField label="Most cash a partner may hold (₹)" {...rs("cod_limit_paise")} hint="Above this they get no cash-on-delivery packages until they deposit" />
        <Toggle k="cod_deduct_from_payout" v={v} set={set} label="Take cash not deposited out of the weekly payout" hint="Off: partners deposit cash; payouts are their fees only." />
      </section>

      <section className={card}>
        <div className="sm:col-span-2"><h2 className="text-lg font-semibold">Safety and proof</h2></div>
        <Toggle k="pickup_code_required" v={v} set={set} label="Pickup code at the store" hint="The partner enters the code shown on the seller's order before picking up." />
        <Toggle k="delivery_otp_required" v={v} set={set} label="Customer OTP at the door" hint="The partner enters the code the customer received to finish the delivery." />
        <Toggle k="proof_photo_required" v={v} set={set} label="Delivery photo" hint="A photo of the handed-over package; the customer can see it." />
        <TextField label="Alert staff when a step takes longer than (minutes)" {...num("stuck_minutes")} hint="5 to 720" />
      </section>

      <section className={card}>
        <div className="sm:col-span-2"><h2 className="text-lg font-semibold">Location and map</h2></div>
        <TextField label="Partners share their location every (seconds)" {...num("location_seconds")} hint="5 to 300. Lower is smoother tracking but uses more battery." />
        <Field label="Map tiles" hint="OpenStreetMap by default (free). For heavy traffic use a tile provider; the address needs {z}, {x} and {y}.">
          <input className="h-10 w-full rounded-lg border border-line px-3 font-mono text-sm" value={String(v.map_tiles)} onChange={(e) => set("map_tiles", e.target.value)} />
        </Field>
        <TextField label="Map credit line" value={String(v.map_attribution)} onChange={(e) => set("map_attribution", e.target.value)} />
      </section>

      <section className={card}>
        <div className="sm:col-span-2"><h2 className="text-lg font-semibold">Partner support and app</h2></div>
        <TextField label="Delivery team phone" value={String(v.support_phone)} onChange={(e) => set("support_phone", e.target.value)} hint="Shown in the partner app's Help" />
        <TextField label="Delivery team WhatsApp" value={String(v.support_whatsapp)} onChange={(e) => set("support_whatsapp", e.target.value)} />
        <Toggle k="require_vehicle_doc" v={v} set={set} label="Vehicle registration (RC) is required" hint="Otherwise it is optional during registration." />
        <Toggle k="return_pickups" v={v} set={set} label="Partners collect customers' returns" hint="For packages our partners delivered: an approved return is collected from the customer (with their pickup code) and brought to the seller." />
      </section>

      <section className={card} data-testid="partner-app-settings">
        <div className="sm:col-span-2">
          <h2 className="text-lg font-semibold">Partner Android app</h2>
          <p className="text-sm text-ink-soft">
            Partners download it from <a href="/delivery/download" target="_blank" rel="noreferrer" className="font-semibold text-peacock">/delivery/download</a> and
            from the partner app. Upload the APK here, or paste a link to it (a GitHub release or Google Play).
          </p>
        </div>
        <AppUpload onUploaded={(values) => setV({ ...v, ...values })} current={String(v.android_apk_url)} version={String(v.app_version)} />
        <TextField label="Android app download link" value={String(v.android_apk_url)} onChange={(e) => set("android_apk_url", e.target.value)} hint="Filled in when you upload. Or https:// link to the APK." />
        <TextField label="Google Play link" value={String(v.play_store_url)} onChange={(e) => set("play_store_url", e.target.value)} hint="When the app is on Google Play" />
        <TextField label="App version shown" value={String(v.app_version)} onChange={(e) => set("app_version", e.target.value)} placeholder="1.0.0" />
        <details className="rounded-xl bg-mist px-4 py-3 text-sm sm:col-span-2">
          <summary className="cursor-pointer font-semibold">How to build the app</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-ink-soft">
            <li>In your code repository on GitHub, open <b>Actions → Android partner app → Run workflow</b>.</li>
            <li>Enter your live website address (for example https://pixcart.in) and a version, like 1.0.0.</li>
            <li>When it finishes (about 10 minutes), download <b>pixcart-partner.apk</b> from the run or from <b>Releases</b>.</li>
            <li>Upload it above. Partners get the new version from the download page.</li>
          </ol>
          <p className="mt-2 text-ink-soft">For notifications in the app, add your Firebase <b>google-services.json</b> as the repository secret <code>GOOGLE_SERVICES_JSON</code> (base64). For a signed release, add the keystore secrets listed in <code>mobile/partner-app/README.md</code>.</p>
        </details>
      </section>

      <div className="sticky bottom-0 -mx-1 flex justify-end bg-gradient-to-t from-mist via-mist/90 to-transparent px-1 pb-2 pt-6">
        <Button type="submit" size="lg" loading={busy}>Save delivery settings</Button>
      </div>
    </form>
  );
}
