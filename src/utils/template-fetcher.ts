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
 * If a country is provided, merges country overlay files on top of the base profile.
 *
 * Merge strategy:
 * - Overlay files with the same relative path override base files
 * - Overlay files with new paths are added
 * - AGENTS.md: country content is appended after base content (not replaced)
 * - If country overlay dir doesn't exist: falls back to base, logs warning
 * - Overlay files are validated with the same rules as base files
 */
export async function fetchProfileFiles(
  profileName: string,
  country?: string
): Promise<ProfileFiles | null> {
  const profileDir = path.join(PROFILES_BASE_DIR, profileName);

  if (!(await fs.pathExists(profileDir))) {
    return null;
  }

  // Load base profile
  const result: ProfileFiles = {
    agentsMd: null,
    steeringFiles: [],
    skillFiles: [],
    hookFiles: [],
  };

  // Read base AGENTS.md
  const agentsPath = path.join(profileDir, 'AGENTS.md');
  if (await fs.pathExists(agentsPath)) {
    result.agentsMd = await fs.readFile(agentsPath, 'utf-8');
  }

  // Read base steering files
  const steeringDir = path.join(profileDir, '.kiro', 'steering');
  if (await fs.pathExists(steeringDir)) {
    const files = await glob('*.md', { cwd: steeringDir });
    for (const file of files) {
      const content = await fs.readFile(path.join(steeringDir, file), 'utf-8');
      result.steeringFiles.push({ relativePath: `.kiro/steering/${file}`, content });
    }
  }

  // Read base skill files
  const skillsDir = path.join(profileDir, '.kiro', 'skills');
  if (await fs.pathExists(skillsDir)) {
    const files = await glob('*.md', { cwd: skillsDir });
    for (const file of files) {
      const content = await fs.readFile(path.join(skillsDir, file), 'utf-8');
      result.skillFiles.push({ relativePath: `.kiro/skills/${file}`, content });
    }
  }

  // Read base hook files
  const hooksDir = path.join(profileDir, '.kiro', 'hooks');
  if (await fs.pathExists(hooksDir)) {
    const files = await glob('*.json', { cwd: hooksDir });
    for (const file of files) {
      const content = await fs.readFile(path.join(hooksDir, file), 'utf-8');
      result.hookFiles.push({ relativePath: `.kiro/hooks/${file}`, content });
    }
  }

  // Apply country overlay if specified
  if (country) {
    const overlayDir = path.join(profileDir, 'countries', country);

    if (!(await fs.pathExists(overlayDir))) {
      // Country overlay doesn't exist — log warning, return base profile
      console.warn(
        `[ai-gov] Country overlay "${country}" not found for profile "${profileName}". Using base profile.`
      );
      return result;
    }

    // Overlay AGENTS.md — append (not replace)
    const overlayAgentsPath = path.join(overlayDir, 'AGENTS.md');
    if (await fs.pathExists(overlayAgentsPath)) {
      const overlayAgents = await fs.readFile(overlayAgentsPath, 'utf-8');
      if (result.agentsMd) {
        result.agentsMd = result.agentsMd + '\n\n' + overlayAgents;
      } else {
        result.agentsMd = overlayAgents;
      }
    }

    // Overlay steering files — override same-path, add new
    const overlaySteeringDir = path.join(overlayDir, '.kiro', 'steering');
    if (await fs.pathExists(overlaySteeringDir)) {
      const files = await glob('*.md', { cwd: overlaySteeringDir });
      for (const file of files) {
        const content = await fs.readFile(path.join(overlaySteeringDir, file), 'utf-8');
        const relativePath = `.kiro/steering/${file}`;
        const existingIdx = result.steeringFiles.findIndex(
          (f) => f.relativePath === relativePath
        );
        if (existingIdx >= 0) {
          result.steeringFiles[existingIdx].content = content;
        } else {
          result.steeringFiles.push({ relativePath, content });
        }
      }
    }

    // Overlay skill files
    const overlaySkillsDir = path.join(overlayDir, '.kiro', 'skills');
    if (await fs.pathExists(overlaySkillsDir)) {
      const files = await glob('*.md', { cwd: overlaySkillsDir });
      for (const file of files) {
        const content = await fs.readFile(path.join(overlaySkillsDir, file), 'utf-8');
        const relativePath = `.kiro/skills/${file}`;
        const existingIdx = result.skillFiles.findIndex(
          (f) => f.relativePath === relativePath
        );
        if (existingIdx >= 0) {
          result.skillFiles[existingIdx].content = content;
        } else {
          result.skillFiles.push({ relativePath, content });
        }
      }
    }

    // Overlay hook files — validate JSON
    const overlayHooksDir = path.join(overlayDir, '.kiro', 'hooks');
    if (await fs.pathExists(overlayHooksDir)) {
      const files = await glob('*.json', { cwd: overlayHooksDir });
      for (const file of files) {
        const raw = await fs.readFile(path.join(overlayHooksDir, file), 'utf-8');
        // Validate JSON
        try {
          JSON.parse(raw);
        } catch {
          console.warn(`[ai-gov] Invalid JSON in overlay hook: ${file}. Skipping.`);
          continue;
        }
        const relativePath = `.kiro/hooks/${file}`;
        const existingIdx = result.hookFiles.findIndex(
          (f) => f.relativePath === relativePath
        );
        if (existingIdx >= 0) {
          result.hookFiles[existingIdx].content = raw;
        } else {
          result.hookFiles.push({ relativePath, content: raw });
        }
      }
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
