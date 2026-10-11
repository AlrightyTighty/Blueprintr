import type { EndpointInfo } from './list.js';

type Piece = { kind: 'literal'; value: string } | { kind: 'param'; name: string } | { kind: 'greedy'; name: string };

const SCORE = { literal: 3, param: 2, greedy: 1 } as const;

/** The request path as segments: query string and trailing slash dropped, duplicate slashes collapsed. */
export function requestSegments(rawPath: string): string[] {
  const path = rawPath.split(/[?#]/)[0] ?? '';
  return path.split('/').filter((segment) => segment !== '').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

export function normalizePath(rawPath: string): string {
  return `/${requestSegments(rawPath).join('/')}`;
}

function compile(path: string): Piece[] {
  return path
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment): Piece => {
      const greedy = /^\{(.+)\+\}$/.exec(segment);
      if (greedy) return { kind: 'greedy', name: greedy[1]! };
      const param = /^\{(.+)\}$/.exec(segment);
      if (param) return { kind: 'param', name: param[1]! };
      return { kind: 'literal', value: segment };
    });
}

export interface Match {
  endpoint: EndpointInfo;
  /** Values for `{id}`-style segments in the template. */
  params: Record<string, string>;
  /** Per-segment specificity (literal 3, parameter 2, greedy 1); higher wins, compared left to right. */
  specificity: number[];
}

function matchPath(endpoint: EndpointInfo, segments: string[]): Match | null {
  if (endpoint.isDefault) return { endpoint, params: {}, specificity: [] }; // catch-all: always matches, always last
  const pieces = compile(endpoint.path);
  const params: Record<string, string> = {};
  const specificity: number[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    if (piece.kind === 'greedy') {
      if (i !== pieces.length - 1 || segments.length <= i) return null; // `{proxy+}` needs at least one segment
      params[piece.name] = segments.slice(i).join('/');
      for (let j = i; j < segments.length; j++) specificity.push(SCORE.greedy);
      return { endpoint, params, specificity };
    }
    const segment = segments[i];
    if (segment === undefined) return null;
    if (piece.kind === 'literal') {
      if (piece.value !== segment) return null; // paths are case-sensitive, as in API Gateway
    } else params[piece.name] = segment;
    specificity.push(SCORE[piece.kind]);
  }
  return segments.length === pieces.length ? { endpoint, params, specificity } : null;
}

const methodMatches = (endpoint: EndpointInfo, method: string) => endpoint.method === 'ANY' || endpoint.method === method.toUpperCase();

/** Higher is more specific: real routes beat the catch-all, then path specificity, then an exact method over ANY. */
function compareMatches(a: Match, b: Match, method: string): number {
  if (!!a.endpoint.isDefault !== !!b.endpoint.isDefault) return a.endpoint.isDefault ? -1 : 1;
  for (let i = 0; i < Math.max(a.specificity.length, b.specificity.length); i++) {
    const difference = (a.specificity[i] ?? 0) - (b.specificity[i] ?? 0);
    if (difference !== 0) return difference;
  }
  const exact = (m: Match) => (m.endpoint.method === method.toUpperCase() ? 1 : 0);
  return exact(a) - exact(b);
}

export interface MatchResult {
  best: Match;
  /** Other endpoints that also match, most specific first. */
  alternates: Match[];
}

/**
 * Which endpoint handles `METHOD path`? Mirrors API Gateway: the most specific route wins (literal over
 * parameter over greedy over `$default`; an exact method over ANY). Equally specific matches, for example the
 * same route on two APIs, are returned as alternates so the caller can say so.
 */
export function matchRequest(endpoints: EndpointInfo[], method: string, rawPath: string): MatchResult | null {
  const segments = requestSegments(rawPath);
  const matches = endpoints
    .filter((endpoint) => methodMatches(endpoint, method))
    .flatMap((endpoint) => {
      const match = matchPath(endpoint, segments);
      return match ? [match] : [];
    })
    .sort((a, b) => compareMatches(b, a, method) || a.endpoint.address.localeCompare(b.endpoint.address));
  const [best, ...alternates] = matches;
  return best ? { best, alternates } : null;
}

/** Endpoints worth suggesting when nothing matched: same first path segment, then same method, then anything. */
export function closestEndpoints(endpoints: EndpointInfo[], method: string, rawPath: string, limit = 5): EndpointInfo[] {
  const first = requestSegments(rawPath)[0];
  const score = (e: EndpointInfo) => (first && compile(e.path)[0]?.kind === 'literal' && (compile(e.path)[0] as { value: string }).value === first ? 2 : 0) + (e.method === method.toUpperCase() ? 1 : 0);
  return [...endpoints].sort((a, b) => score(b) - score(a)).slice(0, limit);
}
