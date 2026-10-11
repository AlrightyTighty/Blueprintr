import { useState, type ReactNode } from 'react';
import { ApiError } from '../api';
import Modal from './Modal';
import { primaryButtonClass, secondaryButtonClass } from './ui';

interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** Styles the confirm button as destructive. */
  danger?: boolean;
  /** Runs when confirmed. Throw to keep the dialog open and show the error. */
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

const dangerButtonClass =
  'rounded bg-rose-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-500 disabled:opacity-50';

/** Asks before doing something that can't easily be undone, and shows why if it fails. */
export default function ConfirmDialog({ title, children, confirmLabel, danger = false, onConfirm, onCancel }: ConfirmDialogProps) {
  const [isWorking, setIsWorking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleConfirm() {
    setIsWorking(true);
    setErrorMessage(null);
    try {
      await onConfirm();
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.friendlyMessage : error instanceof Error ? error.message : 'Something went wrong.');
      setIsWorking(false);
    }
  }

  return (
    <Modal title={title} onClose={isWorking ? () => undefined : onCancel}>
      <div className="text-sm text-slate-300">{children}</div>
      {errorMessage && <p className="mt-3 text-sm text-rose-300">{errorMessage}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={secondaryButtonClass} onClick={onCancel} disabled={isWorking}>
          Cancel
        </button>
        <button type="button" className={danger ? dangerButtonClass : primaryButtonClass} onClick={handleConfirm} disabled={isWorking}>
          {isWorking ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
