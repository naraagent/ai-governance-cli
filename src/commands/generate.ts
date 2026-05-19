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
const BACKEND_TIMEOUT_MS = 10_000;

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

// ── Backend API Call (Task 6.1) ──

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
  const timeoutId = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);

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
      return data;
    }

    // Non-200 response → fall through to fallback
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
): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];

  // Write steering files
  for (const file of pack.steering_files) {
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
  for (const file of pack.skill_files) {
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

  // Write hook files
  for (const file of pack.hook_files) {
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

      // ── Step 3: Try backend API call (Task 6.1) ──
      spinner.text = 'Connecting to governance platform...';

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
        const result = await writeGovernancePack(backendResponse.governance_pack, options.force || false);
        created = result.created;
        skipped = result.skipped;
      } else {
        // Task 6.2: Fallback mode
        warn('Backend unreachable — using minimal fallback governance');

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
