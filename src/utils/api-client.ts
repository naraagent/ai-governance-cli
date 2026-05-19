/**
 * NARA Governance API Client
 *
 * Connects the CLI to the NARA platform governance engine.
 * Implements resilient HTTP patterns following enterprise standards:
 * - Retry with exponential backoff (AWS SDK / Anthropic SDK pattern)
 * - Circuit breaker (OpenClaw / Bedrock AgentCore pattern)
 * - Bearer JWT authentication (MCP 2025-06-18 OAuth 2.1)
 * - Trace ID propagation (OpenTelemetry standard)
 * - Graceful degradation (CLI continues with local-only if API unavailable)
 *
 * Architecture:
 *   CLI → API Client → NARA Orchestrator (:8000) → Agents → MCPs
 */

import { randomUUID } from 'crypto';

export interface GovernanceApiConfig {
  baseUrl: string;
  apiKey?: string;
  token?: string;
  timeout?: number;
  maxRetries?: number;
  offline?: boolean;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  traceId?: string;
  offline?: boolean;
}

// ── Response types ─────────────────────────────────────────────────

export interface InitResult {
  status: string;
  repo_id: string;
  registered: boolean;
  trace_id: string;
}

export interface DiscoverResult {
  status: string;
  profile_recommended: string;
  stack: Record<string, unknown>;
  architecture: Record<string, unknown>;
  risks: Array<{ category: string; description: string; severity: string }>;
  discovery_context: Record<string, unknown>;
  trace_id: string;
}

export interface GenerateResult {
  status: string;
  profile: string;
  files_generated: Array<{ path: string; template: string }>;
  steering_content: Record<string, string>;
  skills_content: Record<string, string>;
  hooks_content: Record<string, string>;
  agents_md_content: string;
  trace_id: string;
}

export interface ValidateResult {
  status: string;
  compliance_score: number;
  recommendation: string;
  findings: Array<{ severity: string; category: string; message: string; remediation?: string }>;
  checks: Record<string, boolean>;
  standards_applied: string[];
  trace_id: string;
}

export interface SyncResult {
  status: string;
  context: Record<string, unknown>;
  last_updated: string;
  trace_id: string;
}

// ── Circuit Breaker ────────────────────────────────────────────────

type CircuitState = 'closed' | 'open' | 'half-open';

class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private lastFailure = 0;
  private readonly threshold: number;
  private readonly recoveryMs: number;

  constructor(threshold = 3, recoveryMs = 30_000) {
    this.threshold = threshold;
    this.recoveryMs = recoveryMs;
  }

  get isOpen(): boolean {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure >= this.recoveryMs) {
        this.state = 'half-open';
        return false;
      }
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) {
      this.state = 'open';
    }
  }
}

// ── API Client ─────────────────────────────────────────────────────

