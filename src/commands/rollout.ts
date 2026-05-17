import type { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { execSync } from 'node:child_process';
import { success, error, heading, info, warn } from '../utils/logger.js';

// ── Types ──

interface RolloutOptions {
  dryRun: boolean;
  country?: 'CL' | 'CO' | 'EC' | 'MX';
  profile?: string;
  force: boolean;
  concurrency: number;
}

interface RepoEntry {
  slug: string;
  full_name: string;
  clone_url: string;
  mainbranch?: string;
}

interface RolloutRepoState {
  status: 'processed' | 'failed' | 'skipped';
  prUrl?: string;
  error?: string;
  timestamp: string;
}

interface RolloutStateFile {
  version: 1;
  workspace: string;
  lastRun: string;
  repos: Record<string, RolloutRepoState>;
}

// ── Constants ──

const BB_API_BASE = 'https://api.bitbucket.org/2.0';
const BB_WORKSPACE = 'digitaldifarma';
const STATE_DIR = '.ai-governance';
const STATE_FILE = `${STATE_DIR}/rollout-state.json`;
const MAX_CONCURRENCY = 5;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 60000;

// ── Bitbucket API helpers ──

function getBitbucketAuth(): { user: string; password: string } {
  const user = process.env.BB_USER;
  const password = process.env.BB_APP_PASSWORD;
  if (!user || !password) {
    throw new Error(
      'Missing Bitbucket credentials. Set BB_USER and BB_APP_PASSWORD environment variables.'
    );
  }
  return { user, password };
}

function authHeader(user: string, password: string): string {
  return 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithBackoff(
  url: string,
  options: RequestInit,
  maxRetries = 3
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);

    if (res.status === 429) {
      if (attempt >= maxRetries) {
        throw new Error(`Rate limited after ${maxRetries} retries: ${url}`);
      }
      const backoff = Math.min(
        BACKOFF_BASE_MS * Math.pow(2, attempt) + Math.random() * 1000,
        BACKOFF_MAX_MS
      );
      await sleep(backoff);
      continue;
    }

    return res;
  }

  throw new Error(`Failed to fetch after retries: ${url}`);
}

