import type { Command } from 'commander';
import path from 'node:path';
import ora from 'ora';
import chalk from 'chalk';
import { glob } from 'glob';
import { readFileSafe, readJsonSafe, fileExists, ensureDir, writeAlways } from '../utils/fs.js';
import { success, error, warn, heading, info } from '../utils/logger.js';
import { createApiClient } from '../utils/api-client.js';

interface ValidationResult {
  category: string;
  check: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
}

interface ValidationReport {
  timestamp: string;
  overall: 'pass' | 'fail';
  results: ValidationResult[];
  summary: { pass: number; fail: number; warn: number };
}

// ── Compliance Score Computation ─────────────────────────────────────

interface ComplianceScore {
  overall: number;  // 0-100
  security: number;
  architecture: number;
  observability: number;
  aaif: number;
}

const CATEGORY_WEIGHTS: Record<string, number> = {
  security: 0.30,
  architecture: 0.25,
  observability: 0.25,
  'aaif-structure': 0.20,
};

/**
 * Compute compliance score from validation results.
 * Groups results by category and computes weighted overall score.
 */
export function computeComplianceScore(results: ValidationResult[]): ComplianceScore {
  const categories: Record<string, { pass: number; total: number }> = {};

  for (const result of results) {
    if (!categories[result.category]) {
      categories[result.category] = { pass: 0, total: 0 };
    }
    categories[result.category].total++;
    if (result.status === 'pass') {
      categories[result.category].pass++;
    }
  }

  const categoryScore = (cat: string): number => {
    const data = categories[cat];
    if (!data || data.total === 0) return 0;
    return Math.round((data.pass / data.total) * 100);
  };

  const security = categoryScore('security');
  const architecture = categoryScore('architecture');
  const observability = categoryScore('observability');
  const aaif = categoryScore('aaif-structure');

  // Weighted overall score
  let overall = 0;
  overall += security * (CATEGORY_WEIGHTS['security'] ?? 0);
  overall += architecture * (CATEGORY_WEIGHTS['architecture'] ?? 0);
  overall += observability * (CATEGORY_WEIGHTS['observability'] ?? 0);
  overall += aaif * (CATEGORY_WEIGHTS['aaif-structure'] ?? 0);

  return {
    overall: Math.round(overall),
    security,
    architecture,
    observability,
    aaif,
  };
}

// ── AAIF Validation ─────────────────────────────────────────────────

// AGENTS.md validation — aligned with Linux Foundation AAIF standard (2026)
// Reference: https://agents.md (Agentic AI Foundation spec)
// Reference: codersera.com/blog/agents-md-complete-guide-2026
//
// The spec has NO required sections (vendor-neutral, plain markdown).
// Recommended sections: Overview, Commands/Build, Test, Code Style, Structure, Git, Security, Boundaries.
// Our generate produces: [Overview], Commands, Testing, Do Not (= boundaries).
//
// Validation: accept ANY of these common patterns as valid.
const AAIF_SECTION_SETS = [
  // Set A: Our AI-powered generation output (Commands + Testing + Do Not)
  ['Commands', 'Testing', 'Do Not'],
  // Set B: Full AAIF recommended (large repos)
  ['Overview', 'Commands', 'Testing', 'Conventions', 'Security'],
  // Set C: Alternative naming (used by some profiles)
  ['Build', 'Test', 'Conventions', 'Boundaries'],
  // Set D: Minimal valid (at least has commands and boundaries)
  ['Commands', 'Do Not'],
  // Set E: Legacy template names (backward compat)
  ['Project Identity', 'Agent Permissions', 'Coding Standards', 'Security'],
];

interface HookDefinition {
  name?: unknown;
  version?: unknown;
  when?: unknown;
  then?: unknown;
}

/**
 * Validate AAIF structure of AGENTS.md.
 * Accepts multiple valid section sets (generic template OR profile-based).
 */
export function validateAgentsMdSections(content: string): ValidationResult[] {
  const results: ValidationResult[] = [];
  const headingRegex = /^##\s+(.+)$/gm;
  const foundSections: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(content)) !== null) {
    foundSections.push(match[1].trim());
  }

  // Find the best matching section set
  let bestSet: string[] | null = null;
  let bestMatchCount = 0;

  for (const sectionSet of AAIF_SECTION_SETS) {
    const matchCount = sectionSet.filter(section =>
      foundSections.some(s => s.toLowerCase() === section.toLowerCase())
    ).length;
    if (matchCount > bestMatchCount) {
      bestMatchCount = matchCount;
      bestSet = sectionSet;
    }
  }

  // Use the best matching set for validation
  const targetSections = bestSet || AAIF_SECTION_SETS[0];

  for (const section of targetSections) {
    const found = foundSections.some(
      (s) => s.toLowerCase() === section.toLowerCase()
    );
    results.push({
      category: 'aaif-structure',
      check: `agents-md-section-${section.toLowerCase().replace(/\s+/g, '-')}`,
      status: found ? 'pass' : 'fail',
      message: found
        ? `AGENTS.md has section: ${section}`
        : `AGENTS.md missing section: ${section}`,
    });
  }

  return results;
}

