import type { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { glob } from 'glob';
import { readFileSafe, fileExists, writeAlways, readJsonSafe } from '../utils/fs.js';
import { success, error, heading, info } from '../utils/logger.js';

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .description('Sync .ai-context/ with current repository state')
    .action(async () => {
      heading('AI Governance — Sync');

      if (!(await fileExists('.ai-context'))) {
        error('.ai-context/ directory not found. Run `ai-gov init` first.');
        process.exit(1);
      }

      const spinner = ora('Syncing context...').start();

      try {
        // Read existing context files
        const currentState = await readFileSafe('.ai-context/current-state.md');
        const activeWork = await readFileSafe('.ai-context/active-work.md');

        // Check for active specs
        spinner.text = 'Checking active specs...';
        const specFiles = await glob('.kiro/specs/**/*.md');
        const specSummary = specFiles.length > 0
          ? specFiles.map((f) => `- ${f}`).join('\n')
          : '- No active specs found';

        // Check discovery data
        const stack = await readJsonSafe<Record<string, unknown>>('.ai-discovery/stack.json');
        const stackSummary = stack
          ? `Detected: ${JSON.stringify(stack.frameworks || [])}`
          : 'Discovery not run yet';

        // Check governance config
        const config = await readJsonSafe<Record<string, unknown>>('.ai-governance.json');
        const lastSync = config?.last_sync as string || 'unknown';

        // Update current-state.md
        const updatedState = `# Current State

> Last synced: ${new Date().toISOString()}

## System Status
- Stack: ${stackSummary}
- Governance version: ${config?.version || 'unknown'}
- Last sync: ${lastSync}

## Active Specs
${specSummary}

## AI Governance Structure
- .kiro/steering/: ${(await glob('.kiro/steering/*.md')).length} file(s)
- .kiro/skills/: ${(await glob('.kiro/skills/*.md')).length} file(s)
- .ai-context/: synced

## Notes
_Updated automatically by \`ai-gov sync\`._
`;

        await writeAlways('.ai-context/current-state.md', updatedState);

        // Update last_sync in config
        if (config) {
          config.last_sync = new Date().toISOString();
          await writeAlways('.ai-governance.json', JSON.stringify(config, null, 2) + '\n');
        }

        spinner.succeed('Context synchronized');

        console.log('');
        success('Updated .ai-context/current-state.md');
        info(`Active specs: ${specFiles.length}`);
        info(`Steering files: ${(await glob('.kiro/steering/*.md')).length}`);
        info(`Skills files: ${(await glob('.kiro/skills/*.md')).length}`);
        console.log('');
        console.log(chalk.dim('Context is up to date for AI agents.'));
        console.log(chalk.dim('Commit these files to share context with your team (git-is-the-sync pattern).'));
      } catch (err) {
        spinner.fail('Sync failed');
        throw err;
      }
    });
}
