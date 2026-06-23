import type { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { glob } from 'glob';
import { readJsonSafe, readFileSafe, fileExists, ensureDir, writeIfNotExists, writeAlways } from '../utils/fs.js';
import { fetchProfileFiles, getAvailableProfiles } from '../utils/template-fetcher.js';
import { matchProfile } from './profile-matcher.js';
import { success, error, heading, info, warn } from '../utils/logger.js';
import { PRODUCT_MD, SECURITY_MD } from '../templates/steering-foundations.js';

// ── Types ──

interface GenerateOptions {
  profile?: string;
  country?: string;
  force?: boolean;
}

interface StackInfo {
  runtime: string | null;
  language: string[];
  frameworks: string[];
  containerization: string[];
  infrastructure: string[];
  ci: string[];
  dependencies: Record<string, string>;
  scripts: Record<string, string>;
  packageManager: string;
  testFramework: string;
  projectDescription: string;
  projectName: string;
}

interface GovernancePack {
  steering_files: Array<{ relative_path: string; content: string; rationale: string }>;
  skill_files: Array<{ relative_path: string; content: string; rationale: string }>;
  hook_files: Array<{ relative_path: string; content: string; rationale: string }>;
  agents_md: string;
  project_context: string;
}

interface BackendGenerateResponse {
  mode: string;
  governance_pack: GovernancePack;
  generation_id?: string;
  agent_version?: string;
  rag_sources_used?: string[];
  duration_ms?: number;
}

// ── Constants ──

const FEMSA_PLATFORM_URL = 'http://fs-aiplatform-alb-1259630648.us-east-1.elb.amazonaws.com';

// Enterprise 2026: Async task pattern (A2A Protocol + OpenAI Background Mode)
// The backend agent takes 15-30s for RAG + generation. We use:
// - Initial POST timeout: 90s (generous, covers most cases)
// - Polling interval: 3s (A2A standard)
// - Max poll duration: 120s (2 min hard cap)
const BACKEND_INITIAL_TIMEOUT_MS = 90_000;
const BACKEND_POLL_INTERVAL_MS = 3_000;
const BACKEND_MAX_POLL_MS = 120_000;

// ── Stack Hash Computation (Task 7.1) ──

export function computeStackHash(stack: StackInfo): string {
  const serialized = JSON.stringify(stack, Object.keys(stack).sort());
  return createHash('sha256').update(serialized).digest('hex').substring(0, 16);
}

// ── Internal: Stack Detection (Task 7.2 — enhanced with dependencies) ──

async function detectStack(): Promise<{ stack: StackInfo; fileManifest: string[]; repoName: string }> {
  const fileManifest: string[] = [];
  const repoName = path.basename(process.cwd());

  const stack: StackInfo = {
    runtime: null,
    language: [],
    frameworks: [],
    containerization: [],
    infrastructure: [],
    ci: [],
    dependencies: {},
    scripts: {},
    packageManager: 'npm',
    testFramework: '',
    projectDescription: '',
    projectName: repoName,
  };

  // Detect package manager
  if (await fileExists('pnpm-lock.yaml') || await fileExists('pnpm-workspace.yaml')) {
    stack.packageManager = 'pnpm';
  } else if (await fileExists('yarn.lock')) {
    stack.packageManager = 'yarn';
  } else if (await fileExists('bun.lockb')) {
    stack.packageManager = 'bun';
  }

  // Detect test framework — first from config files, then from dependencies
  if (await fileExists('vitest.config.ts') || await fileExists('vitest.config.js')) {
    stack.testFramework = 'vitest';
  } else if (await fileExists('jest.config.ts') || await fileExists('jest.config.js') || await fileExists('jest.config.mjs')) {
    stack.testFramework = 'jest';
  } else if (await fileExists('pytest.ini') || await fileExists('conftest.py') || await fileExists('pyproject.toml')) {
    // For Python, check pyproject.toml content later after reading deps
    if (await fileExists('pytest.ini') || await fileExists('conftest.py')) {
      stack.testFramework = 'pytest';
    }
  }

  // Read project description from package.json or README
  const readmeContent = await readFileSafe('README.md');
  if (readmeContent) {
    // If README has git conflict markers, prefer the NEWER side (after =======)
    let readmeText = readmeContent;
    if (readmeContent.includes('<<<<<<< ') && readmeContent.includes('=======')) {
      const conflictEnd = readmeContent.indexOf('=======');
      const afterConflict = readmeContent.substring(conflictEnd + 7); // Skip "======="
      readmeText = afterConflict.replace(/^>>>>>>>.*$/m, '').trim();
    }

    // Extract first meaningful paragraph (project description only)
    // Skip: headers, badges, commands, code blocks, setup instructions
    const lines = readmeText.split('\n').filter(l => {
      const trimmed = l.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith('#')) return false;       // Headers
      if (trimmed.startsWith('[')) return false;       // Badges/links
      if (trimmed.startsWith('!')) return false;       // Images
      if (trimmed.startsWith('```')) return false;     // Code blocks
      if (trimmed.startsWith('$')) return false;       // Shell commands
      if (trimmed.startsWith('>')) return false;       // Blockquotes
      if (trimmed.startsWith('|')) return false;       // Tables
      if (trimmed.startsWith('<<<<<<<')) return false;  // Git conflicts
      if (trimmed.startsWith('>>>>>>>')) return false;
      if (trimmed.startsWith('=======')) return false;
      // Skip lines that look like commands/instructions (not descriptions)
      if (/^(npm|npx|yarn|pip|brew|curl|wget|git|docker|ssh|cd |mkdir|export|source|nvm|apt|sudo)/.test(trimmed)) return false;
      if (/^(Run |Install |Execute |Navigate |Setup |Configure )/.test(trimmed)) return false;
      if (trimmed.includes('`') && trimmed.split('`').length > 3) return false;  // Too many code snippets
      return true;
    });
    stack.projectDescription = lines.slice(0, 2).join(' ').substring(0, 200);
  }

  // Node.js / package.json
  const pkgJson = await readJsonSafe<Record<string, unknown>>('package.json');
  if (pkgJson) {
    fileManifest.push('package.json');
    stack.runtime = 'node';
    stack.language.push('typescript');

    const prodDeps = (pkgJson.dependencies as Record<string, string>) || {};
    const devDeps = (pkgJson.devDependencies as Record<string, string>) || {};

    // Task 7.2: Extract all dependencies with versions
    Object.assign(stack.dependencies, prodDeps, devDeps);

    // Extract scripts for AGENTS.md commands (discover-project-commands pattern)
    const scripts = (pkgJson.scripts as Record<string, string>) || {};
    Object.assign(stack.scripts, scripts);

    const deps = { ...prodDeps, ...devDeps };

    if (deps['next']) { stack.frameworks.push('nextjs'); fileManifest.push('next'); }
    if (deps['express']) stack.frameworks.push('express');
    if (deps['fastify']) stack.frameworks.push('fastify');
    if (deps['react']) { stack.frameworks.push('react'); fileManifest.push('react'); }

    // Dependency-based test framework detection (Specfy pattern: deps are source of truth)
    // Config file detection runs first (above), deps fill in if config was not found
    if (!stack.testFramework) {
      if (deps['vitest']) stack.testFramework = 'vitest';
      else if (deps['jest']) stack.testFramework = 'jest';
      else if (deps['mocha']) stack.testFramework = 'mocha';
    }
  }

  // Python
  const hasRequirements = await fileExists('requirements.txt');
  const hasPyproject = await fileExists('pyproject.toml');
  if (hasRequirements) fileManifest.push('requirements.txt');
  if (hasPyproject) fileManifest.push('pyproject.toml');
  if (hasRequirements || hasPyproject) {
    if (!stack.language.includes('python')) stack.language.push('python');
    if (!stack.runtime) stack.runtime = 'python';
    const reqContent = await readFileSafe('requirements.txt');
    const reqDevContent = await readFileSafe('requirements-dev.txt');
    const allReqs = (reqContent || '') + '\n' + (reqDevContent || '');
    if (allReqs.includes('fastapi')) stack.frameworks.push('fastapi');
    if (allReqs.includes('django')) stack.frameworks.push('django');
    // Python test framework detection from deps
    if (!stack.testFramework) {
      if (allReqs.includes('pytest')) stack.testFramework = 'pytest';
    }
  }

  // Java / Maven / Gradle (non-Android)
  const hasPom = await fileExists('pom.xml');
  const hasBuildGradle = await fileExists('build.gradle') || await fileExists('build.gradle.kts');
  if (hasPom) {
    fileManifest.push('pom.xml');
    if (!stack.language.includes('java')) stack.language.push('java');
    if (!stack.runtime) stack.runtime = 'jvm';
    // Read pom.xml to detect frameworks
    const pomContent = await readFileSafe('pom.xml');
    if (pomContent) {
      if (pomContent.includes('spring-boot')) stack.frameworks.push('spring-boot');
      if (pomContent.includes('quarkus')) stack.frameworks.push('quarkus');
      if (pomContent.includes('micronaut')) stack.frameworks.push('micronaut');
    }
    if (!stack.testFramework) stack.testFramework = 'junit';
    stack.packageManager = 'maven';
  } else if (hasBuildGradle && !stack.language.includes('kotlin')) {
    // Non-Android Gradle project (Android already detected above by settings.gradle.kts)
    fileManifest.push('build.gradle');
    if (!stack.language.includes('java')) stack.language.push('java');
    if (!stack.runtime) stack.runtime = 'jvm';
    if (!stack.testFramework) stack.testFramework = 'junit';
    stack.packageManager = 'gradle';
  }

  // Docker
  if (await fileExists('Dockerfile')) { stack.containerization.push('docker'); fileManifest.push('Dockerfile'); }
  if (await fileExists('docker-compose.yml')) { stack.containerization.push('docker-compose'); fileManifest.push('docker-compose.yml'); }

  // Infrastructure
  const tfFiles = await glob('**/*.tf', { ignore: 'node_modules/**' });
  if (tfFiles.length > 0) {
    stack.infrastructure.push('terraform');
    stack.frameworks.push('terraform');
    if (!stack.language.includes('hcl')) stack.language.push('hcl');
    if (!stack.runtime) stack.runtime = 'terraform';
    fileManifest.push(...tfFiles);
  }

  const helmFiles = await glob('**/Chart.yaml', { ignore: 'node_modules/**' });
  if (helmFiles.length > 0) {
    stack.infrastructure.push('helm');
    stack.frameworks.push('helm');
    fileManifest.push('Chart.yaml');
  }
  if (await fileExists('values.yaml')) fileManifest.push('values.yaml');
  if (await fileExists('templates')) fileManifest.push('templates/');

  const k8sFiles = await glob('**/k8s/**/*.{yaml,yml}', { ignore: 'node_modules/**' });
  if (k8sFiles.length > 0) stack.infrastructure.push('kubernetes');

  // Serverless
  for (const sf of ['serverless.yml', 'serverless.yaml', 'template.yaml', 'template.yml']) {
    if (await fileExists(sf)) fileManifest.push(sf);
  }

  // CI/CD
  if (await fileExists('.github/workflows')) { stack.ci.push('github-actions'); fileManifest.push('.github/workflows'); }
  if (await fileExists('Jenkinsfile')) { stack.ci.push('jenkins'); fileManifest.push('Jenkinsfile'); }
  if (await fileExists('.gitlab-ci.yml')) { stack.ci.push('gitlab-ci'); fileManifest.push('.gitlab-ci.yml'); }
  if (await fileExists('bitbucket-pipelines.yml')) { stack.ci.push('bitbucket-pipelines'); fileManifest.push('bitbucket-pipelines.yml'); }

  // Mobile — Android/Kotlin
  const gradleFiles = await glob('**/build.gradle.kts', { ignore: 'node_modules/**' });
  if (gradleFiles.length > 0) {
    if (!stack.language.includes('kotlin')) stack.language.push('kotlin');
    if (!stack.runtime) stack.runtime = 'jvm';
    fileManifest.push('build.gradle.kts');
  }
  if (await fileExists('settings.gradle.kts') || await fileExists('settings.gradle')) {
    fileManifest.push('settings.gradle.kts');
  }
  const androidManifest = await glob('**/AndroidManifest.xml', { ignore: 'node_modules/**' });
  if (androidManifest.length > 0) fileManifest.push('AndroidManifest.xml');
  if (await fileExists('src/main/kotlin')) fileManifest.push('src/main/kotlin/');

  // iOS/Swift
  if (await fileExists('Package.swift')) {
    if (!stack.language.includes('swift')) stack.language.push('swift');
    if (!stack.runtime) stack.runtime = 'apple';
    fileManifest.push('Package.swift');
  }
  const xcodeProjs = await glob('**/*.xcodeproj', { ignore: 'node_modules/**' });
  if (xcodeProjs.length > 0) {
    if (!stack.language.includes('swift')) stack.language.push('swift');
    if (!stack.runtime) stack.runtime = 'apple';
    fileManifest.push(xcodeProjs[0]);
  }
  const swiftFiles = await glob('**/*.swift', { ignore: ['node_modules/**', '.build/**'] });
  if (swiftFiles.length > 0 && !stack.language.includes('swift')) {
    stack.language.push('swift');
    if (!stack.runtime) stack.runtime = 'apple';
  }
  if (await fileExists('Sources')) fileManifest.push('Sources/');

  // Next.js configs
  for (const nc of ['next.config.js', 'next.config.mjs', 'next.config.ts']) {
    if (await fileExists(nc)) fileManifest.push(nc);
  }

  // Task 7.2: Include additional config files in manifest
  for (const configFile of ['tsconfig.json', '.eslintrc.json', '.eslintrc.js', 'jest.config.js', 'jest.config.ts', 'vitest.config.ts']) {
    if (await fileExists(configFile)) fileManifest.push(configFile);
  }

  return { stack, fileManifest, repoName };
}

