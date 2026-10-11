// The demo project's data: the backend's real analysis of its own demo repo, saved by
// `npm run snapshot:demo`. Used by /demo so it works with no backend, login or network.
import type { Finding, Graph } from '../core/graph/types';
import snapshot from './demoSnapshot.json';

export const demoGraph = snapshot.graph as unknown as Graph;
export const demoFindings = snapshot.findings as unknown as Finding[];
/** The demo repo's files by path, so a tour stop can show real lines next to the Terraform that runs them. */
export const demoSourceFiles: Record<string, string> = snapshot.sourceFiles;
