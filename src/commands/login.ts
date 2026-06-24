/**
 * ai-gov login — Authenticate CLI with the governance platform.
 *
 * Enterprise authentication pattern (2026):
 * - Interactive: Opens browser → Cognito Hosted UI → callback to localhost
 * - CI/CD: Uses FEMSA_TOKEN env var or --token flag (API key from dashboard)
 * - Headless: Device Code Flow (RFC 8628) for SSH/containers
 *
 * References:
 * - Vercel CLI: OAuth 2.0 Device Flow (vercel.com/changelog/new-vercel-cli-login-flow)
 * - Terraform Cloud: `terraform login` → browser → stores token in ~/.terraform.d/
 * - Snyk: `snyk auth` → browser → stores token in ~/.config/configstore/snyk.json
 * - WorkOS: PKCE for interactive, Device Code for headless (workos.com/blog/pkce-vs-device-flow-cli-auth)
 * - OpenAI Codex: API key in env or config file
 *
 * Token storage: ~/.config/femsa/credentials.json (OS keychain in future)
 * Pattern: Same as Vercel (~/.config/vercel/auth.json), Terraform (~/.terraform.d/credentials.tfrc.json)
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { heading, success, error, info, warn } from '../utils/logger.js';

// ── Constants ──

const FEMSA_PLATFORM_URL = 'http://fs-aiplatform-alb-1259630648.us-east-1.elb.amazonaws.com';
const CREDENTIALS_DIR = join(homedir(), '.config', 'femsa');
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials.json');
const CALLBACK_PORT = 9876;

// ── Types ──

interface StoredCredentials {
  token: string;
  org_id: string;
  org_name?: string;
  user_email?: string;
  authenticated_at: string;
  expires_at?: string;
}

// ── Helpers ──

async function loadCredentials(): Promise<StoredCredentials | null> {
  try {
    const content = await readFile(CREDENTIALS_FILE, 'utf-8');
    return JSON.parse(content) as StoredCredentials;
  } catch {
    return null;
  }
}

async function saveCredentials(creds: StoredCredentials): Promise<void> {
  await mkdir(CREDENTIALS_DIR, { recursive: true });
  await writeFile(CREDENTIALS_FILE, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
}

async function clearCredentials(): Promise<void> {
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(CREDENTIALS_FILE);
  } catch {
    // File doesn't exist — that's fine
  }
}

/**
 * Verify a token against the platform and get org info.
 */
