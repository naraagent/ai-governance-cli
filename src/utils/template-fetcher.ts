import path from 'node:path';
import fs from 'fs-extra';
import { glob } from 'glob';

const PROFILES_BASE_DIR = path.resolve(
  import.meta.dirname ?? __dirname,
  '../../../../profiles'
);

export interface ProfileFiles {
  agentsMd: string | null;
  steeringFiles: { relativePath: string; content: string }[];
  skillFiles: { relativePath: string; content: string }[];
  hookFiles: { relativePath: string; content: string }[];
}

/**
 * Fetches all template files for a given profile from the local profiles directory.
 * Falls back gracefully if files are missing.
 */
export async function fetchProfileFiles(profileName: string): Promise<ProfileFiles | null> {
  const profileDir = path.join(PROFILES_BASE_DIR, profileName);

  if (!(await fs.pathExists(profileDir))) {
    return null;
  }

  const result: ProfileFiles = {
    agentsMd: null,
    steeringFiles: [],
    skillFiles: [],
    hookFiles: [],
  };

  // Read AGENTS.md
  const agentsPath = path.join(profileDir, 'AGENTS.md');
  if (await fs.pathExists(agentsPath)) {
    result.agentsMd = await fs.readFile(agentsPath, 'utf-8');
  }

  // Read steering files
  const steeringDir = path.join(profileDir, '.kiro', 'steering');
  if (await fs.pathExists(steeringDir)) {
    const files = await glob('*.md', { cwd: steeringDir });
    for (const file of files) {
      const content = await fs.readFile(path.join(steeringDir, file), 'utf-8');
      result.steeringFiles.push({ relativePath: `.kiro/steering/${file}`, content });
    }
  }

  // Read skill files
  const skillsDir = path.join(profileDir, '.kiro', 'skills');
  if (await fs.pathExists(skillsDir)) {
    const files = await glob('*.md', { cwd: skillsDir });
    for (const file of files) {
      const content = await fs.readFile(path.join(skillsDir, file), 'utf-8');
      result.skillFiles.push({ relativePath: `.kiro/skills/${file}`, content });
    }
  }

  // Read hook files
  const hooksDir = path.join(profileDir, '.kiro', 'hooks');
  if (await fs.pathExists(hooksDir)) {
    const files = await glob('*.json', { cwd: hooksDir });
    for (const file of files) {
      const content = await fs.readFile(path.join(hooksDir, file), 'utf-8');
      result.hookFiles.push({ relativePath: `.kiro/hooks/${file}`, content });
    }
  }

  return result;
}

/**
 * Returns list of available profile names from the profiles directory.
 */
export async function getAvailableProfiles(): Promise<string[]> {
  if (!(await fs.pathExists(PROFILES_BASE_DIR))) {
    return [];
  }
  const entries = await fs.readdir(PROFILES_BASE_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}
