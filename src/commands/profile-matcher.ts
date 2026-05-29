/**
 * Profile Matcher — evaluates file manifests against detection patterns
 * to determine the best matching governance profile.
 */

import { PROFILE_REGISTRY, type ProfileDefinition, type MatchResult } from './profile-registry.js';

/**
 * Evaluates whether a file manifest satisfies a profile's detection pattern.
 * Returns matched pattern descriptions if all conditions are met, or null if not.
 */
function evaluateProfile(
  profile: ProfileDefinition,
  fileManifest: string[],
  repoName: string | null,
): { matched: boolean; patterns: string[]; nameMatched: boolean } {
  const patterns: string[] = [];
  const { detection } = profile;
  let nameMatched = false;

  // Special case: generic always matches
  if (profile.name === 'generic') {
    return { matched: true, patterns: ['fallback'], nameMatched: false };
  }

  // Check requiredFiles — all must be present
  for (const file of detection.requiredFiles) {
    if (!fileManifest.includes(file)) {
      return { matched: false, patterns: [], nameMatched: false };
    }
    patterns.push(`required:${file}`);
  }

  // Check optionalFiles — for each group, at least one must exist
  for (const group of detection.optionalFiles) {
    const found = group.find((file) => fileManifest.includes(file));
    if (!found) {
      return { matched: false, patterns: [], nameMatched: false };
    }
    patterns.push(`optional:${found}`);
  }

  // Check requiredDirs — look for entries with dir/ prefix in manifest
  for (const dir of detection.requiredDirs) {
    const dirPrefix = dir.endsWith('/') ? dir : `${dir}/`;
    const hasDir = fileManifest.some(
      (entry) => entry === dir || entry === dirPrefix || entry.startsWith(dirPrefix),
    );
    if (!hasDir) {
      return { matched: false, patterns: [], nameMatched: false };
    }
    patterns.push(`dir:${dir}`);
  }

  // Check repoNamePatterns — if provided and repoName given, at least one must match
  if (detection.repoNamePatterns && detection.repoNamePatterns.length > 0 && repoName) {
    const nameMatch = detection.repoNamePatterns.some((pattern) => pattern.test(repoName));
    if (!nameMatch) {
      return { matched: false, patterns: [], nameMatched: false };
    }
    nameMatched = true;
    patterns.push(`repoName:${repoName}`);
  } else if (detection.repoNamePatterns && detection.repoNamePatterns.length > 0 && !repoName) {
    // repoNamePatterns defined but no repoName provided — cannot validate, skip name check
    // Profile can still match based on file patterns alone
  }

  // Special detection rules per profile
  const specialResult = evaluateSpecialRules(profile.name, fileManifest, repoName);
  if (specialResult === false) {
    return { matched: false, patterns: [], nameMatched: false };
  }
  if (specialResult && typeof specialResult === 'string') {
    patterns.push(specialResult);
  }

  // For profiles with repoNamePatterns that require name matching:
  // service-ecs-hub and lambda-nodejs require the name pattern when repoName is provided
  if (detection.repoNamePatterns && detection.repoNamePatterns.length > 0 && repoName && !nameMatched) {
    return { matched: false, patterns: [], nameMatched: false };
  }

  return { matched: true, patterns, nameMatched };
}

/**
 * Evaluates special detection rules that go beyond simple file/dir checks.
 * Returns:
 *   - false if the profile should NOT match
 *   - a string pattern description if special rule matched
 *   - null if no special rule applies (neutral)
 */
