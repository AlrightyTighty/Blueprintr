// Shared Tailwind class strings so every page uses the same blue/purple look.
export const inputClass =
  'w-full rounded border border-indigo-900 bg-indigo-950 px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:border-violet-500 focus:outline-none';

export const primaryButtonClass =
  'rounded bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50';

export const secondaryButtonClass =
  'rounded bg-indigo-950 px-4 py-2 text-sm text-indigo-200 transition-colors hover:bg-indigo-900 disabled:opacity-50';

export const labelClass = 'mb-1 block text-sm text-indigo-200';

export function formatDateTime(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
