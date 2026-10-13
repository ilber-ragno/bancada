// Assistente de projetos: servidor por SSH, ferramentas, repositório, ambiente e pessoas.
// Tudo que roda no servidor é só leitura, exceto o "git clone" que a pessoa pede.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import ssh2 from 'ssh2';
const { Client, OpenSSHAgent } = ssh2;
import { cfg } from './config.js';
import { exec, shq, parseTarget } from './ssh.js';
import { getDoc, saveDoc, server, saveServer, audit } from './store.js';
import { allUsers, grantProject } from './users.js';

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

// ---------- Chave SSH desta máquina ----------
export async function myPublicKeys() {
  const keys = [];
  if (cfg.sshAgent) {
    try {
      const ids = await new Promise((resolve, reject) => new OpenSSHAgent(cfg.sshAgent).getIdentities((e, k) => (e ? reject(e) : resolve(k))));
      for (const k of ids || []) keys.push(`${k.type} ${k.getPublicSSH().toString('base64')} ${k.comment || 'bancada'}`.trim());
    } catch {}
  }
  const candidates = [cfg.sshKeyPath && cfg.sshKeyPath + '.pub', ...['id_ed25519', 'id_ecdsa', 'id_rsa'].map((k) => path.join(os.homedir(), '.ssh', k + '.pub'))].filter(Boolean);
  for (const f of candidates) { try { const k = fs.readFileSync(f, 'utf8').trim(); if (k && !keys.includes(k)) keys.push(k); } catch {} }
  return { keys, source: cfg.sshAgent ? 'ssh-agent' : cfg.sshKeyPath ? path.basename(cfg.sshKeyPath) : '' };
}

// ---------- Teste de conexão (não grava nada até a pessoa confirmar a chave do servidor) ----------
const friendlySsh = (e, t) => {
  const m = String(e?.message || e);
  if (/All configured authentication methods failed|authentication/i.test(m)) return { code: 'auth', message: `O servidor recusou a chave SSH desta máquina para o usuário ${t.username}. Adicione a chave pública abaixo no arquivo ~/.ssh/authorized_keys desse usuário.` };
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return { code: 'dns', message: `Não encontrei o endereço ${t.host}. Confira se digitou certo ou se precisa estar na VPN/Tailscale.` };
  if (/ECONNREFUSED/i.test(m)) return { code: 'refused', message: `O servidor ${t.host} recusou a conexão na porta ${t.port}. O SSH está rodando nessa porta?` };
  if (/Timed out|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(m)) return { code: 'timeout', message: `Sem resposta de ${t.host}:${t.port}. Pode ser firewall, VPN desligada ou porta errada.` };
  if (/no private key|privateKey|agent/i.test(m)) return { code: 'nokey', message: 'Esta máquina não tem chave SSH configurada. Crie uma com: ssh-keygen -t ed25519' };
  return { code: 'other', message: m.slice(0, 300) };
};

