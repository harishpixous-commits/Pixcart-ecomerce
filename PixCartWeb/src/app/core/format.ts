const inr0 = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/*
 * The shopper's currency (Admin → Languages and currencies). The books are always in rupees; on shop pages amounts are
 * shown in the currency the shopper picked, at the admin's rate. The admin, seller and delivery panels always show
 * rupees (lib/regional.tsx decides, before the page renders).
 */
export type DisplayCurrency = { code: string; rate: number; digits: number };
const BASE: DisplayCurrency = { code: "INR", rate: 1, digits: 2 };
let display: DisplayCurrency = BASE;
const formats = new Map<string, Intl.NumberFormat>();

export function setDisplayCurrency(d: DisplayCurrency | null) {
  display = d && d.code !== "INR" && d.rate > 0 ? d : BASE;
}
export function displayCurrency(): DisplayCurrency {
  return display;
}

function foreign(paise: number, exact: boolean): string {
  const { code, rate, digits } = display;
  const value = (paise / 100) * rate;
  const key = `${code}:${digits}`;
  let f = formats.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat("en-US", { style: "currency", currency: code, currencyDisplay: "narrowSymbol", minimumFractionDigits: digits, maximumFractionDigits: digits });
    } catch {
      f = new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    }
    formats.set(key, f);
  }
  void exact;
  return f.format(value);
}

/** ₹1,23,456 — paise shown only when present. In the shopper's currency on shop pages. */
export function rupees(paise: number): string {
  if (display.code !== "INR") return foreign(paise, false);
  return paise % 100 === 0 ? inr0.format(paise / 100) : inr2.format(paise / 100);
}

/** Always two decimals; for invoices and settlement tables. In the shopper's currency on shop pages. */
export function rupeesExact(paise: number): string {
  if (display.code !== "INR") return foreign(paise, true);
  return inr2.format(paise / 100);
}

/** Always rupees, whatever the shopper picked: what is actually charged, cash on delivery, invoices. */
export function inRupees(paise: number): string {
  return paise % 100 === 0 ? inr0.format(paise / 100) : inr2.format(paise / 100);
}

/** An amount Razorpay charged, in its currency's smallest unit (cents, fils...). */
export function money(minor: number, code: string, digits = 2): string {
  if (code === "INR") return inRupees(minor);
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code, currencyDisplay: "narrowSymbol", minimumFractionDigits: digits, maximumFractionDigits: digits })
      .format(minor / 10 ** digits);
  } catch {
    return `${code} ${(minor / 10 ** digits).toFixed(digits)}`;
  }
}

/** An amount the shopper typed in their currency ("12.50"), as paise (rupees) for the server; null if not a number. */
export function shownToPaise(text: string): number | null {
  const clean = text.replace(/[^\d.]/g, "");
  if (!/^\d+(\.\d{1,3})?$/.test(clean)) return null;
  return Math.round((parseFloat(clean) / (display.code === "INR" ? 1 : display.rate)) * 100);
}

/** Paise as the shopper's currency for an input box ("12.5"), the reverse of shownToPaise. */
export function paiseToShown(paise: number): string {
  if (display.code === "INR") return paiseToInput(paise);
  const v = (paise / 100) * display.rate;
  return String(Number(v.toFixed(display.digits)));
}

/** The symbol of the shopper's currency, for labels like "Price (₹)". */
export function currencySymbol(): string {
  if (display.code === "INR") return "₹";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: display.code, currencyDisplay: "narrowSymbol" }).formatToParts(0)
      .find((p) => p.type === "currency")?.value ?? display.code;
  } catch {
    return display.code;
  }
}

export function toPaise(rupeesText: string): number | null {
  const clean = rupeesText.replace(/[,₹\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(parseFloat(clean) * 100);
}

export function paiseToInput(paise: number): string {
  return paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2);
}

export function pct(bps: number): string {
  const v = bps / 100;
  return `${Number.isInteger(v) ? v : v.toFixed(2)}%`;
}

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const dateTimeFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

export function date(iso: string | null | undefined): string {
  return iso ? dateFmt.format(new Date(iso)) : "";
}

export function dateTime(iso: string | null | undefined): string {
  return iso ? dateTimeFmt.format(new Date(iso)) : "";
}

/** A time as the value of an <input type="datetime-local"> (the browser's own time zone, not UTC). */
export function toLocalInput(when: string | Date | null | undefined): string {
  if (!when) return "";
  const d = typeof when === "string" ? new Date(when) : when;
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "3 hours", "2 days", "1 day 4 hours" for a length of time in milliseconds. */
export function duration(ms: number): string {
  const hours = Math.max(0, Math.round(ms / 3_600_000));
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  const h = (n: number) => `${n} hour${n === 1 ? "" : "s"}`;
  if (days === 0) return ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : h(hours);
  return `${days} day${days === 1 ? "" : "s"}${rest ? ` ${h(rest)}` : ""}`;
}

export const STATES: Record<string, string> = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
  "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
  "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
  "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
  "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa",
  "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman and Nicobar Islands",
  "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
};

export const STATE_OPTIONS = Object.entries(STATES).sort((a, b) => a[1].localeCompare(b[1]));

export const SUB_STATUS_LABEL: Record<string, string> = {
  pending_payment: "Awaiting payment",
  placed: "Order placed",
  confirmed: "Confirmed by seller",
  packed: "Packed",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  pending: "Payment pending",
  paid: "Paid",
  cod: "Pay on delivery",
  failed: "Payment not completed",
  refunded: "Refunded",
  partially_refunded: "Partly refunded",
};

export const GST_RATES = [0, 25, 300, 500, 1200, 1800, 2800, 4000];

/** Day names by the backend's weekday number (Python's date.weekday(): 0 = Monday). */
export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** "Under 1 hour", "5 hours", "2.5 days" — for averages measured in hours. */
export function hoursLabel(h: number | null | undefined): string {
  if (h === null || h === undefined) return "—";
  if (h < 1) return "Under 1 hour";
  if (h < 48) return `${Math.round(h)} hour${Math.round(h) === 1 ? "" : "s"}`;
  return `${(h / 24).toFixed(1)} days`;
}
