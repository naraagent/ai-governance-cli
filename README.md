# @femsa/ai-governance

Enterprise AI Governance CLI for managing `.kiro/`, `.ai-context/`, steering files, skills, and compliance validation.

## Installation

### From CodeArtifact

```bash
# Login to CodeArtifact
aws codeartifact login --tool npm \
  --repository femsa-npm \
  --domain femsa \
  --domain-owner 123456789 \
  --region us-east-1

# Install globally
npm install -g @femsa/ai-governance
```

### From source

```bash
cd packages/ai-governance-cli
npm install
npm run build
npm link
```

## Usage

### Initialize governance structure

```bash
ai-gov init
```

Creates:
- `.kiro/steering/` — AI steering files
- `.kiro/skills/` — AI skill definitions
- `.kiro/specs/` — Feature specifications
- `.ai-context/` — Living documentation for AI agents (7 template files)
- `AGENTS.md` — How AI agents should work in this repo (OpenAI Codex pattern)
- `.ai-governance.json` — Configuration

### Discover project stack

```bash
ai-gov discover
```

Scans the repository and detects:
- Runtime and languages (Node.js, Python)
- Frameworks (Next.js, FastAPI, Express)
- Containerization (Docker, docker-compose)
- Infrastructure (Terraform, Helm, Kubernetes)
- CI/CD (GitHub Actions, Jenkins, GitLab CI)
- Potential security risks

Outputs to `.ai-discovery/` (stack.json, architecture.json, risks.json).

### Generate steering files

```bash
ai-gov generate
```

Based on discovery results, generates:
- `.kiro/steering/` files tailored to your stack
- `.kiro/skills/` relevant to detected frameworks
- Security standards (always generated)

### Validate compliance

```bash
ai-gov validate
ai-gov validate --ci  # Exit code 1 on failure
```

Checks:
- **Security**: .env in .gitignore, hardcoded secrets, IAM wildcards
- **Architecture**: Required governance files exist
- **Observability**: Structured logging, health endpoints

Outputs report to `.ai-governance/validation-report.json`.

### Sync context

```bash
ai-gov sync
```

Updates `.ai-context/current-state.md` with:
- Active specs from `.kiro/specs/`
- Steering file count
- Latest stack info

### Health check

```bash
ai-gov doctor
```

Verifies:
- `.kiro/` structure completeness
- `.ai-context/` file freshness
- Configuration version

### Update templates

```bash
ai-gov update
```

> Coming in v0.2.0 — pull latest templates from enterprise registry.

## Architecture

```
packages/ai-governance-cli/
├── src/
│   ├── index.ts              # CLI entry point (Commander)
│   ├── commands/
│   │   ├── init.ts           # Initialize governance structure
│   │   ├── discover.ts       # Detect project stack
│   │   ├── generate.ts       # Generate steering/skills
│   │   ├── validate.ts       # Compliance validation
│   │   ├── sync.ts           # Sync AI context
│   │   ├── doctor.ts         # Health checks
│   │   └── update.ts         # Template updates (stub)
│   ├── utils/
│   │   ├── logger.ts         # Structured chalk logger
│   │   └── fs.ts             # File system utilities
│   └── templates/
│       ├── agents-md.ts      # AGENTS.md template
│       └── ai-context.ts     # .ai-context/ templates
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── README.md
```

## CI Integration

Add to your pipeline:

```groovy
// Jenkinsfile
stage('AI Governance') {
  steps {
    sh 'npx @femsa/ai-governance validate --ci'
  }
}
```

```yaml
# GitHub Actions
- name: AI Governance Check
  run: npx @femsa/ai-governance validate --ci
```

## Development

```bash
npm run dev     # Watch mode
npm run build   # Production build
npm run test    # Run tests
npm run lint    # Type check
```

## License

FEMSA Internal — Proprietary
