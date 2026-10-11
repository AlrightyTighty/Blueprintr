/**
 * A quick read of a pasted link, only to show "this looks like acme/orders" while the user types. The
 * server checks the link properly (and is the one that accepts or refuses it).
 */
export function previewGithubRepo(text: string): string | null {
  const trimmed = text.trim();
  const match =
    trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:[/?#].*)?$/i) ??
    trimmed.match(/^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i) ??
    trimmed.match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}
