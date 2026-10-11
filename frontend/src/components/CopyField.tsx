import { useRef, useState } from 'react';
import { inputClass, secondaryButtonClass } from './ui';

/** A read-only link with a Copy button. Clicking the field selects it, in case copying is blocked. */
export default function CopyField({ value, label }: { value: string; label: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      // Clipboard access can be refused; select the text so Ctrl+C works.
      inputRef.current?.select();
      setState('failed');
    }
    setTimeout(() => setState('idle'), 2000);
  }

  return (
    <div className="flex gap-2">
      <input
        ref={inputRef}
        readOnly
        aria-label={label}
        className={`${inputClass} min-w-0 flex-1 font-mono text-xs`}
        value={value}
        onFocus={(event) => event.currentTarget.select()}
      />
      <button type="button" className={`${secondaryButtonClass} shrink-0`} onClick={handleCopy}>
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Press Ctrl+C' : 'Copy'}
      </button>
    </div>
  );
}
