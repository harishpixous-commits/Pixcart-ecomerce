import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CheckCircle2, Info, Undo2, X, XCircle } from 'lucide-react';
import './Toast.css';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastOptions {
  tone?: ToastTone;
  /** §8.3: toast shows for 4 s. */
  durationMs?: number;
  /**
   * §8.3: "undo where reversible ≤ 10 s" — when supplied the toast lingers for
   * `undoWindowMs` instead of 4 s so the undo affordance stays reachable.
   */
  undo?: { label?: string; onUndo: () => void; undoWindowMs?: number };
}

interface ToastRecord extends Required<Pick<ToastOptions, 'tone'>> {
  id: number;
  message: string;
  durationMs: number;
  undo?: ToastOptions['undo'];
}

interface ToastApi {
  show: (message: string, options?: ToastOptions) => number;
  success: (message: string, options?: ToastOptions) => number;
  error: (message: string, options?: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

const DEFAULT_MS = 4000; /* §8.3: success toast 4 s */
const DEFAULT_UNDO_MS = 10000; /* §8.3: undo ≤ 10 s */
const MAX_VISIBLE = 3;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setToasts((list) => list.filter((x) => x.id !== id));
  }, []);

  const show = useCallback(
    (message: string, options: ToastOptions = {}) => {
      const tone = options.tone ?? 'info';
      const undo = options.undo;
      const id = nextId.current++;
      const durationMs =
        options.durationMs ?? (undo ? (undo.undoWindowMs ?? DEFAULT_UNDO_MS) : DEFAULT_MS);

      setToasts((list) => [...list, { id, message, tone, durationMs, undo }].slice(-MAX_VISIBLE));

      const handle = setTimeout(() => dismiss(id), durationMs);
      timers.current.set(id, handle);
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach(clearTimeout);
      map.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (m, o) => show(m, { ...o, tone: 'success' }),
      error: (m, o) => show(m, { ...o, tone: 'error' }),
      dismiss,
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* §8.4: announcements via aria-live=polite; errors via role=alert. */}
      <div className="px-toast-region" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: ToastRecord; onDismiss: () => void }) {
  const isError = toast.tone === 'error';
  const Icon = isError ? XCircle : toast.tone === 'success' ? CheckCircle2 : Info;

  return (
    <div
      className={`px-toast px-toast--${toast.tone}`}
      role={isError ? 'alert' : 'status'}
      data-testid="toast"
    >
      <span className="px-toast__icon" aria-hidden="true">
        <Icon size={18} strokeWidth={1.75} />
      </span>
      <span className="px-toast__msg">{toast.message}</span>

      {toast.undo && (
        <button
          type="button"
          className="px-toast__undo"
          onClick={() => {
            toast.undo?.onUndo();
            onDismiss();
          }}
        >
          <Undo2 size={16} aria-hidden="true" />
          {toast.undo.label ?? 'Undo'}
        </button>
      )}

      <button
        type="button"
        className="px-toast__close"
        onClick={onDismiss}
        aria-label="Dismiss notification"
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
