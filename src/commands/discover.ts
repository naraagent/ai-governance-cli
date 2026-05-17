import type { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import path from 'node:path';
import { glob } from 'glob';
import { readJsonSafe, readFileSafe, fileExists, ensureDir, writeAlways } from '../utils/fs.js';
import { success, info, heading } from '../utils/logger.js';
import { matchProfile } from './profile-matcher.js';
import type { MatchResult } from './profile-registry.js';

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
    .option('--repo-id <repoId>', 'Repository identifier (org/repo-name)')
    .action(async (options: { repoId?: string }) => {
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

        // Build file manifest during Phase 1
        const fileManifest: string[] = [];

        // Derive repoName from options or current directory
        let repoName: string;
        if (options.repoId) {
          const parts = options.repoId.split('/');
          repoName = parts[parts.length - 1];
        } else {
          repoName = path.basename(process.cwd());
        }

        // Detect Node.js / package.json
        spinner.text = 'Checking package.json...';
        const pkgJson = await readJsonSafe<Record<string, unknown>>('package.json');
        if (pkgJson) {
          fileManifest.push('package.json');
          stack.runtime = 'node';
          stack.language.push('typescript');

          const deps = {
            ...(pkgJson.dependencies as Record<string, string> || {}),
            ...(pkgJson.devDependencies as Record<string, string> || {}),
          };

          if (deps['next']) {
            stack.frameworks.push('nextjs');
            fileManifest.push('next'); // marker for profile matcher
          }
          if (deps['express']) stack.frameworks.push('express');
          if (deps['fastify']) stack.frameworks.push('fastify');
          if (deps['react']) {
            stack.frameworks.push('react');
            fileManifest.push('react'); // marker for profile matcher
          }
        }

        // Check for Python (FastAPI, etc.)
        const requirementsTxt = await fileExists('requirements.txt');
        const pyprojectToml = await fileExists('pyproject.toml');
        if (requirementsTxt) fileManifest.push('requirements.txt');
        if (pyprojectToml) fileManifest.push('pyproject.toml');
        if (requirementsTxt || pyprojectToml) {
          stack.language.push('python');
          const reqContent = await readFileSafe('requirements.txt');
          if (reqContent?.includes('fastapi')) stack.frameworks.push('fastapi');
          if (reqContent?.includes('django')) stack.frameworks.push('django');
          if (reqContent?.includes('flask')) stack.frameworks.push('flask');
        }

        // Detect containerization
        spinner.text = 'Checking containerization...';
        if (await fileExists('Dockerfile')) {
          stack.containerization.push('docker');
          fileManifest.push('Dockerfile');
        }
        if (await fileExists('docker-compose.yml')) {
          stack.containerization.push('docker-compose');
          fileManifest.push('docker-compose.yml');
        }
        if (await fileExists('docker-compose.yaml')) {
          fileManifest.push('docker-compose.yaml');
        }

        const dockerfiles = await glob('**/Dockerfile*', { ignore: 'node_modules/**' });
        if (dockerfiles.length > 1) {
          architecture.services = dockerfiles.map((f) => f.replace(/\/Dockerfile.*$/, ''));
        }

        // Detect infrastructure
        spinner.text = 'Checking infrastructure...';
        const tfFiles = await glob('**/*.tf', { ignore: 'node_modules/**' });
        if (tfFiles.length > 0) {
          stack.infrastructure.push('terraform');
          for (const tf of tfFiles) {
            fileManifest.push(tf);
          }
        }

        const helmChartFiles = await glob('**/Chart.yaml', { ignore: 'node_modules/**' });
        if (helmChartFiles.length > 0) {
          stack.infrastructure.push('helm');
          fileManifest.push('Chart.yaml');
        }

        if (await fileExists('values.yaml')) {
          fileManifest.push('values.yaml');
        }

        const k8sFiles = await glob('**/k8s/**/*.{yaml,yml}', { ignore: 'node_modules/**' });
        if (k8sFiles.length > 0) stack.infrastructure.push('kubernetes');

        // Check for templates/ directory (Helm)
        if (await fileExists('templates')) {
          fileManifest.push('templates/');
        }

        // Detect serverless
        const serverlessFiles = ['serverless.yml', 'serverless.yaml', 'template.yaml', 'template.yml'];
        for (const sf of serverlessFiles) {
          if (await fileExists(sf)) {
            fileManifest.push(sf);
          }
        }

        // Detect CI
        spinner.text = 'Checking CI/CD...';
        if (await fileExists('.github/workflows')) {
          stack.ci.push('github-actions');
          fileManifest.push('.github/workflows');
        }
        const ghWorkflows = await glob('.github/workflows/*.{yml,yaml}');
        if (ghWorkflows.length > 0 && !stack.ci.includes('github-actions')) {
          stack.ci.push('github-actions');
        }

        if (await fileExists('Jenkinsfile')) {
          stack.ci.push('jenkins');
          fileManifest.push('Jenkinsfile');
        }
        if (await fileExists('.gitlab-ci.yml')) {
          stack.ci.push('gitlab-ci');
          fileManifest.push('.gitlab-ci.yml');
        }

        // Detect mobile platforms
        const gradleFiles = await glob('**/build.gradle.kts', { ignore: 'node_modules/**' });
        if (gradleFiles.length > 0) fileManifest.push('build.gradle.kts');
        const gradleGroovyFiles = await glob('**/build.gradle', { ignore: 'node_modules/**' });
        if (gradleGroovyFiles.length > 0) fileManifest.push('build.gradle');

        const androidManifest = await glob('**/AndroidManifest.xml', { ignore: 'node_modules/**' });
        if (androidManifest.length > 0) fileManifest.push('AndroidManifest.xml');

        // Detect Kotlin/Java source dirs
        if (await fileExists('src/main/kotlin')) fileManifest.push('src/main/kotlin/');
        if (await fileExists('src/main/java')) fileManifest.push('src/main/java/');

        // Detect iOS/Swift
        if (await fileExists('Package.swift')) fileManifest.push('Package.swift');
        const xcodeProjs = await glob('**/*.xcodeproj', { ignore: 'node_modules/**' });
        if (xcodeProjs.length > 0) fileManifest.push(xcodeProjs[0]);
        if (await fileExists('Sources')) fileManifest.push('Sources/');
        const swiftFiles = await glob('Sources/**/*.swift', { ignore: 'node_modules/**' });
        for (const sf of swiftFiles) {
          fileManifest.push(sf);
        }

        // Detect Next.js config files
        const nextConfigs = ['next.config.js', 'next.config.mjs', 'next.config.ts'];
        for (const nc of nextConfigs) {
          if (await fileExists(nc)) fileManifest.push(nc);
        }
        if (await fileExists('next-env.d.ts')) fileManifest.push('next-env.d.ts');

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

        // Profile detection using ProfileMatcher
        let profileRecommended = 'generic';
        let enriched = false;
        let matchResult: MatchResult | null = null;

        // Use ProfileMatcher instead of inline detection
        const matchResultValue = matchProfile(fileManifest, repoName);
        matchResult = matchResultValue;
        profileRecommended = matchResultValue.profile;

        // Write outputs
        spinner.text = 'Writing discovery results...';
        await ensureDir('.ai-discovery');
        await writeAlways('.ai-discovery/stack.json', JSON.stringify(stack, null, 2) + '\n');
        await writeAlways('.ai-discovery/architecture.json', JSON.stringify(architecture, null, 2) + '\n');
        await writeAlways('.ai-discovery/risks.json', JSON.stringify(risks, null, 2) + '\n');

        const discoveryMeta = {
          profile_recommended: profileRecommended,
          confidence: matchResult?.confidence || (enriched ? 'high' : 'medium'),
          matched_patterns: matchResult?.matchedPatterns || [],
          alternative_profiles: matchResult?.alternativeProfiles || [],
          enriched_by_api: enriched,
          repo_name: repoName,
          discovered_at: new Date().toISOString(),
          cli_version: '0.3.0',
        };
        await writeAlways('.ai-discovery/meta.json', JSON.stringify(discoveryMeta, null, 2) + '\n');

        spinner.succeed('Discovery complete');

        console.log('');
        info(`Runtime: ${stack.runtime || 'unknown'}`);
        info(`Languages: ${stack.language.join(', ') || 'none detected'}`);
        info(`Frameworks: ${stack.frameworks.join(', ') || 'none detected'}`);
        info(`Containerization: ${stack.containerization.join(', ') || 'none detected'}`);
        info(`Infrastructure: ${stack.infrastructure.join(', ') || 'none detected'}`);
        info(`CI/CD: ${stack.ci.join(', ') || 'none detected'}`);
        info(`Profile: ${profileRecommended} (confidence: ${matchResult?.confidence || 'medium'})`);

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
