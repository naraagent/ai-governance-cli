/**
 * v3.0: Hybrid mode — profiles served by Generator Agent via backend,
 * with LOCAL FALLBACK reading from bundled profiles/ directory.
 *
 * Priority: Backend (AI-powered) → Local profiles (bundled) → Inline minimal fallback
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');

export interface ProfileFiles {
  agentsMd: string | null;
  steeringFiles: { relativePath: string; content: string }[];
  skillFiles: { relativePath: string; content: string }[];
  hookFiles: { relativePath: string; content: string }[];
}

/**
 * Resolves the path to the bundled profiles directory.
 * Looks in: ../../../profiles/ (relative to dist/utils/) or ../../profiles/ (relative to src/utils/)
 */
/**
 * Resolves the path to the bundled profiles directory.
 * Checks multiple candidates and returns the FIRST one that actually exists.
 * 
 * Paths checked (covers all runtime scenarios):
 * - npm installed: node_modules/@femsa/ai-governance/profiles/
 * - npm link (dev): packages/ai-governance-cli/profiles/
 * - monorepo root: ai-governance-templates/profiles/
 */
function resolveProfilesDir(): string {
  const candidates = [
    join(__dirname, '..', '..', 'profiles'),                   // npm installed: dist/utils/ → ../../profiles/
    join(__dirname, '..', 'profiles'),                          // from dist/ directly
    join(__dirname, '..', '..', '..', 'profiles'),             // from src/utils/ in dev
    join(__dirname, '..', '..', '..', '..', 'profiles'),       // monorepo: packages/cli/dist/utils → ../../../../profiles
    join(__dirname, '..', '..', '..', '..', '..', 'profiles'), // deeper nesting
  ];

  // Return first candidate that EXISTS on disk
  for (const candidate of candidates) {
    try {
      const s = statSync(candidate);
      if (s.isDirectory()) return candidate;
    } catch {
      // Not found, try next
    }
  }

  // Fallback: return first candidate (will fail gracefully in fetchProfileFiles)
  return candidates[0];
}

/**
 * Recursively reads all files in a directory and returns their relative paths and content.
 */
async function readDirRecursive(
  dirPath: string,
  baseDir: string,
): Promise<{ relativePath: string; content: string }[]> {
  const results: { relativePath: string; content: string }[] = [];

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const nested = await readDirRecursive(fullPath, baseDir);
        results.push(...nested);
      } else if (entry.isFile()) {
        const content = await readFile(fullPath, 'utf-8');
        const relPath = relative(baseDir, fullPath).replace(/\\/g, '/');
        results.push({ relativePath: relPath, content });
      }
    }
  } catch {
    // Directory doesn't exist — return empty
  }

  return results;
}

/**
 * Fetches profile files from the bundled profiles/ directory.
 * Returns a complete ProfileFiles object with AGENTS.md, steering, skills, and hooks.
 *
 * @param profileName - Name of the profile (e.g., 'eks-nodejs')
 * @param _country - Optional country overlay (reserved for future use)
 * @returns ProfileFiles or null if profile not found locally
 */
export async function fetchProfileFiles(
  profileName: string,
  _country?: string,
): Promise<ProfileFiles | null> {
  const profilesBase = resolveProfilesDir();

  // Try multiple candidate paths
  const candidates = [
    join(profilesBase, profileName),
    join(__dirname, '..', '..', 'profiles', profileName),
    join(__dirname, '..', '..', '..', 'profiles', profileName),
    join(__dirname, '..', '..', '..', '..', 'profiles', profileName),
    join(__dirname, '..', '..', '..', '..', '..', 'profiles', profileName),
  ];

  let profileDir: string | null = null;
  for (const candidate of candidates) {
    try {
      const s = await stat(candidate);
      if (s.isDirectory()) {
        profileDir = candidate;
        break;
      }
    } catch {
      continue;
    }
  }

  if (!profileDir) return null;

  const result: ProfileFiles = {
    agentsMd: null,
    steeringFiles: [],
    skillFiles: [],
    hookFiles: [],
  };

  // Read AGENTS.md
  try {
    result.agentsMd = await readFile(join(profileDir, 'AGENTS.md'), 'utf-8');
  } catch {
    // No AGENTS.md in this profile
  }

  // Read .kiro/steering/
  const steeringDir = join(profileDir, '.kiro', 'steering');
  const steeringEntries = await readDirRecursive(steeringDir, profileDir);
  result.steeringFiles = steeringEntries.map((e) => ({
    relativePath: `.kiro/steering/${e.relativePath.replace('.kiro/steering/', '')}`,
    content: e.content,
  }));

  // Read .kiro/skills/
  const skillsDir = join(profileDir, '.kiro', 'skills');
  const skillEntries = await readDirRecursive(skillsDir, profileDir);
  result.skillFiles = skillEntries.map((e) => ({
    relativePath: `.kiro/skills/${e.relativePath.replace('.kiro/skills/', '')}`,
    content: e.content,
  }));

  // Read .kiro/hooks/
  const hooksDir = join(profileDir, '.kiro', 'hooks');
  const hookEntries = await readDirRecursive(hooksDir, profileDir);
  result.hookFiles = hookEntries.map((e) => ({
    relativePath: `.kiro/hooks/${e.relativePath.replace('.kiro/hooks/', '')}`,
    content: e.content,
  }));

  return result;
}

/**
 * Returns all available profile names (static list for validation/autocomplete).
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
