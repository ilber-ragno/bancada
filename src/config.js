import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const env = process.env;
export const cfg = {
  root,
  host: env.HOST || '127.0.0.1',
  port: Number(env.PORT) || 8787,
  secureCookie: env.COOKIE_SECURE === '1',
  dataDir: path.resolve(root, env.DATA_DIR || 'data'),
  sshAgent: env.SSH_AUTH_SOCK || '',
  sshKeyPath: env.SSH_KEY_PATH || '',
  sshKeyPassphrase: env.SSH_KEY_PASSPHRASE || '',
  usageHost: env.USAGE_HOST || '',
  usageIntervalMin: Number(env.USAGE_INTERVAL_MIN) || 10,
  telegramToken: env.TELEGRAM_BOT_TOKEN || '',
  telegramChat: env.TELEGRAM_CHAT_ID || '',
  webhookUrl: /^https:\/\//.test(env.WEBHOOK_URL || '') ? env.WEBHOOK_URL : '',
  agents: JSON.parse(fs.readFileSync(path.join(root, 'config', 'agents.json'), 'utf8')),
  mcps: readJson(path.join(root, 'config', 'mcps.json'), {}),
  skillsDir: path.join(root, 'config', 'skills'),
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function assertConfig() {
  const problems = [];
  const k = env.BANCADA_SECRET_KEY || '';
  if (!/^[0-9a-f]{64}$/i.test(k)) problems.push('BANCADA_SECRET_KEY precisa ter 64 caracteres hexadecimais. Gere com: openssl rand -hex 32');
  if (!cfg.sshAgent && !cfg.sshKeyPath) console.warn('Aviso: sem ssh-agent nem SSH_KEY_PATH. A Bancada abre, mas não vai conseguir entrar nos servidores.');
  return problems;
}
