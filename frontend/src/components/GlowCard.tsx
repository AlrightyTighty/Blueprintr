import type { CSSProperties, PointerEvent, ReactNode } from 'react';

/** Colours for the light, as "r g b" so CSS can set its opacity. */
export const GLOW = {
  violet: '139 92 246',
  indigo: '129 140 248',
  blue: '147 197 253',
  rose: '253 164 175',
  amber: '252 211 77',
} as const;

interface GlowCardProps {
  children: ReactNode;
  /** The light's colour; see `GLOW`. */
  glow?: string;
  className?: string;
  as?: 'div' | 'li';
}

/**
 * A card that lights up when the mouse is over it: the border and a soft glow come up, the card lifts a
 * little, and a pool of light follows the pointer. The look lives in `.glow-card` (index.css); this only
 * tells the CSS where the pointer is, without re-rendering anything.
 */
export default function GlowCard({ children, glow = GLOW.violet, className = '', as: Tag = 'div' }: GlowCardProps) {
  function handlePointerMove(event: PointerEvent<HTMLElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty('--mx', `${event.clientX - rect.left}px`);
    event.currentTarget.style.setProperty('--my', `${event.clientY - rect.top}px`);
  }

  return (
    <Tag
      className={`glow-card rounded-lg border border-indigo-900 bg-indigo-950/40 p-5 ${className}`}
      style={{ '--glow': glow } as CSSProperties}
      onPointerMove={handlePointerMove}
    >
      {children}
    </Tag>
  );
}
