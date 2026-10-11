import type { CodeRef } from '../../core/journeys/types';
import { isDemoProject } from '../../config';
import { mockSourceFiles } from '../../core/graph/mockGraph';

const CONTEXT_LINES = 3;

export interface SourceLine {
  number: number;
  text: string;
  isHighlighted: boolean;
}

/**
 * The lines to show for a reference, with a few lines of context around it. Only the demo project has
 * source on hand; the backend never stores code, so real projects link out to GitHub instead.
 */
export function getSourceLines(projectId: string, reference: CodeRef): SourceLine[] | null {
  if (!isDemoProject(projectId)) return null;
  const file = mockSourceFiles[reference.file];
  if (!file) return null;

  const lines = file.split('\n');
  const first = Math.max(1, reference.startLine - CONTEXT_LINES);
  const last = Math.min(lines.length, reference.endLine + CONTEXT_LINES);
  const visible: SourceLine[] = [];
  for (let number = first; number <= last; number += 1) {
    visible.push({
      number,
      text: lines[number - 1],
      isHighlighted: number >= reference.startLine && number <= reference.endLine,
    });
  }
  return visible;
}

/** A GitHub link to the lines, or null when the project's repository isn't known. */
export function getSourceUrl(sourceBaseUrl: string | undefined, reference: CodeRef): string | null {
  if (!sourceBaseUrl) return null;
  const anchor =
    reference.startLine === reference.endLine ? `#L${reference.startLine}` : `#L${reference.startLine}-L${reference.endLine}`;
  return `${sourceBaseUrl.replace(/\/$/, '')}/${reference.file.replace(/^\//, '')}${anchor}`;
}