async function listAllRepos(
  user: string,
  password: string
): Promise<RepoEntry[]> {
  const repos: RepoEntry[] = [];
  let url: string | null =
    `${BB_API_BASE}/repositories/${BB_WORKSPACE}?pagelen=100`;

  while (url) {
    const res = await fetchWithBackoff(url, {
      headers: { Authorization: authHeader(user, password) },
    });

    if (!res.ok) {
      throw new Error(`Bitbucket API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    for (const repo of data.values || []) {
      const cloneLink = repo.links?.clone?.find(
        (l: { name: string; href: string }) => l.name === 'https'
      );
      repos.push({
        slug: repo.slug,
        full_name: repo.full_name,
        clone_url: cloneLink?.href || '',
        mainbranch: repo.mainbranch?.name || 'main',
      });
    }

    url = data.next || null;
  }

  return repos;
}

async function repoHasKiroDir(
  slug: string,
  user: string,
  password: string
): Promise<boolean> {
  const url = `${BB_API_BASE}/repositories/${BB_WORKSPACE}/${slug}/src/HEAD/.kiro/`;
  const res = await fetchWithBackoff(url, {
    headers: { Authorization: authHeader(user, password) },
  });
  return res.status === 200;
}

async function createPullRequest(
  slug: string,
  branch: string,
  targetBranch: string,
  title: string,
  description: string,
  user: string,
  password: string
): Promise<string> {
  const url = `${BB_API_BASE}/repositories/${BB_WORKSPACE}/${slug}/pullrequests`;
  const res = await fetchWithBackoff(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader(user, password),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title,
      description,
      source: { branch: { name: branch } },
      destination: { branch: { name: targetBranch } },
      close_source_branch: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PR creation failed for ${slug}: ${res.status} — ${body}`);
  }

  const data = await res.json();
  return data.links?.html?.href || '';
}

// ── State Management ──

async function loadState(): Promise<RolloutStateFile> {
  if (await fs.pathExists(STATE_FILE)) {
    return await fs.readJson(STATE_FILE);
  }
  return {
    version: 1,
    workspace: BB_WORKSPACE,
    lastRun: new Date().toISOString(),
    repos: {},
  };
}

async function saveState(state: RolloutStateFile): Promise<void> {
  await fs.ensureDir(STATE_DIR);
  await fs.writeJson(STATE_FILE, state, { spaces: 2 });
}

// ── Process single repo ──

async function processRepo(
  repo: RepoEntry,
  options: RolloutOptions,
  user: string,
  password: string
): Promise<{ status: 'processed' | 'failed' | 'skipped'; prUrl?: string; error?: string }> {
  const tmpDir = path.join(os.tmpdir(), `ai-gov-rollout-${repo.slug}-${Date.now()}`);

  try {
    // Clone
    const cloneUrl = repo.clone_url.replace(
      'https://',
      `https://${user}:${password}@`
    );
    execSync(`git clone --depth 1 "${cloneUrl}" "${tmpDir}"`, {
      stdio: 'pipe',
      timeout: 120_000,
    });

    // Check for existing .kiro/ dir
    if (!options.force && (await fs.pathExists(path.join(tmpDir, '.kiro')))) {
      return { status: 'skipped' };
    }

    // Run ai-gov discover
    try {
      execSync('npx ai-gov discover', {
        cwd: tmpDir,
        stdio: 'pipe',
        timeout: 60_000,
      });
    } catch {
      // discover is best-effort, continue with generate
    }

    // Run ai-gov generate
    const generateArgs: string[] = ['npx ai-gov generate --force'];
    if (options.profile) generateArgs.push(`--profile ${options.profile}`);
    if (options.country) generateArgs.push(`--country ${options.country}`);

    execSync(generateArgs.join(' '), {
      cwd: tmpDir,
      stdio: 'pipe',
      timeout: 60_000,
    });

    // Create branch and commit
    const branchName = `ai-governance/rollout-${Date.now()}`;
    execSync(`git checkout -b "${branchName}"`, { cwd: tmpDir, stdio: 'pipe' });
    execSync('git add -A', { cwd: tmpDir, stdio: 'pipe' });

    try {
      execSync('git commit -m "chore: add AI governance configuration"', {
        cwd: tmpDir,
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'AI Governance Bot',
          GIT_AUTHOR_EMAIL: 'ai-governance@femsa.com',
          GIT_COMMITTER_NAME: 'AI Governance Bot',
          GIT_COMMITTER_EMAIL: 'ai-governance@femsa.com',
        },
      });
    } catch {
      // Nothing to commit
      return { status: 'skipped' };
    }

    // Push branch
    execSync(`git push origin "${branchName}"`, { cwd: tmpDir, stdio: 'pipe', timeout: 60_000 });

    // Create PR
    const prUrl = await createPullRequest(
      repo.slug,
      branchName,
      repo.mainbranch || 'main',
      'chore: Add AI Governance configuration',
      `## AI Governance Rollout\n\nThis PR adds AI governance configuration files generated by \`ai-gov generate\`.\n\n${options.profile ? `**Profile:** ${options.profile}` : ''}\n${options.country ? `**Country:** ${options.country}` : ''}`,
      user,
      password
    );

    return { status: 'processed', prUrl };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'failed', error: message };
  } finally {
    // Always cleanup temp dir
    await fs.remove(tmpDir).catch(() => {});
  }
}

// ── Sequential/concurrent processing ──

async function processRepos(
  repos: RepoEntry[],
  options: RolloutOptions,
  user: string,
  password: string,
  state: RolloutStateFile
): Promise<{ processed: number; failed: number; skipped: number }> {
  let processed = 0;
  let failed = 0;
  let skipped = 0;

  const concurrency = Math.min(Math.max(options.concurrency, 1), MAX_CONCURRENCY);

  if (concurrency === 1) {
    // Sequential
    for (const repo of repos) {
      const result = await processRepo(repo, options, user, password);
      state.repos[repo.slug] = {
        status: result.status,
        prUrl: result.prUrl,
        error: result.error,
        timestamp: new Date().toISOString(),
      };
      await saveState(state);

      if (result.status === 'processed') processed++;
      else if (result.status === 'failed') failed++;
      else skipped++;
    }
  } else {
    // Concurrent with limit
    const chunks: RepoEntry[][] = [];
    for (let i = 0; i < repos.length; i += concurrency) {
      chunks.push(repos.slice(i, i + concurrency));
    }

    for (const chunk of chunks) {
      const results = await Promise.all(
        chunk.map((repo) => processRepo(repo, options, user, password))
      );

      for (let i = 0; i < chunk.length; i++) {
        const repo = chunk[i];
        const result = results[i];
        state.repos[repo.slug] = {
          status: result.status,
          prUrl: result.prUrl,
          error: result.error,
          timestamp: new Date().toISOString(),
        };

        if (result.status === 'processed') processed++;
        else if (result.status === 'failed') failed++;
        else skipped++;
      }
      await saveState(state);
    }
  }

  return { processed, failed, skipped };
}

