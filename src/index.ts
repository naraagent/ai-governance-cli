import { Command } from 'commander';
import chalk from 'chalk';
import { registerInitCommand } from './commands/init.js';
import { registerDiscoverCommand } from './commands/discover.js';
import { registerGenerateCommand } from './commands/generate.js';
import { registerValidateCommand } from './commands/validate.js';
import { registerSyncCommand } from './commands/sync.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerUpdateCommand } from './commands/update.js';
import { registerRolloutCommand } from './commands/rollout.js';
import { registerSkillsCommand } from './commands/skills.js';

const program = new Command();

program
  .name('ai-gov')
  .description(
    `${chalk.hex('#00A94F').bold('FEMSA AI Governance CLI')} — Enterprise agent governance for Kiro, Claude Code & AAIF

  Manages .kiro/steering, AGENTS.md, skills, hooks, and compliance validation.
  Standards: MCP 2025-06-18 · A2A 1.0 · OAuth 2.1 · OWASP Agentic Top 10 · AAIF`
  )
  .version('1.2.0')
  .addHelpText('after', `
${chalk.dim('Workflow (2 steps):')}
  ${chalk.dim('1.')} ai-gov init                        Initialize governance structure
  ${chalk.dim('2.')} ai-gov generate --country CL       Auto-detect + generate steering/skills/hooks

${chalk.dim('CI/CD:')}
  ai-gov validate --ci                 Check compliance (exit 1 on failure)

${chalk.dim('Skills:')}
  ai-gov skills list                   List installed skills (agentskills.io)
  ai-gov skills validate               Validate skills against spec

${chalk.dim('Other:')}
  ai-gov doctor                        Health check local governance
  ai-gov sync                          Sync state with platform
  ai-gov rollout --country CL          Batch deploy to multiple repos

${chalk.dim('More info:')} https://github.com/naraagent/ai-governance-templates
`);

registerInitCommand(program);
registerDiscoverCommand(program);
registerGenerateCommand(program);
registerValidateCommand(program);
registerSyncCommand(program);
registerDoctorCommand(program);
registerUpdateCommand(program);
registerRolloutCommand(program);
registerSkillsCommand(program);

program.parse();
