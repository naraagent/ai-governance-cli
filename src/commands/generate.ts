import type { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { readJsonSafe, fileExists, ensureDir, writeIfNotExists } from '../utils/fs.js';
import { success, error, heading, info } from '../utils/logger.js';

interface StackInfo {
  runtime: string | null;
  language: string[];
  frameworks: string[];
  containerization: string[];
  infrastructure: string[];
  ci: string[];
}

export function registerGenerateCommand(program: Command): void {
  program
    .command('generate')
    .description('Generate .kiro/steering/ and .kiro/skills/ based on discovered stack')
    .action(async () => {
      heading('AI Governance — Generate');

      if (!(await fileExists('.ai-discovery/stack.json'))) {
        error('Discovery has not been run. Execute `ai-gov discover` first.');
        process.exit(1);
      }

      const spinner = ora('Generating governance files...').start();

      try {
        const stack = await readJsonSafe<StackInfo>('.ai-discovery/stack.json');
        if (!stack) {
          spinner.fail('Could not read .ai-discovery/stack.json');
          process.exit(1);
        }

        await ensureDir('.kiro/steering');
        await ensureDir('.kiro/skills');

        const generated: string[] = [];

        // Generate steering files based on stack
        if (stack.language.includes('typescript')) {
          const content = `# TypeScript Standards\n\n- Strict mode enabled\n- ESM modules with .js extensions\n- No \`any\` types without justification\n- Prefer \`unknown\` over \`any\`\n- Use named exports\n- Consistent error handling with typed errors\n`;
          if (await writeIfNotExists('.kiro/steering/typescript-standards.md', content)) {
            generated.push('.kiro/steering/typescript-standards.md');
          }
        }

        if (stack.language.includes('python')) {
          const content = `# Python Standards\n\n- Python 3.11+ with type hints\n- FastAPI + Pydantic v2 for APIs\n- SQLAlchemy async for database access\n- structlog for structured logging\n- Never use bare \`except:\` or \`except Exception: pass\`\n- Use ResilientClient for HTTP calls\n`;
          if (await writeIfNotExists('.kiro/steering/python-standards.md', content)) {
            generated.push('.kiro/steering/python-standards.md');
          }
        }

        if (stack.frameworks.includes('nextjs')) {
          const content = `# Next.js Guidelines\n\n- App Router preferred\n- Server components by default\n- Client components only when needed (interactivity)\n- Use next/image for all images\n- Middleware for auth checks\n- Zustand for client state\n`;
          if (await writeIfNotExists('.kiro/steering/nextjs-guidelines.md', content)) {
            generated.push('.kiro/steering/nextjs-guidelines.md');
          }
        }

        if (stack.frameworks.includes('fastapi')) {
          const content = `# FastAPI Guidelines\n\n- All endpoints are async def\n- Pydantic v2 models for request/response\n- Dependency injection for services\n- Structured error responses\n- Health endpoint at /health\n- OpenAPI docs enabled in dev only\n`;
          if (await writeIfNotExists('.kiro/steering/fastapi-guidelines.md', content)) {
            generated.push('.kiro/steering/fastapi-guidelines.md');
          }
        }

        if (stack.containerization.includes('docker')) {
          const content = `# Docker Standards\n\n- Multi-stage builds\n- Non-root user in production images\n- .dockerignore for all sensitive files\n- Health checks defined\n- No secrets in image layers\n`;
          if (await writeIfNotExists('.kiro/steering/docker-standards.md', content)) {
            generated.push('.kiro/steering/docker-standards.md');
          }
        }

        if (stack.infrastructure.includes('terraform')) {
          const content = `# Terraform Standards\n\n- Remote state in S3 with DynamoDB locking\n- No IAM wildcard actions (*)\n- Encryption at rest for all storage\n- Tags on all resources\n- Modules for reusable components\n`;
          if (await writeIfNotExists('.kiro/steering/terraform-standards.md', content)) {
            generated.push('.kiro/steering/terraform-standards.md');
          }
        }

        if (stack.ci.includes('jenkins')) {
          const content = `# Jenkins Pipeline Standards\n\n- Declarative pipeline syntax\n- Shared libraries for common steps\n- Credential binding (never inline secrets)\n- Stage-level timeout and retry\n- Post-build notifications\n`;
          if (await writeIfNotExists('.kiro/steering/jenkins-standards.md', content)) {
            generated.push('.kiro/steering/jenkins-standards.md');
          }
        }

        // Generate security steering (always)
        const securityContent = `# Security Standards\n\n- No hardcoded credentials\n- No .env files in version control\n- OAuth 2.1 for external authentication\n- Service tokens for internal communication\n- Input validation on all endpoints\n- Audit logging for sensitive operations\n- Dependency scanning in CI\n`;
        if (await writeIfNotExists('.kiro/steering/security-standards.md', securityContent)) {
          generated.push('.kiro/steering/security-standards.md');
        }

        // Generate skills based on stack
        if (stack.frameworks.includes('nextjs') || stack.frameworks.includes('react')) {
          const content = `# Skill: Frontend Component Creation\n\ninclusion: manual\n\n## Instructions\nWhen creating new React/Next.js components:\n1. Use TypeScript with proper prop types\n2. Add accessibility attributes (aria-*)\n3. Use semantic HTML elements\n4. Include error boundaries for complex components\n5. Add unit tests with vitest + testing-library\n`;
          if (await writeIfNotExists('.kiro/skills/frontend-component.md', content)) {
            generated.push('.kiro/skills/frontend-component.md');
          }
        }

        if (stack.frameworks.includes('fastapi')) {
          const content = `# Skill: API Endpoint Creation\n\ninclusion: manual\n\n## Instructions\nWhen creating new FastAPI endpoints:\n1. Define Pydantic request/response models\n2. Add OpenAPI description and tags\n3. Implement proper error handling with HTTPException\n4. Add structured logging with correlation ID\n5. Include integration tests\n6. Document in API changelog\n`;
          if (await writeIfNotExists('.kiro/skills/api-endpoint.md', content)) {
            generated.push('.kiro/skills/api-endpoint.md');
          }
        }

        spinner.succeed('Generation complete');

        console.log('');
        if (generated.length > 0) {
          info(`Generated ${generated.length} file(s):`);
          for (const file of generated) {
            success(file);
          }
        } else {
          info('All files already exist. No new files generated.');
        }

        console.log('');
        console.log(chalk.dim('Next step: run `ai-gov validate` to check compliance'));
      } catch (err) {
        spinner.fail('Generation failed');
        throw err;
      }
    });
}
