import { useCallback, useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { createPortal } from 'react-dom';
import './Modal.css';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Blocks backdrop/Escape dismissal — use only for irreversible confirmations. */
  dismissible?: boolean;
  /** Typed-word confirmation is reserved for irreversible admin ops (§8.3). */
  confirmWord?: string;
  onConfirmWordChange?: (value: string) => void;
}

/**
 * §8.4: focus is trapped in modals and returned to the invoker on close.
 * §8.1: an e3 elevation — max one at a time, which is enforced by the single portal
 * host below (opening a second modal replaces the first rather than stacking).
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissible = true,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Tab' && panelRef.current) {
        const nodes = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
          (n) => n.offsetParent !== null || n === document.activeElement,
        );
        if (nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();

    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissible) onClose();
    };
    document.addEventListener('keydown', onEscape);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onEscape);
      document.body.style.overflow = prevOverflow;
      /* §8.4: focus returned on close. */
      returnFocusRef.current?.focus?.();
    };
  }, [open, onClose, dismissible]);

  if (!open) return null;

  return createPortal(
    <div className="px-modal-root">
      <div
        className="px-modal__backdrop"
        onClick={dismissible ? onClose : undefined}
        aria-hidden="true"
      />
      <div
        className={`px-modal px-modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        ref={panelRef}
        onKeyDown={handleKeyDown}
      >
        <header className="px-modal__head">
          <h2 className="px-modal__title" id={titleId}>
            {title}
          </h2>
          <button
            type="button"
            className="px-modal__close"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="px-modal__body">
          {description && (
            <p className="px-modal__desc" id={descId}>
              {description}
            </p>
          )}
          {children}
        </div>
        {footer && <footer className="px-modal__foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
