import type { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import path from 'node:path';
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
}

// ── Internal: Stack Detection (replaces standalone `discover`) ──

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
  };

  // Node.js / package.json
  const pkgJson = await readJsonSafe<Record<string, unknown>>('package.json');
  if (pkgJson) {
    fileManifest.push('package.json');
    stack.runtime = 'node';
    stack.language.push('typescript');

    const deps = {
      ...(pkgJson.dependencies as Record<string, string> || {}),
      ...(pkgJson.devDependencies as Record<string, string> || {}),
    };

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

  return { stack, fileManifest, repoName };
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

      // ── Step 3: Fetch profile templates (backend or fallback) ──
      spinner.text = `Loading profile: ${profileName}...`;
      const profileFiles = await fetchProfileFiles(profileName, country);

      // v2.0: If backend/profiles unavailable, use inline minimal fallback templates
      const useInlineFallback = !profileFiles;
      if (useInlineFallback) {
        spinner.text = `Profile "${profileName}" — using inline fallback templates`;
      }

      // ── Step 4: Write files to .kiro/ ──
      spinner.text = 'Writing governance files...';
      await ensureDir('.kiro/steering');
      await ensureDir('.kiro/skills');
      await ensureDir('.kiro/hooks');

      const created: string[] = [];
      const skipped: string[] = [];

      if (useInlineFallback) {
        // Inline fallback: generate minimal project-context.md and security.md
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
      } else {
        // Backend-provided profile files
        // Write AGENTS.md (from profile, overwrites generic one from init)
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

      // ── Summary ──
      console.log('');
      console.log(chalk.hex('#00A94F')('  ┌─────────────────────────────────────────────────────┐'));
      console.log(chalk.hex('#00A94F')('  │') + chalk.bold('  Governance Generated                              ') + chalk.hex('#00A94F')('│'));
      console.log(chalk.hex('#00A94F')('  ├─────────────────────────────────────────────────────┤'));
      console.log(chalk.hex('#00A94F')('  │') + `  Profile:  ${chalk.bold(profileName)}` + ' '.repeat(Math.max(0, 39 - profileName.length)) + chalk.hex('#00A94F')('│'));
      if (country) {
        console.log(chalk.hex('#00A94F')('  │') + `  Country:  ${country}` + ' '.repeat(Math.max(0, 39 - country.length)) + chalk.hex('#00A94F')('│'));
      }
      console.log(chalk.hex('#00A94F')('  │') + `  Stack:    ${(stack.frameworks.join(', ') || stack.runtime || 'unknown').substring(0, 39)}` + ' '.repeat(Math.max(0, 39 - (stack.frameworks.join(', ') || stack.runtime || 'unknown').length)) + chalk.hex('#00A94F')('│'));
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