export function sshTest(targetText) {
  const t = parseTarget(targetText);
  const hostId = `${t.host}:${t.port}`;
  return new Promise((resolve) => {
    const c = new Client();
    let fingerprint = null, fpPadded = null; // padded = formato guardado pelo ssh.js
    const done = (r) => { try { c.end(); } catch {} resolve(r); };
    const known = server().hostKeys[hostId] || null;
    const opts = {
      host: t.host, port: t.port, username: t.username, readyTimeout: 12000,
      hostVerifier: (key) => {
        fpPadded = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64');
        fingerprint = fpPadded.replace(/=+$/, '');
        // Chave diferente da conhecida: recusa (pode ser outro servidor no lugar)
        return !known || known === fpPadded;
      },
    };
    if (cfg.sshAgent) opts.agent = cfg.sshAgent;
    if (cfg.sshKeyPath) { try { opts.privateKey = fs.readFileSync(cfg.sshKeyPath); } catch {} }
    if (cfg.sshKeyPassphrase) opts.passphrase = cfg.sshKeyPassphrase;
    if (!opts.agent && !opts.privateKey) return resolve({ ok: false, target: t.key, ...friendlySsh(new Error('no private key'), t) });
    c.on('ready', () => {
      c.exec("bash -lc 'echo \"$(whoami)|$(hostname)|$(uname -sm)|$HOME\"'", (e, stream) => {
        if (e) return done({ ok: true, target: t.key, fingerprint, known: !!known, info: {} });
        let out = '';
        stream.on('data', (d) => { out += d; }).on('close', () => {
          const [user, host, system, home] = out.trim().split('|');
          done({ ok: true, target: t.key, fingerprint, known: !!known, info: { user, host, system, home } });
        });
        stream.stderr.resume();
      });
    }).on('error', (e) => {
      if (known && fpPadded && fpPadded !== known) {
        return done({ ok: false, target: t.key, code: 'hostkey', fingerprint, message: `A chave deste servidor mudou desde a última conexão (${known}). Se você não reinstalou o servidor, não continue: pode ser outra máquina se passando por ele.` });
      }
      done({ ok: false, target: t.key, fingerprint, ...friendlySsh(e, t) });
    });
    try { c.connect(opts); } catch (e) { done({ ok: false, target: t.key, ...friendlySsh(e, t) }); }
  });
}

// A pessoa conferiu a impressão digital: passa a valer para todas as conexões
export function trustHost(targetText, fingerprint, actor) {
  const t = parseTarget(targetText);
  const hostId = `${t.host}:${t.port}`;
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(String(fingerprint))) throw err('Impressão digital inválida.');
  const padded = fingerprint + '=';
  const known = server().hostKeys[hostId];
  if (known && known !== padded) throw err('Este servidor já tem outra chave registrada. Remova a antiga com um administrador antes.');
  server().hostKeys[hostId] = padded;
  saveServer();
  audit({ actor: actor.name, action: 'Confiou na chave do servidor', detail: `${hostId} ${fingerprint}` });
}

// ---------- Ferramentas no servidor ----------
const TOOLS = ['git', 'tmux', 'python3', 'node', 'claude', 'codex', 'gemini', 'gh'];
const CHECK = `
chk(){ p=$(command -v "$1" 2>/dev/null); v=""; [ -n "$p" ] && v=$(timeout 8 "$1" --version 2>/dev/null | head -1 | cut -c1-80); echo "tool|$1|$p|$v"; }
for t in ${TOOLS.join(' ')}; do chk $t; done
{ [ -s ~/.claude/.credentials.json ] || grep -q '"oauthAccount"' ~/.claude.json 2>/dev/null; } && echo "login|claude|1" || echo "login|claude|0"
[ -s ~/.codex/auth.json ] && echo "login|codex|1" || echo "login|codex|0"
{ [ -s ~/.gemini/oauth_creds.json ] || [ -n "$GEMINI_API_KEY" ]; } && echo "login|gemini|1" || echo "login|gemini|0"
timeout 8 gh auth status >/dev/null 2>&1 && echo "login|gh|1" || echo "login|gh|0"
pm=none; command -v apt-get >/dev/null && pm=apt; command -v dnf >/dev/null && pm=dnf; command -v brew >/dev/null && pm=brew
echo "os|$( . /etc/os-release 2>/dev/null; echo "\${PRETTY_NAME:-$(uname -s)}" )|$(uname -m)|$pm"
`;

