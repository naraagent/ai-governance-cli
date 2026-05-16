import type { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { ensureDir, writeIfNotExists, fileExists, writeAlways } from '../utils/fs.js';
import { success, warn, heading } from '../utils/logger.js';
import { AGENTS_MD_TEMPLATE } from '../templates/agents-md.js';
import {
  CURRENT_STATE_MD,
  ACTIVE_WORK_MD,
  KNOWN_RISKS_MD,
  ARCHITECTURE_SUMMARY_MD,
  NEXT_STEPS_MD,
  DEPLOYMENT_STATUS_MD,
  OPERATIONAL_NOTES_MD,
} from '../templates/ai-context.js';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize AI governance structure in the current repository')
    .option('--force', 'Overwrite existing configuration')
    .action(async (options: { force?: boolean }) => {
      heading('AI Governance — Initialize');

      const configPath = '.ai-governance.json';
      const alreadyInitialized = await fileExists(configPath);

      if (alreadyInitialized && !options.force) {
        warn('Already initialized (.ai-governance.json exists). Use --force to reinitialize.');
        return;
      }

      const spinner = ora('Creating governance structure...').start();

      try {
        // Create .kiro/ structure
        await ensureDir('.kiro/steering');
        await ensureDir('.kiro/skills');
        await ensureDir('.kiro/specs');
        spinner.text = 'Created .kiro/ directory structure';

        // Create .ai-context/ with templates
        const contextFiles: Array<[string, string]> = [
          ['.ai-context/current-state.md', CURRENT_STATE_MD],
          ['.ai-context/active-work.md', ACTIVE_WORK_MD],
          ['.ai-context/known-risks.md', KNOWN_RISKS_MD],
          ['.ai-context/architecture-summary.md', ARCHITECTURE_SUMMARY_MD],
          ['.ai-context/next-steps.md', NEXT_STEPS_MD],
          ['.ai-context/deployment-status.md', DEPLOYMENT_STATUS_MD],
          ['.ai-context/operational-notes.md', OPERATIONAL_NOTES_MD],
        ];

        for (const [filePath, content] of contextFiles) {
          if (options.force) {
            await writeAlways(filePath, content);
          } else {
            await writeIfNotExists(filePath, content);
          }
        }
        spinner.text = 'Created .ai-context/ templates';

        // Create AGENTS.md
        if (options.force) {
          await writeAlways('AGENTS.md', AGENTS_MD_TEMPLATE);
        } else {
          await writeIfNotExists('AGENTS.md', AGENTS_MD_TEMPLATE);
        }
        spinner.text = 'Created AGENTS.md';

        // Create .ai-governance.json config
        const config = {
          version: '0.1.0',
          profile: 'enterprise',
          initialized_at: new Date().toISOString(),
          last_sync: new Date().toISOString(),
          features: {
            steering: true,
            skills: true,
            context: true,
            validation: true,
          },
        };
        await writeAlways(configPath, JSON.stringify(config, null, 2) + '\n');

        spinner.succeed('Governance structure initialized');

        console.log('');
        success('Created .kiro/steering/');
        success('Created .kiro/skills/');
        success('Created .kiro/specs/');
        success('Created .ai-context/ (7 template files)');
        success('Created AGENTS.md');
        success('Created .ai-governance.json');
        console.log('');
        console.log(chalk.dim('Next step: run `ai-gov discover` to detect your stack'));
      } catch (err) {
        spinner.fail('Initialization failed');
        throw err;
      }
    });
}