export class GovernanceApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly token: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly offline: boolean;
  private readonly circuit: CircuitBreaker;

  constructor(config: GovernanceApiConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey || '';
    this.token = config.token || '';
    this.timeout = config.timeout || 30_000;
    this.maxRetries = config.maxRetries || 3;
    this.offline = config.offline || false;
    this.circuit = new CircuitBreaker();
  }

  /**
   * POST /governance/init
   * Register repo in the governance system.
   */
  async init(repoId: string, repoUrl: string): Promise<ApiResponse<InitResult>> {
    return this.post<InitResult>('/governance/init', {
      repo_id: repoId,
      repo_url: repoUrl,
    });
  }

  /**
   * POST /governance/discover
   * Send local stack to platform for AI-enriched discovery.
   */
  async discover(
    repoId: string,
    repoUrl: string,
    localStack: Record<string, unknown>,
  ): Promise<ApiResponse<DiscoverResult>> {
    return this.post<DiscoverResult>('/governance/discover', {
      repo_id: repoId,
      repo_url: repoUrl,
      local_stack: localStack,
    });
  }

  /**
   * POST /governance/generate
   * Request AI-generated governance pack from platform.
   */
  async generate(
    profile: string,
    repoId: string,
    stackContext: Record<string, unknown>,
  ): Promise<ApiResponse<GenerateResult>> {
    return this.post<GenerateResult>('/governance/generate', {
      profile,
      repo_id: repoId,
      stack_context: stackContext,
    });
  }

  /**
   * POST /governance/validate
   * Send files for AI-powered compliance validation.
   */
  async validate(
    repoId: string,
    files: string[],
    localReport: Record<string, unknown>,
    standards?: string[],
  ): Promise<ApiResponse<ValidateResult>> {
    return this.post<ValidateResult>('/governance/validate', {
      repo_id: repoId,
      files,
      local_report: localReport,
      standards: standards || [],
    });
  }

  /**
   * POST /governance/sync
   * Sync persistent engineering memory from platform.
   */
  async sync(repoId: string, currentFiles: string[]): Promise<ApiResponse<SyncResult>> {
    return this.post<SyncResult>('/governance/sync', {
      repo_id: repoId,
      current_files: currentFiles,
    });
  }

  /**
   * POST /governance/scores
   * Submit compliance score to governance platform.
   */
  async submitScore(payload: Record<string, unknown>): Promise<ApiResponse<unknown>> {
    return this.post<unknown>('/governance/scores', payload);
  }

  /**
   * Check if API is reachable.
   */
  async healthCheck(): Promise<boolean> {
    if (this.offline) return false;
    try {
      const resp = await this.fetchWithTimeout(`${this.baseUrl}/health`, {
        method: 'GET',
        headers: this.buildHeaders(),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  // ── Internal methods ───────────────────────────────────────────

  private async post<T>(path: string, body: unknown): Promise<ApiResponse<T>> {
    if (this.offline) {
      return { ok: false, offline: true, error: 'Running in offline mode (no API connection)' };
    }

    if (this.circuit.isOpen) {
      return { ok: false, error: 'API circuit breaker open — service temporarily unavailable' };
    }

    const traceId = randomUUID();
    const url = `${this.baseUrl}${path}`;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.fetchWithTimeout(url, {
          method: 'POST',
          headers: {
            ...this.buildHeaders(),
            'X-Trace-ID': traceId,
          },
          body: JSON.stringify(body),
        });

        if (response.ok) {
          this.circuit.recordSuccess();
          const data = await response.json() as T;
          return { ok: true, data, traceId };
        }

        // Non-retryable errors
        if (response.status === 401 || response.status === 403 || response.status === 422) {
          const errBody = await response.text();
          return { ok: false, error: `API error ${response.status}: ${errBody}`, traceId };
        }

        // Retryable server errors (5xx)
        if (response.status >= 500 && attempt < this.maxRetries) {
          await this.backoff(attempt);
          continue;
        }

        const errText = await response.text();
        return { ok: false, error: `API error ${response.status}: ${errText}`, traceId };
      } catch (err) {
        if (attempt < this.maxRetries) {
          await this.backoff(attempt);
          continue;
        }
        this.circuit.recordFailure();
        return {
          ok: false,
          error: `API unreachable after ${this.maxRetries + 1} attempts: ${(err as Error).message}`,
          traceId,
        };
      }
    }

    return { ok: false, error: 'Unexpected: exhausted retries', traceId };
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': '@femsa/ai-governance-cli/0.2.0',
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    } else if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }

    return headers;
  }

  private async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async backoff(attempt: number): Promise<void> {
    // Exponential backoff with jitter (AWS SDK pattern)
    const base = Math.min(1000 * 2 ** attempt, 10_000);
    const jitter = Math.random() * base * 0.5;
    await new Promise((resolve) => setTimeout(resolve, base + jitter));
  }
}

// ── Factory ────────────────────────────────────────────────────────

/**
 * Create API client from environment or config file.
 *
 * Resolution order (enterprise standard — zero config for devs):
 * 1. AI_GOV_API_URL or GOVERNANCE_API_URL environment variable (override)
 * 2. .ai-governance.json platform_url field
 * 3. FEMSA default (embedded at build time — devs never configure this)
 * 4. Offline mode (local-only operation)
 *
 * Enterprise pattern: CLI knows its home platform at build time.
 * Same as: npm knows npmjs.org, gh CLI knows api.github.com, aws CLI knows *.amazonaws.com
 */
const FEMSA_PLATFORM_URL = 'http://fs-aiplatform-alb-1259630648.us-east-1.elb.amazonaws.com';

export function createApiClient(configOverride?: Partial<GovernanceApiConfig>): GovernanceApiClient {
  const baseUrl =
    configOverride?.baseUrl ||
    process.env.AI_GOV_API_URL ||
    process.env.GOVERNANCE_API_URL ||
    process.env.NARA_API_URL ||
    FEMSA_PLATFORM_URL;  // Always fall through to enterprise default

  const token =
    configOverride?.token ||
    process.env.AI_GOV_TOKEN ||
    process.env.NARA_TOKEN ||
    process.env.SERVICE_TOKEN ||
    '';

  return new GovernanceApiClient({
    baseUrl,
    token,
    offline: false,  // Never offline by default — let circuit breaker handle failures
    ...configOverride,
  });
}