const installHint = (tool, pm) => {
  const sys = { apt: 'sudo apt-get install -y', dnf: 'sudo dnf install -y', brew: 'brew install' }[pm] || 'instale pelo gerenciador de pacotes:';
  return {
    git: `${sys} git`, tmux: `${sys} tmux`, python3: `${sys} python3`, gh: `${sys} gh`,
    node: pm === 'brew' ? 'brew install node' : 'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs',
    claude: 'curl -fsSL https://claude.ai/install.sh | bash',
    codex: 'npm install -g @openai/codex',
    gemini: 'npm install -g @google/gemini-cli',
  }[tool];
};
const loginHint = { claude: 'Rode "claude" no servidor e digite /login', codex: 'Rode "codex login" no servidor', gemini: 'Rode "gemini" no servidor e escolha o login', gh: 'Rode "gh auth login" no servidor' };
const ABOUT = {
  git: 'Necessário. A Bancada cria uma cópia de trabalho (worktree) por janela.',
  tmux: 'Necessário. Mantém o terminal vivo quando a tela fecha.',
  python3: 'Necessário. Usado pelo hook de aprovações.',
  node: 'Necessário para instalar o Codex e o Gemini CLI pelo npm.',
  claude: 'Claude Code. Precisa estar instalado e logado com a conta deste usuário do servidor.',
  codex: 'Codex CLI (opcional).',
  gemini: 'Gemini CLI (opcional).',
  gh: 'GitHub CLI (opcional). Só para abrir pull requests pela tela.',
};
const REQUIRED = new Set(['git', 'tmux', 'python3']);

export async function checkTools(targetText) {
  parseTarget(targetText);
  const r = await exec(targetText, CHECK, { timeoutMs: 60000 });
  const tools = {}, logins = {}; let osInfo = { name: '', arch: '', pm: 'none' };
  for (const line of r.stdout.split('\n')) {
    const [kind, a, b, c] = line.split('|');
    if (kind === 'tool') tools[a] = { path: b || '', version: c || '' };
    if (kind === 'login') logins[a] = b === '1';
    if (kind === 'os') osInfo = { name: a, arch: b, pm: c };
  }
  const items = TOOLS.map((name) => {
    const installed = !!tools[name]?.path;
    const loginNeeded = name in loginHint;
    const loggedIn = loginNeeded ? !!logins[name] : null;
    return {
      name, about: ABOUT[name], required: REQUIRED.has(name), installed, version: tools[name]?.version || '',
      loggedIn, fix: !installed ? installHint(name, osInfo.pm) : loginNeeded && !loggedIn ? loginHint[name] : '',
    };
  });
  const agents = ['claude', 'codex', 'gemini'].filter((n) => items.find((i) => i.name === n)?.installed && logins[n]);
  const missingRequired = items.filter((i) => i.required && !i.installed).map((i) => i.name);
  return { os: osInfo, items, agents, ready: !missingRequired.length && agents.length > 0, missingRequired };
}

// ---------- Repositórios ----------
const okPath = (p) => /^(~|\/)[\w./~ @+-]{0,300}$/.test(p) && !p.split('/').includes('..');
const remotePath = (p) => (p.startsWith('~') ? '"$HOME"' + shq(p.slice(1)) : shq(p));

export async function findRepos(targetText, base) {
  const b = String(base || '~').trim() || '~';
  if (!okPath(b)) throw err('Pasta inválida. Use um caminho como ~/projetos ou /srv/apps.');
  const cmd = `cd ${remotePath(b)} 2>/dev/null || { echo "nodir"; exit 0; }
find . -maxdepth 4 -type d \\( -name node_modules -o -name .cache -o -name vendor \\) -prune -o -type d -name .git -print 2>/dev/null | head -80 | while read g; do d=$(dirname "$g"); full=$(cd "$d" && pwd); br=$(git -C "$d" branch --show-current 2>/dev/null); rm=$(git -C "$d" remote get-url origin 2>/dev/null | sed -E 's#https://[^@/]+@#https://#'); ch=$(git -C "$d" status --porcelain 2>/dev/null | wc -l | tr -d ' '); echo "repo|$full|$br|$rm|$ch"; done`;
  const r = await exec(targetText, cmd, { timeoutMs: 45000 });
  if (r.stdout.trim() === 'nodir') throw err(`A pasta ${b} não existe nesse servidor.`);
  return r.stdout.split('\n').filter((l) => l.startsWith('repo|')).map((l) => {
    const [, p, branch, remote, changes] = l.split('|');
    return { path: p, name: path.posix.basename(p), branch, remote, changes: Number(changes) || 0 };
  });
}

