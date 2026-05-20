/**
 * `ai-gov skills` — List, inspect, and validate installed Agent Skills.
 *
 * Follows agentskills.io specification (2025-12-18).
 * Skills are directories containing SKILL.md with YAML frontmatter.
 *
 * Commands:
 *   ai-gov skills list          List all installed skills
 *   ai-gov skills validate      Validate skills against agentskills.io spec
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

interface SkillMetadata {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  path: string;
  valid: boolean;
  errors: string[];
}

function parseSkillFrontmatter(content: string): Record<string, any> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const yaml = match[1];
  const result: Record<string, any> = {};

  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Remove quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function validateSkillName(name: string): string[] {
  const errors: string[] = [];
  if (!name) { errors.push('name is required'); return errors; }
  if (name.length > 64) errors.push('name must be ≤ 64 characters');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) errors.push('name must be lowercase alphanumeric with hyphens, no leading/trailing hyphens');
  if (name.includes('--')) errors.push('name must not contain consecutive hyphens');
  return errors;
}

function findSkillDirs(baseDir: string): string[] {
  const dirs: string[] = [];
  const searchPaths = [
    join(baseDir, '.kiro', 'skills'),
    join(baseDir, 'skills'),
  ];

  for (const searchPath of searchPaths) {
    if (!existsSync(searchPath)) continue;
    const entries = readdirSync(searchPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillMd = join(searchPath, entry.name, 'SKILL.md');
        if (existsSync(skillMd)) {
          dirs.push(join(searchPath, entry.name));
        }
      }
      // Also support flat .md files (legacy)
      if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md') {
        dirs.push(join(searchPath, entry.name));
      }
    }
  }
  return dirs;
}

function loadSkill(skillPath: string): SkillMetadata {
  const errors: string[] = [];
  let content: string;
  let isDir = false;

  try {
    if (existsSync(join(skillPath, 'SKILL.md'))) {
      content = readFileSync(join(skillPath, 'SKILL.md'), 'utf-8');
      isDir = true;
    } else if (skillPath.endsWith('.md')) {
      content = readFileSync(skillPath, 'utf-8');
    } else {
      return { name: '?', description: '', path: skillPath, valid: false, errors: ['No SKILL.md found'] };
    }
  } catch {
    return { name: '?', description: '', path: skillPath, valid: false, errors: ['Cannot read file'] };
  }

  const fm = parseSkillFrontmatter(content);

  // Validate required fields
  if (!fm.name) errors.push('missing required field: name');
  if (!fm.description) errors.push('missing required field: description');
  if (fm.name) errors.push(...validateSkillName(fm.name));
  if (fm.description && fm.description.length > 1024) errors.push('description must be ≤ 1024 characters');

  // Check directory name matches skill name (spec requirement)
  if (isDir && fm.name) {
    const dirName = skillPath.split(/[/\\]/).pop() || '';
    if (dirName !== fm.name) {
      errors.push(`directory name "${dirName}" must match skill name "${fm.name}"`);
    }
  }

  // Check for "Use when" pattern in description (best practice)
  if (fm.description && !fm.description.toLowerCase().includes('use when') && !fm.description.toLowerCase().includes('when')) {
    errors.push('description should include "Use when..." trigger pattern (best practice)');
  }

  return {
    name: fm.name || '?',
    description: fm.description || '',
    license: fm.license,
    compatibility: fm.compatibility,
    metadata: fm.metadata ? { raw: fm.metadata } : undefined,
    path: skillPath,
    valid: errors.length === 0,
    errors,
  };
}

export function registerSkillsCommand(program: Command): void {
  const skills = program
    .command('skills')
    .description('Manage and inspect Agent Skills (agentskills.io spec)');

  skills
    .command('list')
    .description('List installed skills in current project')
    .option('--json', 'Output as JSON')
    .action((opts) => {
      const cwd = process.cwd();
      const skillDirs = findSkillDirs(cwd);

      if (skillDirs.length === 0) {
        console.log(chalk.yellow('No skills found.'));
        console.log(chalk.dim('Skills should be in .kiro/skills/<name>/SKILL.md'));
        return;
      }

      const skills = skillDirs.map(loadSkill);

      if (opts.json) {
        console.log(JSON.stringify(skills, null, 2));
        return;
      }

      console.log(chalk.bold(`\n📦 Installed Skills (${skills.length})\n`));
      console.log(chalk.dim('Format: agentskills.io spec'));
      console.log();

      for (const skill of skills) {
        const status = skill.valid ? chalk.green('✓') : chalk.red('✗');
        const name = skill.valid ? chalk.white.bold(skill.name) : chalk.red.bold(skill.name);
        console.log(`  ${status} ${name}`);
        console.log(`    ${chalk.dim(skill.description.slice(0, 80))}${skill.description.length > 80 ? '...' : ''}`);
        if (!skill.valid) {
          for (const err of skill.errors) {
            console.log(`    ${chalk.red('⚠')} ${err}`);
          }
        }
        console.log();
      }

      const valid = skills.filter(s => s.valid).length;
      const invalid = skills.length - valid;
      console.log(chalk.dim(`${valid} valid, ${invalid} invalid`));
    });

  skills
    .command('validate')
    .description('Validate all skills against agentskills.io specification')
    .action(() => {
      const cwd = process.cwd();
      const skillDirs = findSkillDirs(cwd);

      if (skillDirs.length === 0) {
        console.log(chalk.yellow('No skills found to validate.'));
        process.exit(0);
      }

      const skills = skillDirs.map(loadSkill);
      let hasErrors = false;

      console.log(chalk.bold(`\n🔍 Validating ${skills.length} skills against agentskills.io spec\n`));

      for (const skill of skills) {
        if (skill.valid) {
          console.log(`  ${chalk.green('✓')} ${skill.name}`);
        } else {
          hasErrors = true;
          console.log(`  ${chalk.red('✗')} ${skill.name}`);
          for (const err of skill.errors) {
            console.log(`    ${chalk.red('→')} ${err}`);
          }
        }
      }

      console.log();
      if (hasErrors) {
        console.log(chalk.red('Validation failed. Fix errors above.'));
        process.exit(1);
      } else {
        console.log(chalk.green('All skills valid ✓'));
      }
    });
}
