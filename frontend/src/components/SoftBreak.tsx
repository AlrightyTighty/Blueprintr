import { Fragment } from 'react';

/** Pieces of text that each end at a place where a long path or address may wrap: after / . _ : or -. */
const PIECE = /[^/._:-]+[/._:-]?|[/._:-]/g;

/**
 * Text that wraps at natural points (`src/api/` then `app.js`) instead of mid-word. A line only breaks
 * at these points when it has to, so short text looks unchanged. Pair with `wrap-anywhere` on
 * the container for the rare token with no break point at all.
 */
export default function SoftBreak({ text }: { text: string }) {
  const pieces = text.match(PIECE) ?? [text];
  return (
    <>
      {pieces.map((piece, index) => (
        <Fragment key={index}>
          {piece}
          {index < pieces.length - 1 && <wbr />}
        </Fragment>
      ))}
    </>
  );
}
