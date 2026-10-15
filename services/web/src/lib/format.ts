/**
 * Presentation formatting.
 *
 * §8.3: "Number/date localisation via Intl; currency always ₹ with Indian digit
 * grouping." Money is never a float anywhere in this codebase — amounts arrive as
 * integer paise (CLAUDE.md §6) and are divided exactly once, here, for display.
 */

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const inrWhole = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const numIn = new Intl.NumberFormat('en-IN');

/** ₹ with Indian digit grouping, e.g. 12345678 → ₹1,23,456.78. */
export function money(paise: number): string {
  return inr.format(paise / 100);
}

/** Drop trailing .00 on round rupees for compact KPI tiles. */
export function moneyCompact(paise: number): string {
  return paise % 100 === 0 ? inrWhole.format(paise / 100) : inr.format(paise / 100);
}

export function number(value: number): string {
  return numIn.format(value);
}

export function percentFromBps(bps: number): string {
  return `${(bps / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%`;
}

export function dateLong(value: string | number | Date): string {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(new Date(value));
}

export function dateTime(value: string | number | Date): string {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

export function relativeTime(value: string | number | Date, now = Date.now()): string {
  const diff = new Date(value).getTime() - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('en-IN', { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000000],
    ['month', 2592000000],
    ['day', 86400000],
    ['hour', 3600000],
    ['minute', 60000],
    ['second', 1000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === 'second') return rtf.format(Math.round(diff / ms), unit);
  }
  return rtf.format(0, 'second');
}

/** Badge cap: §8.3 "badges cap at 99+". */
export function badgeCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}
