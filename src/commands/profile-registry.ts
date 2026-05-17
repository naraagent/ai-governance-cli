/**
 * Profile Registry — defines all 10 governance profiles with detection patterns.
 */

export interface DetectionPattern {
  requiredFiles: string[];
  optionalFiles: string[][];  // Groups where at least one must exist (OR)
  requiredDirs: string[];
  repoNamePatterns?: RegExp[];
}

export interface ProfileDefinition {
  name: string;
  priority: number;  // Lower = higher priority
  detection: DetectionPattern;
  description: string;
  runtime: { language: string; platform: string; buildTool: string };
  tags: string[];
}

export interface MatchResult {
  profile: string;
  confidence: 'high' | 'medium' | 'low';
  matchedPatterns: string[];
  alternativeProfiles: string[];
}

export const PROFILE_REGISTRY: ProfileDefinition[] = [
  {
    name: 'service-ecs-hub',
    priority: 1,
    detection: {
      requiredFiles: ['package.json', 'Dockerfile'],
      optionalFiles: [['docker-compose.yml', 'docker-compose.yaml']],
      requiredDirs: [],
      repoNamePatterns: [/hub/i, /capsula/i, /ecs-hub/i],
    },
    description: 'Node.js microservice deployed on ECS Fargate using the Capsula/Hub pattern',
    runtime: { language: 'typescript', platform: 'ecs-fargate', buildTool: 'docker' },
    tags: ['nodejs', 'ecs', 'docker', 'capsula', 'microservice'],
  },
  {
    name: 'lambda-nodejs',
    priority: 2,
    detection: {
      requiredFiles: ['package.json'],
      optionalFiles: [['serverless.yml', 'serverless.yaml', 'template.yaml', 'template.yml']],
      requiredDirs: [],
      repoNamePatterns: [/lambda/i],
    },
    description: 'Node.js Lambda function with Serverless Framework or SAM',
    runtime: { language: 'typescript', platform: 'lambda', buildTool: 'serverless' },
    tags: ['nodejs', 'lambda', 'serverless', 'aws'],
  },
  {
    name: 'android-kotlin',
    priority: 3,
    detection: {
      requiredFiles: [],
      optionalFiles: [['build.gradle.kts', 'build.gradle']],
      requiredDirs: [],
      // Special: check for AndroidManifest.xml in subdirs, or src/main/kotlin/, src/main/java/
    },
    description: 'Android application built with Kotlin and Gradle',
    runtime: { language: 'kotlin', platform: 'android', buildTool: 'gradle' },
    tags: ['android', 'kotlin', 'mobile', 'gradle'],
  },
  {
    name: 'ios-swift',
    priority: 4,
    detection: {
      requiredFiles: [],
      optionalFiles: [['Package.swift']],
      requiredDirs: [],
      // Special: check for *.xcodeproj directory or Sources/ with .swift files
    },
    description: 'iOS application built with Swift using Xcode/SPM',
    runtime: { language: 'swift', platform: 'ios', buildTool: 'xcode' },
    tags: ['ios', 'swift', 'mobile', 'xcode'],
  },
  {
    name: 'helm-infra',
    priority: 5,
    detection: {
      requiredFiles: ['Chart.yaml', 'values.yaml'],
      optionalFiles: [],
      requiredDirs: ['templates'],
    },
    description: 'Helm chart for Kubernetes infrastructure',
    runtime: { language: 'yaml', platform: 'kubernetes', buildTool: 'helm' },
    tags: ['helm', 'kubernetes', 'infrastructure', 'charts'],
  },
  {
    name: 'eks-nodejs',
    priority: 6,
    detection: {
      requiredFiles: ['package.json', 'Dockerfile'],
      optionalFiles: [['Jenkinsfile', '.github/workflows']],
      requiredDirs: [],
      // Note: does NOT match repos with hub/capsula in name (those go to service-ecs-hub)
    },
    description: 'Node.js service deployed on EKS with CI/CD pipeline',
    runtime: { language: 'typescript', platform: 'eks', buildTool: 'docker' },
    tags: ['nodejs', 'eks', 'docker', 'kubernetes'],
  },
  {
    name: 'frontend-react',
    priority: 7,
    detection: {
      requiredFiles: ['package.json'],
      optionalFiles: [],
      requiredDirs: [],
      // Special: package.json deps contain 'react' or 'next'
    },
    description: 'React/Next.js frontend application',
    runtime: { language: 'typescript', platform: 'browser', buildTool: 'next' },
    tags: ['react', 'nextjs', 'frontend', 'typescript'],
  },
  {
    name: 'terraform-module',
    priority: 8,
    detection: {
      requiredFiles: [],
      optionalFiles: [],
      requiredDirs: [],
      // Special: .tf files exist in root or infra/
    },
    description: 'Terraform infrastructure-as-code module',
    runtime: { language: 'hcl', platform: 'aws', buildTool: 'terraform' },
    tags: ['terraform', 'infrastructure', 'aws', 'iac'],
  },
  {
    name: 'lambda-python',
    priority: 9,
    detection: {
      requiredFiles: [],
      optionalFiles: [['serverless.yml', 'template.yaml']],
      requiredDirs: [],
      repoNamePatterns: [/lambda/i],
      // Special: requires requirements.txt OR pyproject.toml
    },
    description: 'Python Lambda function with Serverless Framework or SAM',
    runtime: { language: 'python', platform: 'lambda', buildTool: 'serverless' },
    tags: ['python', 'lambda', 'serverless', 'aws'],
  },
  {
    name: 'generic',
    priority: 10,
    detection: {
      requiredFiles: [],
      optionalFiles: [],
      requiredDirs: [],
    },
    description: 'Generic project with standard governance defaults',
    runtime: { language: 'unknown', platform: 'unknown', buildTool: 'unknown' },
    tags: ['generic'],
  },
];