/**
 * Validate governance file counts (steering, skills, hooks).
 */
export async function validateGovernanceFileCounts(): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  // Steering files
  const steeringFiles = await glob('.kiro/steering/**/*.md');
  if (steeringFiles.length >= 2) {
    results.push({
      category: 'aaif-structure',
      check: 'steering-file-count',
      status: 'pass',
      message: `.kiro/steering/ has ${steeringFiles.length} file(s) (minimum: 2)`,
    });
  } else {
    results.push({
      category: 'aaif-structure',
      check: 'steering-file-count',
      status: steeringFiles.length === 0 ? 'fail' : 'warn',
      message: `.kiro/steering/ has ${steeringFiles.length} file(s) (minimum recommended: 2)`,
    });
  }

  // Skills files
  const skillFiles = await glob('.kiro/skills/**/*.md');
  if (skillFiles.length >= 1) {
    results.push({
      category: 'aaif-structure',
      check: 'skills-file-count',
      status: 'pass',
      message: `.kiro/skills/ has ${skillFiles.length} file(s)`,
    });
  } else {
    results.push({
      category: 'aaif-structure',
      check: 'skills-file-count',
      status: 'warn',
      message: `.kiro/skills/ has no files (at least 1 recommended)`,
    });
  }

  // Hooks files
  const hookFiles = await glob('.kiro/hooks/**/*.json');
  if (hookFiles.length >= 1) {
    results.push({
      category: 'aaif-structure',
      check: 'hooks-file-count',
      status: 'pass',
      message: `.kiro/hooks/ has ${hookFiles.length} file(s)`,
    });
  } else {
    results.push({
      category: 'aaif-structure',
      check: 'hooks-file-count',
      status: 'warn',
      message: `.kiro/hooks/ has no files (at least 1 recommended)`,
    });
  }

  return results;
}

/**
 * Validate hook JSON files have required fields and are valid JSON.
 */
