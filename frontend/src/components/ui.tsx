"use client";

import clsx from "clsx";
import { Loader2, Star, X } from "lucide-react";
import Link from "next/link";
import { cloneElement, createContext, forwardRef, isValidElement, useCallback, useContext, useEffect, useId, useState } from "react";
import { rupees } from "@/lib/format";

/* ---------------------------------------------------------------- buttons */

type Variant = "primary" | "cart" | "buy" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-peacock text-white hover:bg-peacock-dark",
  cart: "bg-marigold text-ink hover:bg-marigold-dark",
  buy: "bg-vermilion text-white hover:bg-vermilion-dark",
  secondary: "bg-white text-peacock ring-1 ring-inset ring-peacock/40 hover:bg-peacock-light",
  ghost: "text-peacock hover:bg-peacock-light",
  danger: "bg-white text-vermilion ring-1 ring-inset ring-vermilion/40 hover:bg-vermilion-light",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={clsx(
        "inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-55",
        size === "sm" && "h-8 px-3 text-sm",
        size === "md" && "h-10 px-4 text-[15px]",
        size === "lg" && "h-12 px-6 text-base",
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

export function ButtonLink({ href, variant = "primary", className, children }: { href: string; variant?: Variant; className?: string; children: React.ReactNode }) {
  return (
    <Link href={href} className={clsx("inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-[15px] font-semibold transition-colors", VARIANTS[variant], className)}>
      {children}
    </Link>
  );
}

/* ---------------------------------------------------------------- form fields */

export function Field({ label, hint, error, children, htmlFor, className }: { label: string; hint?: string; error?: string; children: React.ReactNode; htmlFor?: string; className?: string }) {
  // Link the label to a single control even when the caller gave no id, so screen readers announce it.
  const autoId = useId();
  let control = children;
  let target = htmlFor;
  if (!target && isValidElement<{ id?: string }>(children)) {
    target = children.props.id ?? autoId;
    if (!children.props.id) control = cloneElement(children, { id: target });
  }
  return (
    <div className={clsx("flex flex-col gap-1", className)}>
      <label htmlFor={target} className="text-sm font-medium text-ink">
        {label}
      </label>
      {control}
      {error ? <p className="text-sm text-vermilion">{error}</p> : hint ? <p className="text-xs text-ink-faint">{hint}</p> : null}
    </div>
  );
}

const inputCls =
  "h-10 w-full rounded-lg border border-line bg-white px-3 text-[15px] text-ink placeholder:text-ink-faint focus:border-peacock focus:outline-none focus:ring-2 focus:ring-peacock/20 disabled:bg-mist";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input(
  { className, invalid, ...rest },
  ref,
) {
  return <input ref={ref} className={clsx(inputCls, invalid && "border-vermilion", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={clsx(inputCls, "h-auto min-h-[96px] py-2", className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={clsx(inputCls, "pr-8", className)} {...rest}>
      {children}
    </select>
  );
});

/** Labelled input that wires id/label automatically. */
export function TextField({
  label,
  hint,
  error,
  className,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id} className={className}>
      <Input id={id} invalid={!!error} aria-invalid={!!error} {...rest} />
    </Field>
  );
}

/* ---------------------------------------------------------------- display */

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx("animate-spin text-peacock", className ?? "h-6 w-6")} aria-label="Loading" />;
}

export function PageLoader() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <Spinner className="h-8 w-8" />
    </div>
  );
}

export function Price({ price, mrp, discount, size = "md" }: { price: number; mrp?: number; discount?: number; size?: "sm" | "md" | "lg" }) {
  const off = discount ?? (mrp && mrp > price ? Math.floor(((mrp - price) * 100) / mrp) : 0);
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <span className={clsx("font-display font-bold text-ink", size === "sm" && "text-base", size === "md" && "text-lg", size === "lg" && "text-3xl")}>{rupees(price)}</span>
      {mrp && mrp > price ? <span className={clsx("text-ink-faint line-through", size === "lg" ? "text-base" : "text-sm")}>{rupees(mrp)}</span> : null}
      {off > 0 ? <span className={clsx("font-semibold text-leaf", size === "lg" ? "text-base" : "text-sm")}>{off}% off</span> : null}
    </div>
  );
}

export function Rating({ value, count, size = "sm" }: { value: number; count?: number; size?: "sm" | "md" }) {
  if (!count) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={clsx("inline-flex items-center gap-0.5 rounded bg-leaf font-semibold text-white", size === "sm" ? "px-1.5 text-xs leading-5" : "px-2 text-sm leading-6")}>
        {value.toFixed(1)}
        <Star className="h-3 w-3 fill-current" aria-hidden />
      </span>
      <span className="text-xs text-ink-faint">({count.toLocaleString("en-IN")})</span>
    </span>
  );
}

const PILL_TONE: Record<string, string> = {
  green: "bg-leaf-light text-leaf",
  amber: "bg-marigold-light text-[#8A5A00]",
  red: "bg-vermilion-light text-vermilion",
  blue: "bg-peacock-light text-peacock",
  gray: "bg-mist text-ink-soft",
};

export function Pill({ tone = "gray", children }: { tone?: keyof typeof PILL_TONE; children: React.ReactNode }) {
  return <span className={clsx("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold", PILL_TONE[tone])}>{children}</span>;
}

const STATUS_TONE: Record<string, keyof typeof PILL_TONE> = {
  approved: "green", delivered: "green", paid: "green", processed: "green", active: "green",
  pending: "amber", submitted: "amber", placed: "amber", confirmed: "blue", packed: "blue", shipped: "blue", pending_payment: "amber", cod: "blue",
  rejected: "red", cancelled: "red", suspended: "red", failed: "red", refunded: "gray", partially_refunded: "gray",
  draft: "gray", archived: "gray",
};

export function StatusPill({ status, label }: { status: string; label?: string }) {
  return <Pill tone={STATUS_TONE[status] ?? "gray"}>{label ?? status.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())}</Pill>;
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line bg-white px-6 py-12 text-center">
      <p className="font-display text-xl font-semibold text-ink">{title}</p>
      {body && <p className="max-w-md text-ink-soft">{body}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorNote({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg bg-vermilion-light px-3 py-2 text-sm text-vermilion">
      {message}
    </p>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <nav className="flex items-center justify-center gap-2 py-4" aria-label="Pages">
      <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </Button>
      <span className="text-sm text-ink-soft">
        Page {page} of {pages}
      </span>
      <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </Button>
    </nav>
  );
}

/* ---------------------------------------------------------------- modal */

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/50 p-0 sm:items-center sm:p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={clsx("max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 sm:rounded-2xl", wide ? "sm:max-w-2xl" : "sm:max-w-md")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="font-display text-xl font-semibold text-ink">{title}</h2>
          <button onClick={onClose} className="rounded-full p-1 text-ink-soft hover:bg-mist" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- toast */

type Toast = { id: number; text: string; tone: "ok" | "error" };
const ToastCtx = createContext<(text: string, tone?: "ok" | "error") => void>(() => {});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: "ok" | "error" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={clsx("pointer-events-auto rounded-lg px-4 py-2.5 text-[15px] font-medium shadow-lg", t.tone === "ok" ? "bg-ink text-white" : "bg-vermilion text-white")}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

/* ---------------------------------------------------------------- product image */

export function ProductImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  if (!src) return <div className={clsx("flex items-center justify-center bg-mist text-sm text-ink-faint", className)}>No image</div>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} loading="lazy" className={clsx("object-contain", className)} />;
}