// ── Auto-detect repo_id from git ──

async function detectRepoId(): Promise<string> {
  try {
    const { execSync } = await import('node:child_process');
    const remoteUrl = execSync('git config --get remote.origin.url', { encoding: 'utf-8' }).trim();
    if (remoteUrl) return remoteUrl;
  } catch {
    // Fallback to directory name
  }
  return path.basename(process.cwd());
}

// ── Get existing .kiro/ governance files ──

async function getExistingGovernanceFiles(): Promise<string[]> {
  try {
    const files = await glob('.kiro/**/*', { nodir: true });
    return files;
  } catch {
    return [];
  }
}

// ── Backend API Call (Task 6.1 — Async with Polling, A2A Pattern) ──

/**
 * Poll generation status until completed or timeout.
 * Follows A2A task lifecycle: submitted → working → completed | failed
 * Reference: https://a2a-protocol.org/latest/topics/streaming-and-async/
 */
async function pollGenerationStatus(
  generationId: string,
  maxPollMs: number = BACKEND_MAX_POLL_MS,
): Promise<BackendGenerateResponse | null> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxPollMs) {
    await new Promise(resolve => setTimeout(resolve, BACKEND_POLL_INTERVAL_MS));

    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 10_000);

      const resp = await fetch(`${FEMSA_PLATFORM_URL}/governance/generations/${generationId}`, {
        method: 'GET',
        headers: {
          'User-Agent': '@femsa/ai-governance-cli/0.2.0',
        },
        signal: controller.signal,
      });
      clearTimeout(tid);

      if (resp.status !== 200) continue;

      const data = await resp.json() as Record<string, unknown>;
      const status = data.status as string;

      // A2A lifecycle: completed → extract governance_pack
      if (status === 'completed') {
        const pack = data.governance_pack as GovernancePack | undefined;
        if (pack && (pack.steering_files?.length || pack.agents_md)) {
          return {
            mode: 'ai-powered',
            governance_pack: pack,
            generation_id: generationId,
            agent_version: (data.agent_version as string) || '1.0.0',
            rag_sources_used: data.rag_sources_used as string[] | undefined,
            duration_ms: data.duration_ms as number | undefined,
          };
        }
        // Completed but no pack → treat as failed
        return null;
      }

      // Failed → stop polling
      if (status === 'failed' || status === 'error') {
        return null;
      }

      // submitted | working → continue polling
    } catch {
      // Network error during poll → continue
      continue;
    }
  }

  // Timeout → return null (will fall through to local fallback)
  return null;
}

