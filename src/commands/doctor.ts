import type { Command } from 'commander';
import chalk from 'chalk';
import { fileExists, getLastModified, readJsonSafe } from '../utils/fs.js';
import { heading } from '../utils/logger.js';

interface CheckResult {
  label: string;
  passed: boolean;
  detail: string;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check health of AI governance setup')
    .action(async () => {
      heading('AI Governance — Doctor');

      const checks: CheckResult[] = [];

      // Check .kiro/ structure
      checks.push({
        label: '.kiro/ directory',
        passed: await fileExists('.kiro'),
        detail: await fileExists('.kiro') ? 'exists' : 'missing - run `ai-gov init`',
      });

      checks.push({
        label: '.kiro/steering/',
        passed: await fileExists('.kiro/steering'),
        detail: await fileExists('.kiro/steering') ? 'exists' : 'missing',
      });

      checks.push({
        label: '.kiro/skills/',
        passed: await fileExists('.kiro/skills'),
        detail: await fileExists('.kiro/skills') ? 'exists' : 'missing',
      });

      // Check .ai-context/ freshness
      const contextFiles = [
        'current-state.md',
        'active-work.md',
        'known-risks.md',
        'architecture-summary.md',
      ];

      for (const file of contextFiles) {
        const filePath = `.ai-context/${file}`;
        const exists = await fileExists(filePath);
        let detail = 'missing';

        if (exists) {
          const lastMod = await getLastModified(filePath);
          if (lastMod) {
            const daysSince = Math.floor((Date.now() - lastMod.getTime()) / (1000 * 60 * 60 * 24));
            detail = daysSince > 7 ? `stale (${daysSince} days old)` : `fresh (${daysSince}d ago)`;
          } else {
            detail = 'exists';
          }
        }

        checks.push({
          label: `.ai-context/${file}`,
          passed: exists,
          detail,
        });
      }

      // Check AGENTS.md
      checks.push({
        label: 'AGENTS.md',
        passed: await fileExists('AGENTS.md'),
        detail: await fileExists('AGENTS.md') ? 'exists' : 'missing - run `ai-gov init`',
      });

      // Check .ai-governance.json
      const config = await readJsonSafe<Record<string, unknown>>('.ai-governance.json');
      checks.push({
        label: '.ai-governance.json',
        passed: config !== null,
        detail: config ? `v${config.version}` : 'missing - run `ai-gov init`',
      });

      // Check version
      if (config) {
        const isCurrent = config.version === '0.1.0';
        checks.push({
          label: 'Config version',
          passed: isCurrent,
          detail: isCurrent ? 'up to date' : `${config.version} → 0.1.0 available`,
        });
      }

      // Print results
      console.log('');
      let passCount = 0;
      let failCount = 0;

      for (const check of checks) {
        const icon = check.passed ? chalk.green('✔') : chalk.red('✖');
        console.log(`  ${icon} ${check.label} — ${chalk.dim(check.detail)}`);
        if (check.passed) passCount++;
        else failCount++;
      }

      console.log('');
      console.log(`  ${chalk.bold('Health:')} ${chalk.green(`${passCount} passed`)}${failCount > 0 ? `, ${chalk.red(`${failCount} issues`)}` : ''}`);

      if (failCount === 0) {
        console.log(`  ${chalk.green('All checks passed. Governance setup is healthy.')}`);
      } else {
        console.log(`  ${chalk.yellow('Run `ai-gov init` to fix missing structure.')}`);
      }
      console.log('');
    });
}
