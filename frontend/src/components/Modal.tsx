import { useEffect, useId, type ReactNode } from 'react';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Wider panel for dialogs with lists, such as sharing. */
  wide?: boolean;
}

/** A centered dialog over a dimmed page. Esc or a click outside closes it. */
export default function Modal({ title, onClose, children, wide = false }: ModalProps) {
  const titleId = useId();

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`flex max-h-[90vh] w-full flex-col rounded-lg border border-indigo-900 bg-slate-950 text-slate-100 shadow-2xl ${
          wide ? 'max-w-2xl' : 'max-w-md'
        }`}
      >
        <div className="flex items-center justify-between border-b border-indigo-900 px-5 py-3">
          <h2 id={titleId} className="text-lg font-semibold text-indigo-100">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            className="rounded px-2 py-1 text-slate-400 hover:bg-indigo-950 hover:text-slate-100"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
