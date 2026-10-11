// The tour contract from claude.md ("Graph and tour types"). Keep this file free of React.

export interface CodeRef {
  file: string;
  startLine: number;
  endLine: number;
}

export interface Stop {
  nodeId: string;
  script: string;
  codeRefs: CodeRef[];
  warnings: string[];
  /** True when the hop into this stop is inferred rather than proven; the guide says so. */
  inferred: boolean;
}

export type JourneyKind = 'first_day' | 'request' | 'disaster' | 'change' | 'endpoint';

export interface Journey {
  id: string;
  title: string;
  kind: JourneyKind;
  stops: Stop[];
}
