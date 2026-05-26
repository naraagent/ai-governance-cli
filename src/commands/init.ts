import type { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { ensureDir, writeIfNotExists, fileExists, writeAlways } from '../utils/fs.js';
import { success, warn, heading, info, error } from '../utils/logger.js';
import { AGENTS_MD_TEMPLATE } from '../templates/agents-md.js';
import {
  PRODUCT_MD,
  SECURITY_MD,
} from '../templates/steering-foundations.js';

// ── FEMSA Enterprise Branding ──

const FEMSA_BANNER = `
${chalk.hex('#00A94F')('╔══════════════════════════════════════════════════════════════════╗')}
${chalk.hex('#00A94F')('║')}                                                                  ${chalk.hex('#00A94F')('║')}
${chalk.hex('#00A94F')('║')}   ${chalk.bold.hex('#00A94F')('███████╗███████╗███╗   ███╗███████╗ █████╗ ')}              ${chalk.hex('#00A94F')('║')}
${chalk.hex('#00A94F')('║')}   ${chalk.bold.hex('#00A94F')('██╔════╝██╔════╝████╗ ████║██╔════╝██╔══██╗')}              ${chalk.hex('#00A94F')('║')}
${chalk.hex('#00A94F')('║')}   ${chalk.bold.hex('#00A94F')('█████╗  █████╗  ██╔████╔██║███████╗███████║')}              ${chalk.hex('#00A94F')('║')}
${chalk.hex('#00A94F')('║')}   ${chalk.bold.hex('#00A94F')('██╔══╝  ██╔══╝  ██║╚██╔╝██║╚════██║██╔══██║')}              ${chalk.hex('#00A94F')('║')}
${chalk.hex('#00A94F')('║')}   ${chalk.bold.hex('#00A94F')('██║     ███████╗██║ ╚═╝ ██║███████║██║  ██║')}              ${chalk.hex('#00A94F')('║')}
${chalk.hex('#00A94F')('║')}   ${chalk.bold.hex('#00A94F')('╚═╝     ╚══════╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝')}              ${chalk.hex('#00A94F')('║')}
${chalk.hex('#00A94F')('║')}                                                                  ${chalk.hex('#00A94F')('║')}
${chalk.hex('#00A94F')('║')}   ${chalk.bold('AI Governance Platform')} ${chalk.dim('v0.5.0')}                              ${chalk.hex('#00A94F')('║')}
${chalk.hex('#00A94F')('║')}   ${chalk.dim('Enterprise AI Agent Governance · MCP · A2A · AAIF')}          ${chalk.hex('#00A94F')('║')}
${chalk.hex('#00A94F')('║')}                                                                  ${chalk.hex('#00A94F')('║')}
${chalk.hex('#00A94F')('╚══════════════════════════════════════════════════════════════════╝')}
`;

// ── Auto-detect repo identity ──

interface RepoIdentity {
  workspace: string;
  repoName: string;
  fullId: string;
  provider: 'bitbucket' | 'github' | 'gitlab' | 'azure-devops' | 'unknown';
  remoteUrl: string;
}

/**
 * Auto-detect repository identity from git remote.
 * Enterprise standard: Azure DevOps CLI, Claude Code, Entire.io pattern.
 */
function detectRepoIdentity(): RepoIdentity | null {
  try {
    const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();

    let workspace = '';
    let repoName = '';
    let provider: RepoIdentity['provider'] = 'unknown';

    // SSH format: git@host:workspace/repo.git
    const sshMatch = remoteUrl.match(/git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
    if (sshMatch) {
      workspace = sshMatch[2];
      repoName = sshMatch[3];
      provider = detectProvider(sshMatch[1]);
    }

    // HTTPS format: https://host/workspace/repo.git
    if (!sshMatch) {
      const httpsMatch = remoteUrl.match(/https?:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/);
      if (httpsMatch) {
        workspace = httpsMatch[2];
        repoName = httpsMatch[3];
        provider = detectProvider(httpsMatch[1]);
      }
    }

    if (workspace && repoName) {
      return { workspace, repoName, fullId: `${workspace}/${repoName}`, provider, remoteUrl };
    }
    return null;
  } catch {
    return null;
  }
}

function detectProvider(host: string): RepoIdentity['provider'] {
  if (host.includes('bitbucket')) return 'bitbucket';
  if (host.includes('github')) return 'github';
  if (host.includes('gitlab')) return 'gitlab';
  if (host.includes('dev.azure') || host.includes('visualstudio')) return 'azure-devops';
  return 'unknown';
}

// ── Init Command ──

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize AI governance structure (AGENTS.md + .kiro/steering + hooks)')
    .option('--repo-id <id>', 'Override auto-detected repository ID (workspace/repo)')
    .option('--force', 'Overwrite existing configuration')
    .option('--no-banner', 'Skip the FEMSA banner')
    .action(async (options: { repoId?: string; force?: boolean; banner?: boolean }) => {
      // Show enterprise branding
      if (options.banner !== false) {
        console.log(FEMSA_BANNER);
      }

      heading('Initializing AI Governance');

      const configPath = '.ai-governance.json';
      const alreadyInitialized = await fileExists(configPath);

      if (alreadyInitialized && !options.force) {
        warn('Already initialized (.ai-governance.json exists). Use --force to reinitialize.');
        return;
      }

      // ── Step 1: Detect repository identity ──
      let repoId: string;
      let repoIdentity: RepoIdentity | null = null;

      if (options.repoId) {
        repoId = options.repoId;
        info(`Using provided repo ID: ${chalk.bold(repoId)}`);
      } else {
        repoIdentity = detectRepoIdentity();
        if (repoIdentity) {
          repoId = repoIdentity.fullId;
          info(`Auto-detected: ${chalk.bold(repoId)} (${repoIdentity.provider})`);
        } else {
          const dirName = path.basename(process.cwd());
          repoId = `local/${dirName}`;
          warn(`No git remote found. Using directory name: ${chalk.bold(repoId)}`);
          info('Tip: Add a git remote or pass --repo-id to set explicitly.');
        }
      }

      console.log('');

      // ── Step 2: Create governance structure ──
      const spinner = ora('Creating governance structure...').start();
      const created: string[] = [];

      try {
        // ── .kiro/ directories ──
        await ensureDir('.kiro/steering');
        await ensureDir('.kiro/skills');
        await ensureDir('.kiro/hooks');
        await ensureDir('.kiro/specs');

        // ── AGENTS.md (cross-IDE standard — read by Kiro, Claude, Cursor, Copilot) ──
        spinner.text = 'Creating AGENTS.md...';
        if (options.force) {
          await writeAlways('AGENTS.md', AGENTS_MD_TEMPLATE);
          created.push('AGENTS.md');
        } else {
          if (await writeIfNotExists('AGENTS.md', AGENTS_MD_TEMPLATE)) {
            created.push('AGENTS.md');
          }
        }

        // ── .kiro/steering/ foundational files (Kiro reads ALWAYS) ──
        spinner.text = 'Creating steering foundations...';

        const steeringFiles: Array<[string, string]> = [
          ['.kiro/steering/product.md', PRODUCT_MD],
        ];

        for (const [filePath, content] of steeringFiles) {
          if (options.force) {
            await writeAlways(filePath, content);
            created.push(filePath);
          } else {
            if (await writeIfNotExists(filePath, content)) {
              created.push(filePath);
            }
          }
        }

        // ── .ai-governance.json (CLI/platform config) ──
        spinner.text = 'Creating governance config...';
        const config = {
          version: '1.4.1',
          repo_id: repoId,
          ...(repoIdentity ? {
            provider: repoIdentity.provider,
            remote_url: repoIdentity.remoteUrl,
          } : {}),
          profile: null,
          country: null,
          initialized_at: new Date().toISOString(),
          last_sync: null,
        };
        await writeAlways(configPath, JSON.stringify(config, null, 2) + '\n');
        created.push(configPath);

        spinner.succeed('Governance structure initialized');

        // ── Summary ──
        console.log('');
        console.log(chalk.hex('#00A94F')('  ┌─────────────────────────────────────────────────────┐'));
        console.log(chalk.hex('#00A94F')('  │') + chalk.bold('  Repository Governance Initialized                  ') + chalk.hex('#00A94F')('│'));
        console.log(chalk.hex('#00A94F')('  ├─────────────────────────────────────────────────────┤'));
        console.log(chalk.hex('#00A94F')('  │') + `  Repo:     ${chalk.bold(repoId)}` + ' '.repeat(Math.max(0, 39 - repoId.length)) + chalk.hex('#00A94F')('│'));
        if (repoIdentity) {
          console.log(chalk.hex('#00A94F')('  │') + `  Provider: ${repoIdentity.provider}` + ' '.repeat(Math.max(0, 39 - repoIdentity.provider.length)) + chalk.hex('#00A94F')('│'));
        }
        console.log(chalk.hex('#00A94F')('  │') + `  Version:  ${config.version}` + ' '.repeat(Math.max(0, 39 - config.version.length)) + chalk.hex('#00A94F')('│'));
        console.log(chalk.hex('#00A94F')('  └─────────────────────────────────────────────────────┘'));

        console.log('');
        console.log(chalk.bold('  Files created:'));
        console.log('');

        // Group by purpose
        const agentsFiles = created.filter(f => f === 'AGENTS.md');
        const steeringCreated = created.filter(f => f.startsWith('.kiro/steering/'));
        const configFiles = created.filter(f => f === '.ai-governance.json');

        if (agentsFiles.length > 0) {
          success('AGENTS.md                    → Cross-IDE agent rules (Kiro + Claude + Cursor + Copilot)');
        }
        if (steeringCreated.length > 0) {
          for (const f of steeringCreated) {
            const name = f.replace('.kiro/steering/', '');
            const desc = name === 'product.md' ? 'Product overview (Kiro reads always)'
              : name === 'tech.md' ? 'Technology stack (Kiro reads always)'
              : name === 'structure.md' ? 'Project structure (Kiro reads always)'
              : name === 'security.md' ? 'Security policy (Kiro reads always)'
              : 'Steering file';
            success(`${f.padEnd(28)} → ${desc}`);
          }
        }
        if (configFiles.length > 0) {
          success('.ai-governance.json          → CLI & platform config');
        }

        console.log('');
        console.log(chalk.dim('  Directories ready: .kiro/skills/ .kiro/hooks/ .kiro/specs/'));

        // ── Auto-generate: detect stack + generate governance pack (Kiro/Codex pattern 2026) ──
        // Industry standard: init should produce contextual output, not empty templates.
        // Reference: Kiro generates product.md/tech.md/structure.md contextually on first use.
        // Reference: Codex generates AGENTS.md from repo analysis on first session.
        console.log('');

        try {
          const { execSync } = await import('node:child_process');
          // Call generate internally (same CLI, no network hop)
          execSync('node ' + process.argv[1] + ' generate' + (options.force ? ' --force' : ''), {
            cwd: process.cwd(),
            stdio: 'inherit',
            env: process.env,
          });
        } catch {
          // Generate failed (no network, backend down) — not fatal for init
          console.log('');
          warn('Auto-generate skipped (backend unreachable). Run `ai-gov generate` later.');
        }

        console.log('');
        success('Done. Governance initialized and generated.');
        console.log(chalk.dim('  To validate compliance: npx @femsa/ai-governance validate'));
        console.log('');
      } catch (err) {
        spinner.fail('Initialization failed');
        throw err;
      }
    });
}
