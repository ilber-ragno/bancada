// Árvore de arquivos do projeto: só leitura, sem segredos e com limite de tamanho.
import { exec, shq } from './ssh.js';

export const SENSITIVE = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa.*|id_ed25519.*|id_ecdsa.*|.*secret.*|.*credential.*|\.npmrc|\.netrc|\.pgpass|.*\.kdbx)$/i;

export function safeRel(p) {
  const v = String(p || '').replace(/^\.?\/+/, '').replace(/\/+$/, '');
  if (v.length > 500 || v.split('/').some((x) => x === '..' || x === '.git') || /[\0\n\r]/.test(v)) throw new Error('Caminho inválido');
  return v;
}

export async function listDir(project, dir) {
  const rel = safeRel(dir);
  const cmd = `cd ${shq(project.path)} && find ${shq(rel || '.')} -mindepth 1 -maxdepth 1 -not -name .git -printf '%y\\t%s\\t%f\\n' 2>/dev/null | head -500`;
  const r = await exec(project.server, cmd, { timeoutMs: 20000 });
  return r.stdout.split('\n').filter(Boolean).map((l) => { const [t, size, name] = l.split('\t'); return { name, type: t === 'd' ? 'd' : 'f', size: t === 'd' ? null : Number(size) }; })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'd' ? -1 : 1));
}

export async function readFile(project, file) {
  const rel = safeRel(file);
  if (!rel || SENSITIVE.test(rel)) throw Object.assign(new Error('Arquivo protegido: a Bancada não mostra .env, chaves e credenciais.'), { status: 403 });
  const r = await exec(project.server, `cd ${shq(project.path)} && [ -f ${shq(rel)} ] && [ ! -L ${shq(rel)} ] && head -c 204800 -- ${shq(rel)}`, { timeoutMs: 20000 });
  if (r.code !== 0) throw new Error('Arquivo não encontrado');
  return r.stdout.includes('\0') ? '(arquivo binário)' : r.stdout;
}
