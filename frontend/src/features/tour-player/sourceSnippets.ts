import type { CodeRef } from '../../core/journeys/types';
import { isDemoProject } from '../../config';
import { demoSourceFiles } from '../../demo/demoData';

const CONTEXT_LINES = 3;

/**
 * The last line of the Terraform block starting at `startLine`, found by matching braces, for when the
 * analysis only reported where a block begins. Returns null when the source isn't on hand.
 */
export function findBlockEndLine(projectId: string, file: string, startLine: number): number | null {
  if (!isDemoProject(projectId)) return null;
  const text = demoSourceFiles[file];
  if (!text) return null;

  const lines = text.split('\n');
  let depth = 0;
  for (let index = startLine - 1; index < lines.length; index += 1) {
    for (const character of lines[index]) {
      if (character === '{') depth += 1;
      if (character === '}') depth -= 1;
    }
    if (depth <= 0 && index >= startLine - 1 && lines[index].includes('}')) return index + 1;
  }
  return null;
}

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
  const file = demoSourceFiles[reference.file];
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