export async function cloneRepo(targetText, url, dest, actor) {
  const u = String(url || '').trim();
  if (!/^(https:\/\/[\w.-]+\/[\w./-]+?|git@[\w.-]+:[\w./-]+?)(\.git)?$/.test(u)) throw err('Endereço de repositório inválido. Use https://github.com/dono/repo ou git@github.com:dono/repo.git');
  const d = String(dest || '').trim();
  if (!okPath(d) || d === '~' || d === '/') throw err('Pasta de destino inválida.');
  const cmd = `export GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
dest=${remotePath(d)}
[ -e "$dest" ] && { echo "exists"; exit 3; }
mkdir -p "$(dirname "$dest")" && git clone -- ${shq(u)} "$dest" 2>&1 | tail -5 && cd "$dest" && pwd`;
  const r = await exec(targetText, cmd, { timeoutMs: 10 * 60000 });
  if (r.code === 3 || r.stdout.trim() === 'exists') throw err('Já existe algo nessa pasta. Escolha outro nome ou use a opção "Pasta existente".');
  const lines = r.stdout.trim().split('\n');
  const full = lines[lines.length - 1];
  if (r.code !== 0 || !full.startsWith('/')) {
    const out = (r.stdout + r.stderr).slice(-400);
    if (/Authentication failed|could not read Username|Permission denied \(publickey\)|Repository not found/i.test(out)) {
      throw err('O servidor não tem acesso a esse repositório. Para repositório privado, rode "gh auth login" no servidor ou cadastre uma deploy key.');
    }
    throw err('O clone falhou: ' + out);
  }
  audit({ actor: actor.name, action: 'Clonou repositório pelo assistente', detail: `${u} em ${targetText}:${full}` });
  return { path: full };
}

// ---------- Criar o projeto ----------
const ENVS = ['dev', 'staging', 'prod'];
const COLORS = ['#2563EB', '#16A34A', '#9333EA', '#EA580C', '#DB2777', '#0891B2', '#CA8A04', '#4F46E5'];

export function createProject(input, actor) {
  const name = String(input?.name || '').trim().slice(0, 60);
  if (!name) throw err('Dê um nome ao projeto.');
  const t = parseTarget(input?.server);
  const p = String(input?.path || '').trim();
  if (!p.startsWith('/') || !okPath(p)) throw err('Caminho do projeto inválido. Escolha a pasta do repositório.');
  const env = ENVS.includes(input?.env) ? input.env : 'dev';
  const doc = getDoc();
  doc.projects = doc.projects || [];
  const serverStr = t.port === 22 ? `${t.username}@${t.host}` : t.key;
  const same = (x) => { try { return parseTarget(x.server).key === t.key && x.path === p; } catch { return false; } };
  if (doc.projects.some(same)) throw err('Já existe um projeto apontando para essa pasta nesse servidor.');
  const id = 'p' + crypto.randomBytes(5).toString('hex');
  const project = {
    id, name, label: name, server: serverStr, path: p, env,
    collab: input?.collab !== false,
    color: /^#[0-9A-Fa-f]{6}$/.test(input?.color || '') ? input.color : COLORS[doc.projects.length % COLORS.length],
    agents: Array.isArray(input?.agents) ? input.agents.filter((a) => ['claude', 'codex', 'gemini'].includes(a)) : [],
    createdBy: actor.id, createdAt: Date.now(),
  };
  doc.projects.push(project);
  saveDoc();
  const people = Array.isArray(input?.people) ? input.people : [];
  for (const uid of new Set([actor.id, ...people])) if (allUsers().some((u) => u.id === uid)) grantProject(uid, id);
  audit({ actor: actor.name, action: 'Criou projeto pelo assistente', detail: `${name} (${env}) em ${serverStr}:${p}` });
  return project;
}

export const servers = () => [...new Set((getDoc().projects || []).map((p) => p.server).filter(Boolean))];
