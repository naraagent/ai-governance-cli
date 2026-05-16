import type { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { glob } from 'glob';
import { readJsonSafe, readFileSafe, fileExists, ensureDir, writeAlways } from '../utils/fs.js';
import { success, info, heading } from '../utils/logger.js';

interface StackInfo {
  runtime: string | null;
  language: string[];
  frameworks: string[];
  containerization: string[];
  infrastructure: string[];
  ci: string[];
  detected_at: string;
}

interface ArchitectureInfo {
  services: string[];
  databases: string[];
  messaging: string[];
  monitoring: string[];
  detected_at: string;
}

interface RiskInfo {
  items: Array<{ category: string; description: string; severity: string }>;
  detected_at: string;
}

export function registerDiscoverCommand(program: Command): void {
  program
    .command('discover')
    .description('Discover project stack, architecture, and potential risks')
    .action(async () => {
      heading('AI Governance — Discover');

      const spinner = ora('Scanning project...').start();

      try {
        const stack: StackInfo = {
          runtime: null,
          language: [],
          frameworks: [],
          containerization: [],
          infrastructure: [],
          ci: [],
          detected_at: new Date().toISOString(),
        };

        const architecture: ArchitectureInfo = {
          services: [],
          databases: [],
          messaging: [],
          monitoring: [],
          detected_at: new Date().toISOString(),
        };

        const risks: RiskInfo = {
          items: [],
          detected_at: new Date().toISOString(),
        };

        // Detect Node.js / package.json
        spinner.text = 'Checking package.json...';
        const pkgJson = await readJsonSafe<Record<string, unknown>>('package.json');
        if (pkgJson) {
          stack.runtime = 'node';
          stack.language.push('typescript');

          const deps = {
            ...(pkgJson.dependencies as Record<string, string> || {}),
            ...(pkgJson.devDependencies as Record<string, string> || {}),
          };

          if (deps['next']) stack.frameworks.push('nextjs');
          if (deps['express']) stack.frameworks.push('express');
          if (deps['fastify']) stack.frameworks.push('fastify');
          if (deps['react']) stack.frameworks.push('react');
        }

        // Check for Python (FastAPI, etc.)
        const requirementsTxt = await fileExists('requirements.txt');
        const pyprojectToml = await fileExists('pyproject.toml');
        if (requirementsTxt || pyprojectToml) {
          stack.language.push('python');
          const reqContent = await readFileSafe('requirements.txt');
          if (reqContent?.includes('fastapi')) stack.frameworks.push('fastapi');
          if (reqContent?.includes('django')) stack.frameworks.push('django');
          if (reqContent?.includes('flask')) stack.frameworks.push('flask');
        }

        // Detect containerization
        spinner.text = 'Checking containerization...';
        if (await fileExists('Dockerfile')) stack.containerization.push('docker');
        if (await fileExists('docker-compose.yml')) stack.containerization.push('docker-compose');

        const dockerfiles = await glob('**/Dockerfile*', { ignore: 'node_modules/**' });
        if (dockerfiles.length > 1) {
          architecture.services = dockerfiles.map((f) => f.replace(/\/Dockerfile.*$/, ''));
        }

        // Detect infrastructure
        spinner.text = 'Checking infrastructure...';
        const tfFiles = await glob('infra/terraform/**/*.tf');
        if (tfFiles.length > 0) stack.infrastructure.push('terraform');

        const helmFiles = await glob('infra/helm/**/Chart.yaml');
        if (helmFiles.length > 0) stack.infrastructure.push('helm');

        const k8sFiles = await glob('**/k8s/**/*.{yaml,yml}', { ignore: 'node_modules/**' });
        if (k8sFiles.length > 0) stack.infrastructure.push('kubernetes');

        // Detect CI
        spinner.text = 'Checking CI/CD...';
        if (await fileExists('.github/workflows')) stack.ci.push('github-actions');
        const ghWorkflows = await glob('.github/workflows/*.{yml,yaml}');
        if (ghWorkflows.length > 0) stack.ci.push('github-actions');

        if (await fileExists('Jenkinsfile')) stack.ci.push('jenkins');
        if (await fileExists('.gitlab-ci.yml')) stack.ci.push('gitlab-ci');

        // Detect databases
        const dcContent = await readFileSafe('docker-compose.yml');
        if (dcContent) {
          if (dcContent.includes('postgres')) architecture.databases.push('postgresql');
          if (dcContent.includes('redis')) architecture.messaging.push('redis');
          if (dcContent.includes('minio')) architecture.services.push('minio');
          if (dcContent.includes('jaeger')) architecture.monitoring.push('jaeger');
          if (dcContent.includes('traefik')) architecture.services.push('traefik');
        }

        // Detect risks
        spinner.text = 'Checking for risks...';
        const envFiles = await glob('**/.env', { ignore: ['node_modules/**', '.git/**'] });
        if (envFiles.length > 0) {
          risks.items.push({
            category: 'security',
            description: `.env files found: ${envFiles.join(', ')}. Ensure they are in .gitignore.`,
            severity: 'high',
          });
        }

        const tfContent = await readFileSafe('infra/terraform/main.tf');
        if (tfContent?.includes('*') && tfContent?.includes('Action')) {
          risks.items.push({
            category: 'security',
            description: 'Potential IAM wildcard actions detected in Terraform.',
            severity: 'medium',
          });
        }

        // Write outputs
        spinner.text = 'Writing discovery results...';
        await ensureDir('.ai-discovery');
        await writeAlways('.ai-discovery/stack.json', JSON.stringify(stack, null, 2) + '\n');
        await writeAlways('.ai-discovery/architecture.json', JSON.stringify(architecture, null, 2) + '\n');
        await writeAlways('.ai-discovery/risks.json', JSON.stringify(risks, null, 2) + '\n');

        spinner.succeed('Discovery complete');

        console.log('');
        info(`Runtime: ${stack.runtime || 'unknown'}`);
        info(`Languages: ${stack.language.join(', ') || 'none detected'}`);
        info(`Frameworks: ${stack.frameworks.join(', ') || 'none detected'}`);
        info(`Containerization: ${stack.containerization.join(', ') || 'none detected'}`);
        info(`Infrastructure: ${stack.infrastructure.join(', ') || 'none detected'}`);
        info(`CI/CD: ${stack.ci.join(', ') || 'none detected'}`);

        if (risks.items.length > 0) {
          console.log('');
          console.log(chalk.yellow(`⚠ ${risks.items.length} risk(s) detected. See .ai-discovery/risks.json`));
        }

        console.log('');
        success('Results written to .ai-discovery/');
        console.log(chalk.dim('Next step: run `ai-gov generate` to create steering files'));
      } catch (err) {
        spinner.fail('Discovery failed');
        throw err;
      }
    });
}