// ── Command Registration ──

export function registerRolloutCommand(program: Command): void {
  program
    .command('rollout')
    .description('Roll out AI governance to all Bitbucket repositories')
    .option('--dry-run', 'List affected repos without making changes', false)
    .option('--country <code>', 'Country filter (CL, CO, EC, MX)')
    .option('--profile <name>', 'Override profile for all repos')
    .option('--force', 'Process repos even if they have existing .kiro/', false)
    .option('--concurrency <n>', 'Number of repos to process in parallel (max 5)', '1')
    .action(async (opts: {
      dryRun: boolean;
      country?: string;
      profile?: string;
      force: boolean;
      concurrency: string;
    }) => {
      heading('AI Governance — Rollout');

      const options: RolloutOptions = {
        dryRun: opts.dryRun,
        country: opts.country as RolloutOptions['country'],
        profile: opts.profile,
        force: opts.force,
        concurrency: Math.min(parseInt(opts.concurrency, 10) || 1, MAX_CONCURRENCY),
      };

      // Validate country
      if (options.country && !['CL', 'CO', 'EC', 'MX'].includes(options.country)) {
        error(`Invalid country "${options.country}". Valid: CL, CO, EC, MX`);
        process.exit(1);
      }

      const spinner = ora('Authenticating with Bitbucket...').start();

      let user: string;
      let password: string;
      try {
        ({ user, password } = getBitbucketAuth());
        spinner.succeed('Bitbucket authenticated');
      } catch (err) {
        spinner.fail((err as Error).message);
        process.exit(1);
      }

      // Load state for resumption
      const state = await loadState();

      // List repos
      spinner.start('Listing repositories...');
      let repos: RepoEntry[];
      try {
        repos = await listAllRepos(user, password);
        spinner.succeed(`Found ${repos.length} repositories`);
      } catch (err) {
        spinner.fail(`Failed to list repos: ${(err as Error).message}`);
        process.exit(1);
      }

      // Filter: skip already processed
      const alreadyProcessed = new Set(
        Object.entries(state.repos)
          .filter(([, v]) => v.status === 'processed')
          .map(([k]) => k)
      );

      repos = repos.filter((r) => !alreadyProcessed.has(r.slug));

      if (alreadyProcessed.size > 0) {
        info(`Skipping ${alreadyProcessed.size} previously processed repos (from state file)`);
      }

      // Filter: skip repos with .kiro/ unless --force
      if (!options.force) {
        spinner.start('Checking repos for existing .kiro/ directories...');
        const filtered: RepoEntry[] = [];
        for (const repo of repos) {
          try {
            const hasKiro = await repoHasKiroDir(repo.slug, user, password);
            if (!hasKiro) {
              filtered.push(repo);
            } else {
              state.repos[repo.slug] = {
                status: 'skipped',
                timestamp: new Date().toISOString(),
              };
            }
          } catch {
            // On error checking, include the repo
            filtered.push(repo);
          }
        }
        repos = filtered;
        spinner.succeed(`${repos.length} repos to process (others skipped — have .kiro/)`);
      }

      // Dry run
      if (options.dryRun) {
        console.log('');
        info('DRY RUN — No changes will be made');
        console.log('');
        info(`Repos to process: ${repos.length}`);
        for (const repo of repos) {
          console.log(`  ${chalk.dim('•')} ${repo.full_name}`);
        }
        console.log('');
        info(`Options: profile=${options.profile ?? 'auto'}, country=${options.country ?? 'none'}, force=${options.force}`);
        return;
      }

      // Process repos
      console.log('');
      info(`Processing ${repos.length} repos (concurrency: ${options.concurrency})...`);
      console.log('');

      state.lastRun = new Date().toISOString();
      const { processed, failed, skipped } = await processRepos(
        repos,
        options,
        user,
        password,
        state
      );

      await saveState(state);

      // Summary report
      console.log('');
      heading('Rollout Summary');
      console.log('');
      success(`Processed: ${processed}`);
      if (skipped > 0) warn(`Skipped: ${skipped}`);
      if (failed > 0) error(`Failed: ${failed}`);
      console.log('');
      info(`Total repos in workspace: ${repos.length + alreadyProcessed.size}`);
      info(`State saved to ${STATE_FILE}`);

      if (failed > 0) {
        console.log('');
        warn('Failed repos:');
        for (const [slug, entry] of Object.entries(state.repos)) {
          if (entry.status === 'failed') {
            console.log(`  ${chalk.red('✗')} ${slug}: ${entry.error ?? 'Unknown error'}`);
          }
        }
      }
    });
}