async function callBackendGenerate(
  repoId: string,
  repoName: string,
  stack: StackInfo,
  fileManifest: string[],
  stackHash: string,
  force: boolean,
  existingGovernanceFiles: string[],
): Promise<BackendGenerateResponse | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BACKEND_INITIAL_TIMEOUT_MS);

  try {
    const response = await fetch(`${FEMSA_PLATFORM_URL}/governance/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': '@femsa/ai-governance-cli/0.2.0',
      },
      body: JSON.stringify({
        repo_id: repoId,
        repo_name: repoName,
        stack,
        file_manifest: fileManifest,
        dependencies: stack.dependencies,
        scripts: stack.scripts,
        stack_hash: stackHash,
        force,
        existing_governance_files: existingGovernanceFiles,
      }),
      signal: controller.signal,
    });

    if (response.ok) {
      const data = (await response.json()) as BackendGenerateResponse;

      // Case 1: Backend completed synchronously (fast path — cache hit or fallback)
      if (data.governance_pack && data.governance_pack.steering_files?.length) {
        return data;
      }

      // Case 2: Backend returned generation_id but pack is empty/incomplete
      // This happens when agent is still working. Poll for completion.
      if (data.generation_id && data.mode === 'ai-powered') {
        clearTimeout(timeoutId); // Release initial timeout before polling
        const polled = await pollGenerationStatus(data.generation_id);
        return polled;
      }

      // Case 3: Fallback mode with content
      return data;
    }

    // 202 Accepted: Backend accepted but processing async (future A2A pattern)
    if (response.status === 202) {
      const data = (await response.json()) as { generation_id: string };
      if (data.generation_id) {
        clearTimeout(timeoutId);
        return await pollGenerationStatus(data.generation_id);
      }
    }

    // Non-200/202 response → fall through to fallback
    return null;
  } catch {
    // Timeout, network error, etc. → fall through to fallback
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Write Governance Pack (Task 6.3) ──

async function writeGovernancePack(
  pack: GovernancePack,
  force: boolean,
  stack: StackInfo = { runtime: null, language: [], frameworks: [], containerization: [], infrastructure: [], ci: [], dependencies: {}, scripts: {} },
  repoName: string = 'project',
): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];

  // ── Validate before writing (enterprise guardrail pattern 2026) ──
  // Filter out empty/invalid files to prevent broken governance artifacts
  const validSteering = pack.steering_files.filter(f => {
    if (!f.content?.trim()) return false;
    if (!f.relative_path) return false;
    return true;
  });

  const validSkills = pack.skill_files.filter(f => {
    if (!f.content?.trim()) return false;
    if (!f.relative_path) return false;
    return true;
  });

  const validHooks = pack.hook_files.filter(f => {
    if (!f.content?.trim()) return false;
    if (!f.relative_path) return false;
    // Validate JSON syntax
    try { JSON.parse(f.content); return true; } catch { return false; }
  });

  // Write steering files
  for (const file of validSteering) {
    if (force) {
      await writeAlways(file.relative_path, file.content);
      created.push(file.relative_path);
    } else {
      if (await writeIfNotExists(file.relative_path, file.content)) {
        created.push(file.relative_path);
      } else {
        skipped.push(file.relative_path);
      }
    }
  }

  // Write skill files
  for (const file of validSkills) {
    if (force) {
      await writeAlways(file.relative_path, file.content);
      created.push(file.relative_path);
    } else {
      if (await writeIfNotExists(file.relative_path, file.content)) {
        created.push(file.relative_path);
      } else {
        skipped.push(file.relative_path);
      }
    }
  }

  // Write hook files (pre-validated JSON)
  for (const file of validHooks) {
    if (force) {
      await writeAlways(file.relative_path, file.content);
      created.push(file.relative_path);
    } else {
      if (await writeIfNotExists(file.relative_path, file.content)) {
        created.push(file.relative_path);
      } else {
        skipped.push(file.relative_path);
      }
    }
  }

  // Write agents_md — ALWAYS overwrite (generate's version is always correct)
  // Fix: init creates a template AGENTS.md, but generate has the real content with commands
  if (pack.agents_md) {
    await writeAlways('AGENTS.md', pack.agents_md);
    created.push('AGENTS.md');
  }

  // ── Foundational steering: product.md (Kiro standard: describes what project IS) ──
  // Reference: kiro.dev/docs — "Describes what the project is. Helps Kiro understand the big picture."
  if (stack.projectDescription || stack.projectName) {
    // Sanitize description: remove any lingering git conflict markers
    const sanitizedDescription = (stack.projectDescription || '')
      .replace(/<<<<<<< .*/g, '')
      .replace(/>>>>>>>.*/g, '')
      .replace(/=======/g, '')
      .split('\n')
      .filter(l => !l.trim().startsWith('- ') && !l.trim().startsWith('* '))  // Remove bullet lists (tech info duplicates tech.md)
      .join('\n')
      .trim();

    const productContent = `---
inclusion: always
---
# Product Overview

## What is this project
${sanitizedDescription || `${stack.projectName} — a ${stack.runtime || 'software'} project using ${stack.frameworks.join(', ') || 'standard tools'}.`}

## Tech Stack
- Runtime: ${stack.runtime || 'unknown'}
- Frameworks: ${stack.frameworks.join(', ') || 'none detected'}
- Package Manager: ${stack.packageManager}
- Test Framework: ${stack.testFramework || 'not detected'}

## Key Decisions
- _Document architectural decisions here as they are made_
`;
    await writeAlways('.kiro/steering/product.md', productContent);
    created.push('.kiro/steering/product.md');
  }

  // ── Foundational steering: structure.md (Kiro standard: key folders) ──
  // Reference: kiro.dev/docs — "Describes key folders and areas of the project."
  const structureDirs = ['src', 'app', 'lib', 'components', 'pages', 'api', 'services', 'utils', 'tests', 'e2e', 'k8s', 'infra'];
  const existingDirs: string[] = [];
  for (const dir of structureDirs) {
    if (await fileExists(dir)) existingDirs.push(dir);
  }
  if (existingDirs.length > 0) {
    const structureContent = `---
inclusion: always
---
# Project Structure

## Key Directories
${existingDirs.map(d => `- \`${d}/\``).join('\n')}

## Entry Points
${await fileExists('app') ? '- `app/` — Next.js App Router pages' : ''}
${await fileExists('src') ? '- `src/` — Source code' : ''}
${await fileExists('lib') ? '- `lib/` — Shared utilities and helpers' : ''}
${await fileExists('components') ? '- `components/` — Reusable UI components' : ''}
${await fileExists('e2e') ? '- `e2e/` — End-to-end tests (Playwright)' : ''}
${await fileExists('k8s') ? '- `k8s/` — Kubernetes manifests' : ''}
`;
    await writeAlways('.kiro/steering/structure.md', structureContent);
    created.push('.kiro/steering/structure.md');
  }

  // NOTE: project-context.md NOT generated (not in Kiro standard, was redundant with product.md)

  // ── Cross-IDE Multi-Tool Generation (2026 standard) ──
  // Reference: SSW Consulting — "symlinks maintain single source of truth"
  // Reference: Addy Osmani agent-skills — generates for ALL tools simultaneously
  // Reference: understandingdata.com — "Update once, apply everywhere"
  //
  // Strategy:
  // - CLAUDE.md / GEMINI.md → symlink to AGENTS.md (same content)
  // - .claude/rules/ → steering adapted with paths: frontmatter
  // - .claude/skills/ → symlink to .kiro/skills/
  // - .cursor/rules/ → steering without Kiro frontmatter
  // - .github/copilot-instructions.md → steering condensed (max 4000 chars)

  // ── Symlinks: CLAUDE.md and GEMINI.md point to AGENTS.md ──
  if (pack.agents_md) {
    const symlinkTarget = 'AGENTS.md';
    // CLAUDE.md symlink
    try {
      const { symlink, unlink, stat } = await import('node:fs/promises');
      try { await unlink('CLAUDE.md'); } catch {}
      await symlink(symlinkTarget, 'CLAUDE.md');
      created.push('CLAUDE.md → AGENTS.md (symlink)');
    } catch {
      // Fallback: copy if symlink fails (Windows without admin)
      await writeAlways('CLAUDE.md', pack.agents_md);
      created.push('CLAUDE.md');
    }
    // GEMINI.md symlink
    try {
      const { symlink, unlink } = await import('node:fs/promises');
      try { await unlink('GEMINI.md'); } catch {}
      await symlink(symlinkTarget, 'GEMINI.md');
      created.push('GEMINI.md → AGENTS.md (symlink)');
    } catch {
      await writeAlways('GEMINI.md', pack.agents_md);
      created.push('GEMINI.md');
    }
  }

  // ── .claude/rules/ — Steering with paths: frontmatter for Claude Code ──
  if (validSteering.length > 0) {
    await ensureDir('.claude/rules');
    for (const file of validSteering) {
      // Skip project-context (not a rule)
      if (file.relative_path.includes('project-context') || file.relative_path.includes('tech.md')) continue;

      const fileName = file.relative_path.split('/').pop() || 'rule.md';
      // Convert Kiro frontmatter to Claude paths: frontmatter
      let claudeContent = file.content;
      // Replace inclusion: always with paths: "**/*"
      claudeContent = claudeContent.replace(/^---\ninclusion: always\n---/m, '---\npaths:\n  - "**/*"\n---');
      // Replace fileMatch patterns
      claudeContent = claudeContent.replace(/^---\ninclusion: fileMatch\nfileMatchPattern: (.*)\n---/m, (_, patterns) => {
        // Convert array string to paths format
        const parsed = patterns.replace(/[\[\]"]/g, '').split(',').map((p: string) => p.trim());
        return '---\npaths:\n' + parsed.map((p: string) => `  - "${p}"`).join('\n') + '\n---';
      });
      await writeAlways(`.claude/rules/${fileName}`, claudeContent);
      created.push(`.claude/rules/${fileName}`);
    }
  }

  // ── .claude/skills/ → symlink to .kiro/skills/ ──
  if (validSkills.length > 0) {
    try {
      const { symlink, unlink, stat } = await import('node:fs/promises');
      try { await unlink('.claude/skills'); } catch {}
      await ensureDir('.claude');
      await symlink('../.kiro/skills', '.claude/skills', 'junction');
      created.push('.claude/skills → .kiro/skills (symlink)');
    } catch {
      // Fallback: copy skills to .claude/skills/
      await ensureDir('.claude/skills');
      for (const file of validSkills) {
        const claudePath = file.relative_path.replace('.kiro/skills/', '.claude/skills/');
        await writeAlways(claudePath, file.content);
        created.push(claudePath);
      }
    }
  }

  // ── .cursor/rules/ — Plain markdown without frontmatter ──
  if (validSteering.length > 0) {
    await ensureDir('.cursor/rules');
    for (const file of validSteering) {
      if (file.relative_path.includes('project-context') || file.relative_path.includes('tech.md')) continue;

      const fileName = file.relative_path.split('/').pop()?.replace('.md', '.mdc') || 'rule.mdc';
      // Strip all YAML frontmatter for Cursor
      let cursorContent = file.content.replace(/^---[\s\S]*?---\n*/m, '');
      await writeAlways(`.cursor/rules/${fileName}`, cursorContent);
      created.push(`.cursor/rules/${fileName}`);
    }
  }

  // ── .github/copilot-instructions.md — Condensed steering (max 4000 chars) ──
  if (validSteering.length > 0) {
    await ensureDir('.github');
    // Combine all steering into one file, max 4000 chars (Copilot limit)
    let combined = '# Project Coding Standards\n\n';
    combined += '> Auto-generated by @femsa/ai-governance. Applies to GitHub Copilot.\n\n';
    for (const file of validSteering) {
      if (file.relative_path.includes('project-context') || file.relative_path.includes('tech.md')) continue;
      // Strip frontmatter and add content
      const content = file.content.replace(/^---[\s\S]*?---\n*/m, '');
      combined += content + '\n\n';
    }
    // Truncate to 4000 chars (Copilot limit)
    if (combined.length > 4000) {
      combined = combined.substring(0, 3950) + '\n\n<!-- Truncated: see .kiro/steering/ for full rules -->\n';
    }
    await writeAlways('.github/copilot-instructions.md', combined);
    created.push('.github/copilot-instructions.md');
  }

  // ── Auto-fill tech.md with detected stack ──
  const techContent = buildTechContent(stack);
  if (techContent) {
    await writeAlways('.kiro/steering/tech.md', techContent);
    created.push('.kiro/steering/tech.md (auto-filled)');
  }

  return { created, skipped };
}

function buildTechContent(stack: StackInfo): string {
  const lines: string[] = [
    '# Technology Stack',
    '',
    '> Auto-detected by @femsa/ai-governance CLI. Kiro reads this on every interaction.',
    '',
    '## Languages & Runtimes',
    '',
  ];

  if (stack.runtime) lines.push(`- ${stack.runtime}`);
  for (const lang of stack.language) lines.push(`- ${lang}`);
  if (stack.language.length === 0 && !stack.runtime) lines.push('_Not detected_');

  lines.push('', '## Frameworks', '');
  if (stack.frameworks.length > 0) {
    for (const fw of stack.frameworks) lines.push(`- ${fw}`);
  } else {
    lines.push('_Not detected_');
  }

  // Key dependencies (detected from package.json / requirements.txt)
  const keyDeps: string[] = [];
  const depsToDetect = ['tailwindcss', 'vitest', 'jest', 'playwright', '@playwright/test', 'cypress', 'prisma', 'drizzle-orm', 'trpc', 'zustand', 'redux', 'pinia', 'storybook', 'turbo', 'nx'];
  for (const dep of depsToDetect) {
    if (stack.dependencies[dep]) {
      keyDeps.push(`${dep} ${stack.dependencies[dep]}`);
    }
  }
  if (keyDeps.length > 0) {
    lines.push('', '## Key Libraries', '');
    for (const d of keyDeps) lines.push(`- ${d}`);
  }

  lines.push('', '## Package Manager', '');
  if (stack.runtime === 'node' || stack.language.includes('typescript') || stack.language.includes('javascript')) {
    lines.push(`- ${stack.packageManager || 'npm'}`);
  } else if (stack.runtime === 'python' || stack.language.includes('python')) {
    lines.push('- pip');
  } else if (stack.packageManager === 'maven') {
    lines.push('- Maven');
  } else if (stack.packageManager === 'gradle') {
    lines.push('- Gradle');
  } else {
    lines.push('- _N/A_');
  }

  if (stack.testFramework) {
    lines.push('', '## Test Framework', '');
    lines.push(`- ${stack.testFramework}`);
  }

  lines.push('', '## Infrastructure', '');
  if (stack.containerization.length > 0 || stack.infrastructure.length > 0) {
    for (const c of stack.containerization) lines.push(`- ${c}`);
    for (const i of stack.infrastructure) lines.push(`- ${i}`);
  } else {
    lines.push('_Not detected_');
  }

  lines.push('', '## CI/CD', '');
  if (stack.ci.length > 0) {
    for (const ci of stack.ci) lines.push(`- ${ci}`);
  } else {
    lines.push('_Not detected_');
  }

  lines.push('', '## Constraints', '', '- _Add project-specific constraints here_', '');
  return lines.join('\n');
}

// ── Main Command ──

export function registerGenerateCommand(program: Command): void {
  program
    .command('generate')
    .description('Auto-detect stack and generate .kiro/steering, skills, and hooks from a governance profile')
    .option('--profile <name>', 'Use a specific profile instead of auto-detecting')
    .option('--country <code>', 'Country overlay (CL, CO, EC, MX)')
    .option('--force', 'Overwrite existing files')
    .action(async (options: GenerateOptions) => {
      const startTime = Date.now();

      heading('AI Governance — Generate');
      console.log(chalk.dim('  Detects your stack → selects profile → generates Kiro steering/skills/hooks'));
      console.log('');

      // Validate country
      const validCountries = ['CL', 'CO', 'EC', 'MX'];
      if (options.country && !validCountries.includes(options.country.toUpperCase())) {
        error(`Invalid country "${options.country}". Valid: ${validCountries.join(', ')}`);
        process.exit(1);
      }
      const country = options.country?.toUpperCase();

      // ── Step 1: Detect stack (internal, no files written) ──
      const spinner = ora('Scanning project stack...').start();
      const { stack, fileManifest, repoName } = await detectStack();

      // ── Step 1.5: Compute stack hash (Task 7.1) ──
      const stackHash = computeStackHash(stack);

      // ── Step 2: Determine profile ──
      let profileName: string;

      // ── FIX 9: Monorepo detection (enterprise 2026 — Nx/Turborepo/Yarn workspaces) ──
      // If monorepo detected, enrich stack with workspace info for better governance generation
      const pkgJson = await readJsonSafe<Record<string, unknown>>('package.json');
      const isMonorepo = !!(
        pkgJson?.workspaces ||
        await fileExists('lerna.json') ||
        await fileExists('nx.json') ||
        await fileExists('turbo.json') ||
        await fileExists('pnpm-workspace.yaml')
      );
      if (isMonorepo) {
        (stack as any).monorepo = true;
        (stack as any).workspace_tool = pkgJson?.workspaces ? 'yarn-workspaces'
          : await fileExists('nx.json') ? 'nx'
          : await fileExists('turbo.json') ? 'turborepo'
          : await fileExists('pnpm-workspace.yaml') ? 'pnpm'
          : 'lerna';
        spinner.text = `Monorepo detected (${(stack as any).workspace_tool})`;
      }

      if (options.profile) {
        // Explicit profile override
        const available = await getAvailableProfiles();
        if (!available.includes(options.profile)) {
          spinner.fail(`Unknown profile "${options.profile}"`);
          error(`Available: ${available.join(', ')}`);
          process.exit(1);
        }
        profileName = options.profile;
        spinner.text = `Using profile: ${profileName} (explicit)`;
      } else {
        // Auto-detect via ProfileMatcher
        const match = matchProfile(fileManifest, repoName);
        profileName = match.profile;
        spinner.text = `Detected: ${profileName} (${match.confidence} confidence)`;
      }

      // ── Step 3: Try backend API call (Task 6.1 — async with polling) ──
      spinner.text = 'Connecting to governance platform (AI-powered generation)...';

      let backendResponse: BackendGenerateResponse | null = null;
      let generationMode: 'ai-powered' | 'fallback' = 'fallback';

      const repoId = await detectRepoId();
      const existingGovernanceFiles = await getExistingGovernanceFiles();

      backendResponse = await callBackendGenerate(
        repoId,
        repoName,
        stack,
        fileManifest,
        stackHash,
        options.force || false,
        existingGovernanceFiles,
      );

      if (backendResponse?.governance_pack) {
        generationMode = 'ai-powered';
      }

      // ── Step 4: Write files to .kiro/ ──
      spinner.text = 'Writing governance files...';
      await ensureDir('.kiro/steering');
      await ensureDir('.kiro/skills');
      await ensureDir('.kiro/hooks');

      let created: string[] = [];
      let skipped: string[] = [];

      if (generationMode === 'ai-powered' && backendResponse?.governance_pack) {
        // Backend provided governance pack (Task 6.3)
        const result = await writeGovernancePack(backendResponse.governance_pack, options.force || false, stack, repoName);
        created = result.created;
        skipped = result.skipped;
      } else {
        // Task 6.2 v3: Local profile fallback — reads real content from bundled profiles/
        spinner.text = `Loading local profile: ${profileName}...`;
        const profileFiles = await fetchProfileFiles(profileName, country);

        if (profileFiles && (profileFiles.agentsMd || profileFiles.steeringFiles.length > 0)) {
          generationMode = 'local-profile' as typeof generationMode;
          info(`Using bundled profile: ${profileName}`);

          // Write AGENTS.md
          if (profileFiles.agentsMd) {
            if (options.force) {
              await writeAlways('AGENTS.md', profileFiles.agentsMd);
              created.push('AGENTS.md');
            } else {
              if (await writeIfNotExists('AGENTS.md', profileFiles.agentsMd)) {
                created.push('AGENTS.md');
              } else {
                skipped.push('AGENTS.md');
              }
            }
          }

          // Write steering files
          for (const file of profileFiles.steeringFiles) {
            if (options.force) {
              await writeAlways(file.relativePath, file.content);
              created.push(file.relativePath);
            } else {
              if (await writeIfNotExists(file.relativePath, file.content)) {
                created.push(file.relativePath);
              } else {
                skipped.push(file.relativePath);
              }
            }
          }

          // Write skill files
          for (const file of profileFiles.skillFiles) {
            if (options.force) {
              await writeAlways(file.relativePath, file.content);
              created.push(file.relativePath);
            } else {
              if (await writeIfNotExists(file.relativePath, file.content)) {
                created.push(file.relativePath);
              } else {
                skipped.push(file.relativePath);
              }
            }
          }

          // Write hook files
          for (const file of profileFiles.hookFiles) {
            if (options.force) {
              await writeAlways(file.relativePath, file.content);
              created.push(file.relativePath);
            } else {
              if (await writeIfNotExists(file.relativePath, file.content)) {
                created.push(file.relativePath);
              } else {
                skipped.push(file.relativePath);
              }
            }
          }
        } else {
          // Ultimate fallback: minimal static templates
          warn('Backend unreachable and no local profile found — using minimal fallback');

          if (options.force) {
            await writeAlways('.kiro/steering/project-context.md', PRODUCT_MD);
            created.push('.kiro/steering/project-context.md');
            await writeAlways('.kiro/steering/security.md', SECURITY_MD);
            created.push('.kiro/steering/security.md');
          } else {
            if (await writeIfNotExists('.kiro/steering/project-context.md', PRODUCT_MD)) {
              created.push('.kiro/steering/project-context.md');
            } else {
              skipped.push('.kiro/steering/project-context.md');
            }
            if (await writeIfNotExists('.kiro/steering/security.md', SECURITY_MD)) {
              created.push('.kiro/steering/security.md');
            } else {
              skipped.push('.kiro/steering/security.md');
            }
          }
        }
      }

      // Auto-fill .kiro/steering/tech.md with detected stack
      const techContent = buildTechContent(stack);
      await writeAlways('.kiro/steering/tech.md', techContent);
      if (!created.includes('.kiro/steering/tech.md')) {
        created.push('.kiro/steering/tech.md (auto-filled)');
      }

      // ── Step 5: Update .ai-governance.json ──
      const configPath = '.ai-governance.json';
      const existingConfig = await readJsonSafe<Record<string, unknown>>(configPath) || {};
      const updatedConfig = {
        ...existingConfig,
        profile: profileName,
        ...(country ? { country } : {}),
        last_generate: new Date().toISOString(),
        generation_mode: generationMode,
        stack_hash: stackHash,
        detected_stack: {
          runtime: stack.runtime,
          languages: stack.language,
          frameworks: stack.frameworks,
          infrastructure: stack.infrastructure,
          ci: stack.ci,
        },
      };
      await writeAlways(configPath, JSON.stringify(updatedConfig, null, 2) + '\n');

      spinner.succeed('Generation complete');

      // ── Step 6: Generation summary display (Task 6.4) ──
      const durationMs = Date.now() - startTime;
      const durationSec = (durationMs / 1000).toFixed(1);

      console.log('');
      console.log(chalk.hex('#00A94F')('  ┌─────────────────────────────────────────────────────┐'));
      console.log(chalk.hex('#00A94F')('  │') + chalk.bold('  Governance Generated                              ') + chalk.hex('#00A94F')('│'));
      console.log(chalk.hex('#00A94F')('  ├─────────────────────────────────────────────────────┤'));
      console.log(chalk.hex('#00A94F')('  │') + `  Mode:     ${chalk.bold(generationMode)}` + ' '.repeat(Math.max(0, 39 - generationMode.length)) + chalk.hex('#00A94F')('│'));
      console.log(chalk.hex('#00A94F')('  │') + `  Profile:  ${chalk.bold(profileName)}` + ' '.repeat(Math.max(0, 39 - profileName.length)) + chalk.hex('#00A94F')('│'));
      if (country) {
        console.log(chalk.hex('#00A94F')('  │') + `  Country:  ${country}` + ' '.repeat(Math.max(0, 39 - country.length)) + chalk.hex('#00A94F')('│'));
      }
      console.log(chalk.hex('#00A94F')('  │') + `  Stack:    ${(stack.frameworks.join(', ') || stack.runtime || 'unknown').substring(0, 39)}` + ' '.repeat(Math.max(0, 39 - (stack.frameworks.join(', ') || stack.runtime || 'unknown').length)) + chalk.hex('#00A94F')('│'));
      console.log(chalk.hex('#00A94F')('  │') + `  Files:    ${created.length} created, ${skipped.length} skipped` + ' '.repeat(Math.max(0, 27 - String(created.length).length - String(skipped.length).length)) + chalk.hex('#00A94F')('│'));
      console.log(chalk.hex('#00A94F')('  │') + `  Duration: ${durationSec}s` + ' '.repeat(Math.max(0, 39 - durationSec.length - 1)) + chalk.hex('#00A94F')('│'));
      console.log(chalk.hex('#00A94F')('  └─────────────────────────────────────────────────────┘'));

      console.log('');
      if (created.length > 0) {
        console.log(chalk.bold('  Files created:'));
        for (const f of created) {
          success(`${f}`);
        }
      }
      if (skipped.length > 0) {
        console.log('');
        warn(`${skipped.length} file(s) already existed (use --force to overwrite)`);
      }

      console.log('');
      console.log(chalk.hex('#00A94F')('  What happens now:'));
      console.log(chalk.dim('    • Kiro reads .kiro/steering/ on every interaction (always)'));
      console.log(chalk.dim('    • Kiro activates .kiro/skills/ when relevant (auto)'));
      console.log(chalk.dim('    • Kiro runs .kiro/hooks/ on file events (automated)'));
      console.log(chalk.dim('    • AGENTS.md applies to ALL AI tools (Kiro + Claude + Cursor)'));
      console.log('');
      console.log(chalk.dim('  To validate compliance: npx @femsa/ai-governance validate'));
      console.log('');
    });
}
