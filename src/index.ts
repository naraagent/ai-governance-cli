#!/usr/bin/env node

import { Command } from 'commander';
import { registerInitCommand } from './commands/init.js';
import { registerDiscoverCommand } from './commands/discover.js';
import { registerGenerateCommand } from './commands/generate.js';
import { registerValidateCommand } from './commands/validate.js';
import { registerSyncCommand } from './commands/sync.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerUpdateCommand } from './commands/update.js';
import { registerRolloutCommand } from './commands/rollout.js';

const program = new Command();

program
  .name('ai-gov')
  .description('Enterprise AI Governance CLI — manage steering, context, and validation')
  .version('0.4.0');

registerInitCommand(program);
registerDiscoverCommand(program);
registerGenerateCommand(program);
registerValidateCommand(program);
registerSyncCommand(program);
registerDoctorCommand(program);
registerUpdateCommand(program);
registerRolloutCommand(program);

program.parse();