async function verifyToken(token: string): Promise<{ org_id: string; org_name: string; email: string } | null> {
  try {
    const resp = await fetch(`${FEMSA_PLATFORM_URL}/organizations/me`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': '@femsa/ai-governance-cli/0.5.0',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      const data = await resp.json() as Record<string, unknown>;
      return {
        org_id: (data.id as string) || (data.org_id as string) || '',
        org_name: (data.name as string) || (data.org_name as string) || '',
        email: (data.email as string) || (data.user_email as string) || '',
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Interactive login: open browser to platform login page.
 * Platform redirects back to localhost:9876 with token.
 *
 * Pattern: Vercel CLI login flow + Terraform Cloud login
 */
async function interactiveLogin(): Promise<StoredCredentials | null> {
  return new Promise((resolve) => {
    const state = randomBytes(16).toString('hex');

    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${CALLBACK_PORT}`);

      if (url.pathname === '/callback') {
        const token = url.searchParams.get('token') || '';
        const orgId = url.searchParams.get('org_id') || '';
        const orgName = url.searchParams.get('org_name') || '';
        const email = url.searchParams.get('email') || '';
        const returnedState = url.searchParams.get('state') || '';

        if (returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>Error: State mismatch</h1><p>Intenta de nuevo.</p></body></html>');
          server.close();
          resolve(null);
          return;
        }

        if (token && orgId) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<html><body style="font-family:system-ui;text-align:center;padding:60px">
            <h1 style="color:#00A94F">✓ Autenticado</h1>
            <p>Puedes cerrar esta ventana y volver a la terminal.</p>
            <p style="color:#666">Organización: ${orgName || orgId}</p>
          </body></html>`);

          server.close();
          resolve({
            token,
            org_id: orgId,
            org_name: orgName,
            user_email: email,
            authenticated_at: new Date().toISOString(),
          });
        } else {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>Error: Token no recibido</h1></body></html>');
          server.close();
          resolve(null);
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(CALLBACK_PORT, () => {
      const loginUrl = `${FEMSA_PLATFORM_URL}/auth/cli-login?callback=http://localhost:${CALLBACK_PORT}/callback&state=${state}`;
      info(`Abriendo navegador para autenticación...`);
      info(`Si no se abre automáticamente, visita:`);
      console.log(`  ${chalk.cyan(loginUrl)}`);
      console.log('');

      // Open browser
      import('node:child_process').then(({ exec }) => {
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        exec(`${cmd} "${loginUrl}"`);
      });
    });

    // Timeout after 120s
    setTimeout(() => {
      server.close();
      resolve(null);
    }, 120_000);
  });
}

// ── Commands ──

export function registerLoginCommand(program: Command): void {
  const loginCmd = program
    .command('login')
    .description('Authenticate with the FEMSA AI Governance platform')
    .option('--token <token>', 'Authenticate with an API token (for CI/CD)')
    .option('--check', 'Check current authentication status')
    .action(async (options: { token?: string; check?: boolean }) => {
      heading('AI Governance — Login');

      // ── Check mode: show current auth status ──
      if (options.check) {
        const creds = await loadCredentials();
        if (creds) {
          console.log('');
          success(`Autenticado como: ${creds.user_email || 'unknown'}`);
          info(`Organización: ${creds.org_name || creds.org_id}`);
          info(`Desde: ${new Date(creds.authenticated_at).toLocaleDateString('es-CL')}`);
          console.log('');
          info(`Credenciales en: ${CREDENTIALS_FILE}`);
        } else {
          warn('No autenticado. Ejecuta: ai-gov login');
        }
        return;
      }

      // ── Token mode: direct API key (CI/CD, headless) ──
      if (options.token) {
        const spinner = ora('Verificando token...').start();
        const orgInfo = await verifyToken(options.token);

        if (orgInfo && orgInfo.org_id) {
          await saveCredentials({
            token: options.token,
            org_id: orgInfo.org_id,
            org_name: orgInfo.org_name,
            user_email: orgInfo.email,
            authenticated_at: new Date().toISOString(),
          });
          spinner.succeed('Token verificado');
          console.log('');
          success(`Autenticado en organización: ${orgInfo.org_name || orgInfo.org_id}`);
          info(`Credenciales guardadas en: ${CREDENTIALS_FILE}`);
        } else {
          spinner.fail('Token inválido o plataforma no disponible');
          // Store anyway if platform is unreachable (offline mode)
          await saveCredentials({
            token: options.token,
            org_id: '',
            authenticated_at: new Date().toISOString(),
          });
          warn('Token guardado sin verificar (plataforma no disponible)');
          info('Se verificará en la próxima operación online.');
        }
        return;
      }

      // ── Env var mode: FEMSA_TOKEN ──
      const envToken = process.env.FEMSA_TOKEN;
      if (envToken) {
        info('Usando FEMSA_TOKEN del environment');
        const spinner = ora('Verificando token...').start();
        const orgInfo = await verifyToken(envToken);
        if (orgInfo && orgInfo.org_id) {
          await saveCredentials({
            token: envToken,
            org_id: orgInfo.org_id,
            org_name: orgInfo.org_name,
            user_email: orgInfo.email,
            authenticated_at: new Date().toISOString(),
          });
          spinner.succeed(`Autenticado: ${orgInfo.org_name}`);
        } else {
          spinner.warn('FEMSA_TOKEN no pudo ser verificado');
        }
        return;
      }

      // ── Interactive mode: browser login ──
      console.log('');
      info('Método: Login interactivo via navegador');
      info('(Para CI/CD usa: ai-gov login --token <API_KEY>)');
      console.log('');

      const creds = await interactiveLogin();
      if (creds) {
        await saveCredentials(creds);
        console.log('');
        success(`¡Autenticado exitosamente!`);
        info(`Organización: ${creds.org_name || creds.org_id}`);
        info(`Credenciales guardadas en: ${CREDENTIALS_FILE}`);
        console.log('');
        info('Ahora puedes usar ai-gov init, generate, y validate.');
        info('Los scores se asociarán automáticamente a tu organización.');
      } else {
        error('Login fallido o timeout. Intenta de nuevo.');
      }
    });

  // ── Logout subcommand ──
  program
    .command('logout')
    .description('Remove stored credentials')
    .action(async () => {
      heading('AI Governance — Logout');
      await clearCredentials();
      success('Credenciales eliminadas.');
      info(`Archivo removido: ${CREDENTIALS_FILE}`);
    });

  // ── Whoami subcommand ──
  program
    .command('whoami')
    .description('Show current authentication status')
    .action(async () => {
      const creds = await loadCredentials();
      if (creds) {
        console.log(`${chalk.green('●')} ${creds.user_email || 'Authenticated'}`);
        console.log(`  Org: ${creds.org_name || creds.org_id || 'unknown'}`);
        console.log(`  Desde: ${new Date(creds.authenticated_at).toLocaleDateString('es-CL')}`);
      } else {
        console.log(`${chalk.red('●')} No autenticado`);
        console.log(`  Ejecuta: ${chalk.cyan('ai-gov login')}`);
      }
    });
}

/**
 * Get stored credentials for use by other commands.
 * Returns null if not authenticated.
 *
 * Usage in other commands:
 *   import { getStoredAuth } from './login.js';
 *   const auth = await getStoredAuth();
 *   if (auth) { headers['Authorization'] = `Bearer ${auth.token}`; }
 */
export async function getStoredAuth(): Promise<StoredCredentials | null> {
  // Priority: env var > stored credentials
  const envToken = process.env.FEMSA_TOKEN;
  if (envToken) {
    return { token: envToken, org_id: process.env.FEMSA_ORG_ID || '', authenticated_at: new Date().toISOString() };
  }
  return loadCredentials();
}

/**
 * Get org_id from stored auth or env.
 * Used by validate, generate, etc. to tag data with org.
 */
export async function getOrgId(): Promise<string | null> {
  const auth = await getStoredAuth();
  return auth?.org_id || process.env.FEMSA_ORG_ID || null;
}
