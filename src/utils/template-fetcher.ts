// v2.0: Profiles are served by Generator Agent via backend, not bundled locally.
// The CLI no longer ships embedded profiles. It relies on:
//   1. POST /governance/generate (backend → Generator Agent produces files)
//   2. Inline minimal fallback templates (hardcoded in steering-foundations.ts)

export interface ProfileFiles {
  agentsMd: string | null;
  steeringFiles: { relativePath: string; content: string }[];
  skillFiles: { relativePath: string; content: string }[];
  hookFiles: { relativePath: string; content: string }[];
}

/**
 * Previously fetched profile files from a local profiles/ directory bundled with the CLI.
 * Now returns null — the CLI should use the backend (Generator Agent) or inline fallback.
 *
 * @deprecated v2.0 — profiles are no longer bundled. Use backend or inline fallback.
 */
export async function fetchProfileFiles(
  _profileName: string,
  _country?: string
): Promise<ProfileFiles | null> {
  // v2.0: Profiles are served by Generator Agent via backend, not bundled locally
  return null;
}

/**
 * Previously returned available profile names from the local profiles/ directory.
 * Now returns the known profile list as static strings (for validation/autocomplete only).
 */
export async function getAvailableProfiles(): Promise<string[]> {
  return [
    'android-kotlin',
    'eks-nodejs',
    'frontend-react',
    'generic',
    'helm-infra',
    'ios-swift',
    'lambda-nodejs',
    'lambda-python',
    'service-ecs-hub',
    'terraform-module',
  ];
}