function evaluateSpecialRules(
  profileName: string,
  fileManifest: string[],
  repoName: string | null,
): false | string | null {
  switch (profileName) {
    case 'service-ecs-hub': {
      // Must have hub/capsula/ecs-hub in repo name if name is provided
      // (already handled by repoNamePatterns)
      return null;
    }

    case 'android-kotlin': {
      // Check for AndroidManifest.xml, src/main/kotlin/, src/main/java/, or settings.gradle.kts
      const hasManifest = fileManifest.some(
        (f) => f === 'AndroidManifest.xml' || f.includes('AndroidManifest.xml'),
      );
      const hasKotlinSrc = fileManifest.some((f) => f.startsWith('src/main/kotlin/'));
      const hasJavaSrc = fileManifest.some((f) => f.startsWith('src/main/java/'));
      const hasSettingsGradle = fileManifest.some(
        (f) => f === 'settings.gradle.kts' || f === 'settings.gradle',
      );
      if (hasManifest) return 'special:AndroidManifest.xml';
      if (hasKotlinSrc) return 'special:src/main/kotlin';
      if (hasJavaSrc) return 'special:src/main/java';
      if (hasSettingsGradle) return 'special:settings.gradle.kts';
      return false;
    }

    case 'ios-swift': {
      // Check for *.xcodeproj directory or Sources/ with .swift files
      const hasXcodeProj = fileManifest.some((f) => f.endsWith('.xcodeproj') || f.includes('.xcodeproj/'));
      const hasSwiftSources = fileManifest.some(
        (f) => f.startsWith('Sources/') && f.endsWith('.swift'),
      );
      const hasPackageSwift = fileManifest.includes('Package.swift');
      if (hasXcodeProj) return 'special:xcodeproj';
      if (hasSwiftSources) return 'special:Sources/*.swift';
      if (hasPackageSwift) return 'special:Package.swift';
      return false;
    }

    case 'eks-nodejs': {
      // Must NOT have hub/capsula in repo name (those go to service-ecs-hub)
      if (repoName && (/hub/i.test(repoName) || /capsula/i.test(repoName) || /ecs-hub/i.test(repoName))) {
        return false;
      }
      // Must NOT be a frontend app (those go to frontend-react)
      // Frontend indicators: next.config.*, react marker, no backend-specific files
      const hasFrontendIndicator = fileManifest.some(
        (f) =>
          f === 'next.config.js' ||
          f === 'next.config.mjs' ||
          f === 'next.config.ts' ||
          f === 'next',
      );
      const hasBackendIndicator = fileManifest.some(
        (f) =>
          f === 'docker-compose.yml' ||
          f === 'docker-compose.yaml' ||
          f.startsWith('src/modules/') ||
          f.startsWith('src/services/') ||
          f === 'nest-cli.json' ||
          f === 'prisma' ||
          f.endsWith('.controller.ts'),
      );
      // If it has Next.js/React indicators and NO backend-specific files → frontend
      if (hasFrontendIndicator && !hasBackendIndicator) {
        return false;
      }
      return null;
    }

    case 'frontend-react': {
      // package.json deps must contain 'react' or 'next'
      // Since we work with file manifests (not content), check for common React indicators
      const hasReactIndicator = fileManifest.some(
        (f) =>
          f === 'next.config.js' ||
          f === 'next.config.mjs' ||
          f === 'next.config.ts' ||
          f.startsWith('src/app/') ||
          f.startsWith('pages/') ||
          f.startsWith('src/pages/') ||
          f === 'next-env.d.ts' ||
          f === '.next' ||
          f === 'react' || // marker entry for package.json containing react
          f === 'next',    // marker entry for package.json containing next
      );
      if (!hasReactIndicator) return false;
      return 'special:react-or-next';
    }

    case 'terraform-module': {
      // .tf files must exist in root or infra/
      const hasTfFiles = fileManifest.some(
        (f) =>
          (f.endsWith('.tf') && !f.includes('/')) ||
          (f.startsWith('infra/') && f.endsWith('.tf')),
      );
      if (!hasTfFiles) return false;
      return 'special:*.tf';
    }

    case 'lambda-python': {
      // Requires requirements.txt OR pyproject.toml
      const hasPythonDeps =
        fileManifest.includes('requirements.txt') || fileManifest.includes('pyproject.toml');
      if (!hasPythonDeps) return false;
      return 'special:python-deps';
    }

    default:
      return null;
  }
}

/**
 * Matches a file manifest against the profile registry and returns the best match.
 *
 * @param fileManifest - Array of file paths found in the repository
 * @param repoName - Optional repository name for name-based pattern matching
 * @param profiles - Optional custom profile registry (defaults to PROFILE_REGISTRY)
 * @returns MatchResult with the selected profile, confidence, and alternatives
 */
export function matchProfile(
  fileManifest: string[],
  repoName: string | null,
  profiles: ProfileDefinition[] = PROFILE_REGISTRY,
): MatchResult {
  // Sort by priority (lowest number = highest priority)
  const sorted = [...profiles].sort((a, b) => a.priority - b.priority);

  const matches: Array<{ name: string; patterns: string[]; nameMatched: boolean }> = [];

  for (const profile of sorted) {
    const result = evaluateProfile(profile, fileManifest, repoName);
    if (result.matched) {
      matches.push({
        name: profile.name,
        patterns: result.patterns,
        nameMatched: result.nameMatched,
      });
    }
  }

  // First match wins (highest priority)
  if (matches.length === 0) {
    // Should not happen since generic always matches, but just in case
    return {
      profile: 'generic',
      confidence: 'low',
      matchedPatterns: ['fallback'],
      alternativeProfiles: [],
    };
  }

  const primary = matches[0];
  const alternatives = matches.slice(1).map((m) => m.name);

  // Determine confidence
  let confidence: 'high' | 'medium' | 'low';
  if (primary.name === 'generic') {
    confidence = 'low';
  } else if (primary.nameMatched) {
    confidence = 'high';
  } else {
    confidence = 'medium';
  }

  return {
    profile: primary.name,
    confidence,
    matchedPatterns: primary.patterns,
    alternativeProfiles: alternatives,
  };
}
