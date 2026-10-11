// The demo project runs the whole workspace on bundled data with no backend or login, so the app
// can always be shown (Wi-Fi down, API quota gone).
export const DEMO_PROJECT_ID = 'demo';

export function isDemoProject(projectId: string): boolean {
  return projectId === DEMO_PROJECT_ID;
}
