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
  };

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

    const deps = { ...prodDeps, ...devDeps };

    if (deps['next']) { stack.frameworks.push('nextjs'); fileManifest.push('next'); }
    if (deps['express']) stack.frameworks.push('express');
    if (deps['fastify']) stack.frameworks.push('fastify');
    if (deps['react']) { stack.frameworks.push('react'); fileManifest.push('react'); }
  }

  // Python
  const hasRequirements = await fileExists('requirements.txt');
  const hasPyproject = await fileExists('pyproject.toml');
  if (hasRequirements) fileManifest.push('requirements.txt');
  if (hasPyproject) fileManifest.push('pyproject.toml');
  if (hasRequirements || hasPyproject) {
    stack.language.push('python');
    const reqContent = await readFileSafe('requirements.txt');
    if (reqContent?.includes('fastapi')) stack.frameworks.push('fastapi');
    if (reqContent?.includes('django')) stack.frameworks.push('django');
  }

  // Docker
  if (await fileExists('Dockerfile')) { stack.containerization.push('docker'); fileManifest.push('Dockerfile'); }
  if (await fileExists('docker-compose.yml')) { stack.containerization.push('docker-compose'); fileManifest.push('docker-compose.yml'); }

  // Infrastructure
  const tfFiles = await glob('**/*.tf', { ignore: 'node_modules/**' });
  if (tfFiles.length > 0) { stack.infrastructure.push('terraform'); fileManifest.push(...tfFiles); }

  const helmFiles = await glob('**/Chart.yaml', { ignore: 'node_modules/**' });
  if (helmFiles.length > 0) { stack.infrastructure.push('helm'); fileManifest.push('Chart.yaml'); }
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

  // Mobile
  const gradleFiles = await glob('**/build.gradle.kts', { ignore: 'node_modules/**' });
  if (gradleFiles.length > 0) fileManifest.push('build.gradle.kts');
  const androidManifest = await glob('**/AndroidManifest.xml', { ignore: 'node_modules/**' });
  if (androidManifest.length > 0) fileManifest.push('AndroidManifest.xml');
  if (await fileExists('src/main/kotlin')) fileManifest.push('src/main/kotlin/');

  // iOS/Swift
  if (await fileExists('Package.swift')) fileManifest.push('Package.swift');
  const xcodeProjs = await glob('**/*.xcodeproj', { ignore: 'node_modules/**' });
  if (xcodeProjs.length > 0) fileManifest.push(xcodeProjs[0]);
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
  stack: StackInfo = { runtime: null, language: [], frameworks: [], containerization: [], infrastructure: [], ci: [], dependencies: {} },
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

  // Write agents_md if present
  if (pack.agents_md) {
    if (force) {
      await writeAlways('AGENTS.md', pack.agents_md);
      created.push('AGENTS.md');
    } else {
      if (await writeIfNotExists('AGENTS.md', pack.agents_md)) {
        created.push('AGENTS.md');
      } else {
        skipped.push('AGENTS.md');
      }
    }
  }

  // Always write project_context to .kiro/steering/project-context.md
  if (pack.project_context) {
    await writeAlways('.kiro/steering/project-context.md', pack.project_context);
    created.push('.kiro/steering/project-context.md');
  }

  // ── Cross-IDE generation (enterprise 2026 — AAIF pattern) ──
  // Generate CLAUDE.md, .cursor/rules/, .github/copilot-instructions.md
  // so governance works across ALL AI coding tools (Kiro + Claude Code + Cursor + Copilot + Codex)
  // AGENTS.md is already cross-IDE (Linux Foundation AAIF standard, read by Codex + Copilot)
  // References:
  // - CLAUDE.md: https://support.claude.com/en/articles/14553240 (<200 lines, concise)
  // - .cursor/rules: https://docs.cursor.com/context/rules (YAML frontmatter + markdown)
  // - AGENTS.md: https://agents.md/ (AAIF/Linux Foundation, cross-IDE)
  // - agentskills.io: https://agentskills.io/specification (progressive disclosure)

  // Extract key content for cross-IDE files
  const steeringContent = validSteering.map(f => f.content).join('\n\n');
  const agentsMdContent = pack.agents_md || '';

  // Detect build/test commands from stack for CLAUDE.md
  const installCmd = stack.runtime === 'node' ? 'npm install' : 'pip install -r requirements.txt';
  const lintCmd = stack.dependencies?.['eslint'] ? 'npm run lint'
    : stack.dependencies?.['ruff'] ? 'ruff check .'
    : stack.dependencies?.['black'] ? 'black --check .'
    : 'check package.json or Makefile';
  const testCmd = stack.dependencies?.['jest'] ? 'npm test'
    : stack.dependencies?.['vitest'] ? 'npx vitest --run'
    : stack.dependencies?.['pytest'] ? 'pytest'
    : stack.dependencies?.['mocha'] ? 'npm test'
    : 'check package.json or Makefile';
  const devCmd = stack.frameworks?.includes('nextjs') ? 'npm run dev'
    : stack.frameworks?.includes('fastapi') ? 'uvicorn app.main:app --reload'
    : 'npm run dev';

  // CLAUDE.md — Claude Code project instructions
  // Best practice: <200 lines, structured as "briefing for a new teammate"
  // Only include what the model CANNOT discover on its own
  const claudeMdContent = `# ${pack.project_context ? 'Project' : repoName}

## Build & Test Commands
- Install: \`${installCmd}\`
- Dev: \`${devCmd}\`
- Test: \`${testCmd}\`
- Lint: \`${lintCmd}\`

## Tech Stack
- Runtime: ${stack.runtime || 'unknown'}
- Language: ${stack.language?.join(', ') || 'unknown'}
- Frameworks: ${stack.frameworks?.join(', ') || 'none'}
- CI: ${stack.ci?.join(', ') || 'none'}

## Coding Standards
- Use Conventional Commits: type(scope): description
- Branch naming: type/TICKET-description
- Max function length: 50 lines
- Max file length: 500 lines
- Named exports only (no default exports)

## Security
- NEVER hardcode secrets, API keys, or credentials
- Use environment variables for all sensitive values
- All HTTP calls must use HTTPS in production
- Validate all user inputs
- Use parameterized queries (no string concatenation in SQL)

## DO NOT
- Do not auto-commit without explicit request
- Do not modify .env or credential files
- Do not remove existing tests
- Do not introduce new dependencies without justification
`;

  if (await writeIfNotExists('CLAUDE.md', claudeMdContent)) {
    created.push('CLAUDE.md');
  }

  // .cursor/rules/project.mdc — Cursor AI rules
  // Best practice: YAML frontmatter (description, globs, alwaysApply) + markdown body
  // alwaysApply:true = injected into every conversation
  const cursorRuleContent = `---
description: "Project coding standards and governance rules. Apply to all code generation, edits, and reviews in this project."
globs: "**/*"
alwaysApply: true
---

# Project Standards

## Tech Stack
- ${stack.runtime || 'unknown'} / ${stack.language?.join(', ') || 'unknown'}
- Frameworks: ${stack.frameworks?.join(', ') || 'none'}

## Conventions
- Conventional Commits format for all commits
- Branch naming: type/TICKET-description
- Max 400 lines per PR
- Named exports, no default exports
- Max 50 lines per function

## Security (non-negotiable)
- Never hardcode secrets or API keys
- Always validate user inputs
- HTTPS only in production
- Parameterized queries only

## Testing
- Unit tests required for business logic
- Run \`${testCmd}\` before committing
- Minimum 70% coverage target
`;

  await ensureDir('.cursor/rules');
  if (await writeIfNotExists('.cursor/rules/project.mdc', cursorRuleContent)) {
    created.push('.cursor/rules/project.mdc');
  }

  // .github/copilot-instructions.md — GitHub Copilot custom instructions
  // Best practice: same content as AGENTS.md (Copilot reads both)
  const copilotContent = agentsMdContent || `# Copilot Instructions

## Conventions
- Use Conventional Commits
- TypeScript strict mode (if applicable)
- Max 50 lines per function
- Always handle errors explicitly
- Never hardcode secrets

## Testing
- Write tests for new functionality
- Run: \`${testCmd}\`
`;

  await ensureDir('.github');
  if (await writeIfNotExists('.github/copilot-instructions.md', copilotContent)) {
    created.push('.github/copilot-instructions.md');
  }

  return { created, skipped };
}

// ── Auto-fill tech.md with detected stack ──

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
