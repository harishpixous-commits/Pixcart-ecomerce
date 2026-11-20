"use client";

/*
 * Slide to pay, as in food-delivery and quick-commerce apps: drag the knob to the end of the track to confirm, so a
 * stray tap while scrolling can never place an order. Let go before 85% of the way and the knob springs back.
 *
 * Keyboard and screen-reader users get an ordinary button (role="button", focusable, named by aria-label): Enter or
 * Space confirms, and so does the click a screen reader sends when it activates the control. A click that comes from
 * a mouse, finger or pen is ignored; only the slide counts for those.
 */

import clsx from "clsx";
import { ChevronsRight, Loader2 } from "lucide-react";
import { useRef, useState } from "react";

const THRESHOLD = 0.85;
const INSET = 4; // px between the track and the knob (left-1 / top-1)

type Drag = { id: number; startX: number; x: number; max: number };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function SlideToPay({
  label,
  ariaLabel,
  onConfirm,
  disabled = false,
  loading = false,
  loadingLabel = "Processing…",
  tone = "buy",
  className,
}: {
  /** Shown on the track, e.g. "Slide to pay | ₹1,234". */
  label: React.ReactNode;
  /** The control's accessible name, e.g. "Slide to pay ₹1,234". */
  ariaLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  tone?: "buy" | "primary";
  className?: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLSpanElement>(null);
  const pressed = useRef(false); // a mouse, finger or pen went down on the control since its last click
  const [drag, setDrag] = useState<Drag | null>(null);
  // Where the knob rests (at the end of the track) while the order is being placed.
  const [endX, setEndX] = useState(0);

  const blocked = disabled || loading;
  const x = drag ? drag.x : loading ? endX : 0;
  const max = drag ? drag.max : endX;
  const progress = loading ? 1 : max > 0 ? Math.min(1, x / max) : 0;

  /** How far the knob can travel, measured when a slide starts (the bar can change width with the screen). */
  function travel(): number {
    const track = trackRef.current;
    const knob = knobRef.current;
    return track && knob ? Math.max(0, track.clientWidth - knob.offsetWidth - INSET * 2) : 0;
  }

  function confirm(at: number) {
    setEndX(at);
    onConfirm();
  }

  function onPointerDown(e: React.PointerEvent<HTMLSpanElement>) {
    if (blocked || drag || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault(); // no text selection or image drag while sliding
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id: e.pointerId, startX: e.clientX, x: 0, max: travel() });
  }

  function onPointerMove(e: React.PointerEvent<HTMLSpanElement>) {
    if (!drag || e.pointerId !== drag.id) return;
    setDrag({ ...drag, x: clamp(e.clientX - drag.startX, 0, drag.max) });
  }

  function onPointerUp(e: React.PointerEvent<HTMLSpanElement>) {
    if (!drag || e.pointerId !== drag.id) return;
    const at = clamp(e.clientX - drag.startX, 0, drag.max);
    setDrag(null); // springs back unless the parent starts loading
    if (drag.max > 0 && at >= drag.max * THRESHOLD) {
      navigator.vibrate?.(20);
      confirm(drag.max);
    }
  }

  function onPointerCancel(e: React.PointerEvent<HTMLSpanElement>) {
    if (drag && e.pointerId === drag.id) setDrag(null);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault(); // Space would scroll the page
    if (blocked || e.repeat) return;
    confirm(travel());
  }

  function onClick(e: React.MouseEvent<HTMLDivElement>) {
    // A click from a pointing device follows its pointerdown (and, where clicks are pointer events, names its type).
    // A screen reader's "activate" has neither, so only that kind of click confirms.
    const pointerType = (e.nativeEvent as MouseEvent & { pointerType?: string }).pointerType ?? "";
    const fromPointer = pressed.current || pointerType !== "";
    pressed.current = false;
    if (fromPointer || blocked) return;
    confirm(travel());
  }

  const buy = tone === "buy";
  return (
    <div
      ref={trackRef}
      role="button"
      tabIndex={0}
      aria-label={loading ? loadingLabel : ariaLabel}
      aria-disabled={blocked || undefined}
      aria-busy={loading || undefined}
      onKeyDown={onKeyDown}
      onClick={onClick}
      onPointerDown={() => {
        pressed.current = true;
      }}
      data-testid="slide-to-pay"
      className={clsx(
        "relative h-14 w-full select-none overflow-hidden rounded-full text-white outline-none [-webkit-tap-highlight-color:transparent]",
        "shadow-[inset_0_-2px_0_rgba(0,0,0,0.12)] focus-visible:ring-2 focus-visible:ring-offset-2",
        buy ? "bg-vermilion focus-visible:ring-vermilion" : "bg-peacock focus-visible:ring-peacock",
        disabled && !loading && "cursor-not-allowed opacity-55",
        className,
      )}
    >
      {/* the trail the knob leaves behind */}
      <span
        aria-hidden
        className={clsx(
          "absolute inset-y-0 left-0 rounded-full",
          buy ? "bg-vermilion-dark" : "bg-peacock-dark",
          !drag && "motion-safe:transition-[width] motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]",
        )}
        style={{ width: x + INSET * 2 + 48 }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center justify-center pl-16 pr-5 text-[15px] font-semibold tracking-wide"
        style={{ opacity: loading ? 1 : Math.max(0, 1 - progress * 1.6) }}
      >
        {loading ? (
          <span className="truncate">{loadingLabel}</span>
        ) : (
          <span
            className={clsx(
              "truncate",
              !blocked &&
                "bg-[linear-gradient(100deg,rgba(255,255,255,0.72)_40%,#fff_50%,rgba(255,255,255,0.72)_60%)] bg-[length:250%_100%] bg-clip-text text-transparent motion-safe:animate-[skeleton-shimmer_2.6s_linear_infinite] motion-reduce:bg-none motion-reduce:text-white",
            )}
          >
            {label}
          </span>
        )}
      </span>
      <span
        ref={knobRef}
        aria-hidden
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        className={clsx(
          "absolute left-1 top-1 flex h-12 w-12 touch-pan-y items-center justify-center rounded-full bg-white shadow-md",
          buy ? "text-vermilion" : "text-peacock",
          blocked ? "cursor-not-allowed" : drag ? "cursor-grabbing" : "cursor-grab",
          !drag && "motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]",
        )}
        style={{ transform: `translateX(${x}px)` }}
      >
        {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <ChevronsRight className="h-6 w-6" strokeWidth={2.5} />}
      </span>
    </div>
  );
}
