export const AGENTS_MD_TEMPLATE = `# AGENTS.md

> This file describes how AI agents should interact with this repository.
> It follows the OpenAI Codex AGENTS.md pattern for AI-assisted development.

## Project Overview

This repository is part of the FEMSA enterprise platform. AI agents working here
should follow the governance policies, coding standards, and security requirements
defined below.

## Working with Agents

### Allowed Operations
- Read any file in the repository
- Modify files within \`src/\`, \`apps/\`, \`packages/\` directories
- Run tests and linting commands
- Create new files following project conventions

### Restricted Operations (require approval)
- Modifying infrastructure files (\`infra/\`, \`docker-compose.yml\`)
- Changing authentication or authorization logic
- Modifying encryption or credential management code
- Deploying to any environment
- Modifying CI/CD pipelines

### Forbidden Operations
- Accessing or exposing secrets, tokens, or credentials
- Disabling security controls or audit logging
- Bypassing governance checks
- Direct database manipulation in production

## Coding Standards

### General
- All code must pass linting and type checking before commit
- Tests are required for new features and bug fixes
- Structured logging (JSON) is mandatory for backend services
- Error handling must never silently swallow exceptions

### TypeScript
- Strict mode enabled
- ESM modules with .js extensions in imports
- Zustand for state management (frontend)
- API calls through the centralized api-client

### Python
- Python 3.11+ with type hints
- FastAPI + Pydantic v2 for APIs
- SQLAlchemy async + Alembic for database
- structlog for logging
- ResilientClient for HTTP calls (never raw httpx)

## Testing Approach

- Unit tests: vitest (TypeScript), pytest (Python)
- Integration tests: docker-compose based
- E2E tests: Playwright (web)
- All tests must pass before merge

## Security Requirements

- No hardcoded credentials
- No .env files committed
- OAuth 2.1 for external auth
- X-Service-Token for internal auth
- AES-256-GCM for credential encryption
- Audit trail for all sensitive operations

## AI Context

The \`.ai-context/\` directory contains living documentation that agents should
read before making changes:

- \`current-state.md\` - Current system state and recent changes
- \`active-work.md\` - Work in progress and priorities
- \`known-risks.md\` - Known issues and technical debt
- \`architecture-summary.md\` - High-level architecture overview
- \`next-steps.md\` - Planned upcoming work
- \`deployment-status.md\` - Current deployment state
- \`operational-notes.md\` - Runtime considerations
`;