export async function validateHookFiles(): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  const hookFiles = await glob('.kiro/hooks/**/*.json');

  for (const hookFile of hookFiles) {
    const content = await readFileSafe(hookFile);
    if (!content) {
      results.push({
        category: 'aaif-structure',
        check: `hook-valid-json`,
        status: 'fail',
        message: `${hookFile}: could not read file`,
      });
      continue;
    }

    let parsed: HookDefinition;
    try {
      parsed = JSON.parse(content) as HookDefinition;
    } catch {
      results.push({
        category: 'aaif-structure',
        check: `hook-valid-json`,
        status: 'fail',
        message: `${hookFile}: invalid JSON`,
      });
      continue;
    }

    const requiredFields = ['name', 'version', 'when', 'then'] as const;
    const missingFields = requiredFields.filter(
      (field) => parsed[field] === undefined || parsed[field] === null
    );

    if (missingFields.length === 0) {
      results.push({
        category: 'aaif-structure',
        check: `hook-valid-json`,
        status: 'pass',
        message: `${hookFile}: valid hook with all required fields`,
      });
    } else {
      results.push({
        category: 'aaif-structure',
        check: `hook-valid-json`,
        status: 'fail',
        message: `${hookFile}: missing required fields: ${missingFields.join(', ')}`,
      });
    }
  }

  return results;
}

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate security, architecture, AAIF structure, and observability compliance')
    .option('--ci', 'CI mode - exit with code 1 on failure')
    .action(async (options: { ci?: boolean }) => {
      heading('AI Governance — Validate');

      const spinner = ora('Running validation checks...').start();
      const results: ValidationResult[] = [];

      try {
        // Security checks
        spinner.text = 'Checking security...';

        // Check .env in git
        const envFiles = await glob('**/.env', { ignore: ['node_modules/**', '.git/**', '**/node_modules/**'] });
        const gitignoreContent = await readFileSafe('.gitignore');
        for (const envFile of envFiles) {
          const isIgnored = gitignoreContent?.includes('.env') ?? false;
          results.push({
            category: 'security',
            check: 'env-files-gitignored',
            status: isIgnored ? 'pass' : 'fail',
            message: isIgnored
              ? `.env files are in .gitignore`
              : `${envFile} may not be in .gitignore`,
          });
        }

        // Check for hardcoded secrets patterns
        const sourceFiles = await glob('**/*.{ts,js,py,yaml,yml}', {
          ignore: ['node_modules/**', '.git/**', 'dist/**', '**/node_modules/**'],
        });

        const secretPatterns = [
          /(?:password|secret|api_key|apikey|token)\s*[:=]\s*["'][^"']{8,}["']/i,
          /AKIA[0-9A-Z]{16}/,
          /-----BEGIN (?:RSA )?PRIVATE KEY-----/,
        ];

        let secretsFound = 0;
        for (const file of sourceFiles.slice(0, 100)) {
          const content = await readFileSafe(file);
          if (!content) continue;
          for (const pattern of secretPatterns) {
            if (pattern.test(content)) {
              secretsFound++;
              break;
            }
          }
        }

        results.push({
          category: 'security',
          check: 'hardcoded-secrets',
          status: secretsFound === 0 ? 'pass' : 'fail',
          message: secretsFound === 0
            ? 'No hardcoded secrets detected'
            : `Potential hardcoded secrets found in ${secretsFound} file(s)`,
        });

        // Check IAM wildcards in Terraform
        const tfFiles = await glob('infra/terraform/**/*.tf');
        let iamWildcards = false;
        for (const tfFile of tfFiles) {
          const content = await readFileSafe(tfFile);
          if (content && /actions\s*=\s*\["?\*"?\]/.test(content)) {
            iamWildcards = true;
            break;
          }
        }
        results.push({
          category: 'security',
          check: 'iam-wildcards',
          status: iamWildcards ? 'fail' : 'pass',
          message: iamWildcards
            ? 'IAM wildcard actions detected in Terraform files'
            : 'No IAM wildcard actions found',
        });

        // Architecture checks
        spinner.text = 'Checking architecture...';

        results.push({
          category: 'architecture',
          check: 'governance-config',
          status: (await fileExists('.ai-governance.json')) ? 'pass' : 'fail',
          message: (await fileExists('.ai-governance.json'))
            ? '.ai-governance.json exists'
            : '.ai-governance.json missing - run `ai-gov init`',
        });

        results.push({
          category: 'architecture',
          check: 'agents-md',
          status: (await fileExists('AGENTS.md')) ? 'pass' : 'fail',
          message: (await fileExists('AGENTS.md'))
            ? 'AGENTS.md exists'
            : 'AGENTS.md missing - run `ai-gov init`',
        });

        results.push({
          category: 'architecture',
          check: 'kiro-structure',
          status: (await fileExists('.kiro/steering')) ? 'pass' : 'warn',
          message: (await fileExists('.kiro/steering'))
            ? '.kiro/steering/ exists'
            : '.kiro/steering/ missing',
        });

        // AAIF Structure validation
        spinner.text = 'Checking AAIF structure...';

        const agentsMdContent = await readFileSafe('AGENTS.md');
        if (agentsMdContent) {
          const sectionResults = validateAgentsMdSections(agentsMdContent);
          results.push(...sectionResults);
        }

        const fileCountResults = await validateGovernanceFileCounts();
        results.push(...fileCountResults);

        const hookResults = await validateHookFiles();
        results.push(...hookResults);

        // Observability checks
        spinner.text = 'Checking observability...';

        const pyFiles = await glob('**/*.py', { ignore: ['node_modules/**', '.git/**', '**/venv/**'] });
        let hasStructuredLogging = false;
        for (const pyFile of pyFiles.slice(0, 50)) {
          const content = await readFileSafe(pyFile);
          if (content?.includes('structlog')) {
            hasStructuredLogging = true;
            break;
          }
        }

        if (pyFiles.length > 0) {
          results.push({
            category: 'observability',
            check: 'structured-logging',
            status: hasStructuredLogging ? 'pass' : 'warn',
            message: hasStructuredLogging
              ? 'Structured logging (structlog) detected'
              : 'No structured logging detected in Python files',
          });
        }

        const hasHealthEndpoint = await (async () => {
          for (const pyFile of pyFiles.slice(0, 50)) {
            const content = await readFileSafe(pyFile);
            if (content?.includes('/health')) return true;
          }
          return false;
        })();

        if (pyFiles.length > 0) {
          results.push({
            category: 'observability',
            check: 'health-endpoints',
            status: hasHealthEndpoint ? 'pass' : 'warn',
            message: hasHealthEndpoint
              ? 'Health endpoint detected'
              : 'No /health endpoint found',
          });
        }

        // Build report
        const summary = {
          pass: results.filter((r) => r.status === 'pass').length,
          fail: results.filter((r) => r.status === 'fail').length,
          warn: results.filter((r) => r.status === 'warn').length,
        };

        const report: ValidationReport = {
          timestamp: new Date().toISOString(),
          overall: summary.fail > 0 ? 'fail' : 'pass',
          results,
          summary,
        };

        await ensureDir('.ai-governance');
        await writeAlways('.ai-governance/validation-report.json', JSON.stringify(report, null, 2) + '\n');

        spinner.succeed('Validation complete');

        // Print results
        console.log('');
        for (const result of results) {
          const icon = result.status === 'pass' ? chalk.green('✔') : result.status === 'fail' ? chalk.red('✖') : chalk.yellow('⚠');
          console.log(`  ${icon} [${result.category}] ${result.message}`);
        }

        console.log('');
        console.log(`  ${chalk.green(`Pass: ${summary.pass}`)}  ${chalk.red(`Fail: ${summary.fail}`)}  ${chalk.yellow(`Warn: ${summary.warn}`)}`);
        console.log('');
        info('Report saved to .ai-governance/validation-report.json');

        // ── Compliance Score Computation & Reporting ──────────────────
        const score = computeComplianceScore(results);
        console.log('');
        info(`Compliance Score: ${score.overall}% (security: ${score.security}%, architecture: ${score.architecture}%, observability: ${score.observability}%, aaif: ${score.aaif}%)`);

        // Report to orchestrator (best-effort, never affects exit code)
        // Pattern: Vercel CLI → Vercel API, Terraform CLI → TFC API
        // Auth resolution priority: stored credentials > .ai-governance.json > env var
        try {
          const meta = await readJsonSafe<Record<string, unknown>>('.ai-discovery/meta.json');
          const config = await readJsonSafe<Record<string, unknown>>('.ai-governance.json');
          const api = createApiClient();
          const isOnline = await api.healthCheck();

          if (isOnline) {
            // Resolve org_id from stored auth (ai-gov login) or config
            const { getOrgId } = await import('./login.js');
            const resolvedOrgId = await getOrgId() || (config?.org_id as string) || undefined;

            await api.submitScore({
              repo_id: (config?.repo_id as string) || (meta?.repo_name as string) || path.basename(process.cwd()),
              repo_name: path.basename(process.cwd()),
              overall_score: score.overall,
              security_score: score.security,
              architecture_score: score.architecture,
              observability_score: score.observability,
              aaif_score: score.aaif,
              check_results: report,
              profile: (meta?.profile_recommended as string) || (config?.profile as string) || undefined,
              country: (config?.country as string) || undefined,
              team: (config?.team as string) || undefined,
              org_id: resolvedOrgId,
            });
            info('Compliance score reported to governance platform');
          } else {
            warn('Governance platform unreachable — score saved locally only');
          }
        } catch {
          warn('Governance platform unreachable — score saved locally only');
        }

        if (summary.fail > 0 && options.ci) {
          process.exit(1);
        }

        // ── FIX 12: Generate remediation plan for feedback loop ──
        // Pattern: Terraform plan → apply, ESLint --fix
        // Creates .ai-governance/remediation.json that `ai-gov generate --fix` can consume
        const failedResults = results.filter(r => r.status === 'fail');
        if (failedResults.length > 0) {
          const remediation = {
            generated_at: new Date().toISOString(),
            score: score.overall,
            missing: failedResults
              .filter(r => r.message.includes('not found') || r.message.includes('missing'))
              .map(r => ({
                type: r.category === 'security' ? 'steering' : r.category === 'aaif-structure' ? 'agents_md' : 'steering',
                category: r.category,
                reason: r.message,
              })),
            outdated: failedResults
              .filter(r => r.message.includes('outdated') || r.message.includes('stale'))
              .map(r => ({
                path: r.check,
                reason: r.message,
              })),
            suggestions: failedResults.map(r => r.message),
          };
          await writeAlways('.ai-governance/remediation.json', JSON.stringify(remediation, null, 2) + '\n');
          console.log('');
          info('Remediation plan saved to .ai-governance/remediation.json');
          console.log(chalk.dim('  Run `ai-gov generate --force` to regenerate missing governance files'));
        }
      } catch (err) {
        spinner.fail('Validation failed');
        throw err;
      }
    });
}
