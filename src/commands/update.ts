import type { Command } from 'commander';
import chalk from 'chalk';
import { heading, info } from '../utils/logger.js';

export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .description('Update governance templates from registry')
    .action(async () => {
      heading('AI Governance — Update');

      console.log('');
      info(chalk.yellow('Update from template registry coming in v0.2.0'));
      console.log('');
      console.log(chalk.dim('Planned features:'));
      console.log(chalk.dim('  - Pull latest steering templates from CodeArtifact'));
      console.log(chalk.dim('  - Update skills from enterprise registry'));
      console.log(chalk.dim('  - Merge with local customizations'));
      console.log('');
    });
}
