/**
 * Typed-word confirmation for irreversible admin operations (Vol. 8 §8.3).
 *
 * The operator must type the exact word shown on screen before the confirm
 * button enables; the button is otherwise disabled — this is the one place in
 * the design system where a disabled primary control is correct, because the
 * action it guards cannot be undone (the server refuses a second decision with
 * NOT_PENDING, so there is no "undo" path back).
 *
 * The confirmation is deliberately not dismissible by backdrop click or
 * Escape-free: the operator can always cancel with the visible "Go back"
 * button, but nothing happens by accident. The server's answer — success or
 * refusal — is shown inside the dialog and never replaced by an optimistic
 * success.
 */
import { useEffect, useState } from 'react';
import { Button, Modal, TextField } from '../../design';

export interface TypedConfirmModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** One sentence describing the consequence, shown above the typed-word field. */
  consequence: string;
  /** The word the operator must type, exactly (case-sensitive). */
  confirmWord: string;
  /** Label of the confirm button, e.g. "Approve". */
  confirmLabel: string;
  /** Runs the write. Resolves on server success; rejects with the thrown problem. */
  onConfirm: () => Promise<void>;
  /** Server refusal message, surfaced verbatim inside the dialog (role="alert"). */
  error: string | null;
}

export function TypedConfirmModal({
  open,
  onClose,
  title,
  consequence,
  confirmWord,
  confirmLabel,
  onConfirm,
  error,
}: TypedConfirmModalProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  // Reset the typed word whenever the dialog is (re)opened — a stale match
  // from the previous case must never carry over.
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const matches = typed === confirmWord;

  const confirm = async () => {
    if (!matches || busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } catch {
      // The parent catches the problem itself and passes it back as `error`,
      // which renders above the typed-word field. Nothing is swallowed silently.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={title}
      description={consequence}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Go back
          </Button>
          {/* Disabled until the typed word matches — §8.3 typed-word confirmation. */}
          <Button variant="danger" loading={busy} disabled={!matches} onClick={confirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        className="px-form"
        onSubmit={(e) => {
          e.preventDefault();
          void confirm();
        }}
        noValidate
      >
        {error && (
          <div className="px-screenstate px-screenstate--error" role="alert">
            <p className="px-screenstate__msg">{error}</p>
          </div>
        )}
        <TextField
          label={`Type ${confirmWord} to confirm`}
          name="confirm-word"
          autoComplete="off"
          spellCheck={false}
          required
          value={typed}
          onValueChange={setTyped}
          hint={`This action cannot be undone. Type the word ${confirmWord} exactly to enable ${confirmLabel}.`}
        />
      </form>
    </Modal>
  );
}
