import type { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { glob } from 'glob';
import { readFileSafe, fileExists, ensureDir, writeAlways } from '../utils/fs.js';
import { success, error, warn, heading, info } from '../utils/logger.js';

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

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate security, architecture, and observability compliance')
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

        if (summary.fail > 0 && options.ci) {
          process.exit(1);
        }
      } catch (err) {
        spinner.fail('Validation failed');
        throw err;
      }
    });
}
