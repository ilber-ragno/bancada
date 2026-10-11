// Regras de segurança compartilhadas: mascaramento de dados sensíveis,
// padrões arriscados e comandos de leitura permitidos em produção.
const MASKS = [
  [/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, '[CNPJ oculto]'],
  [/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, '[CPF oculto]'],
  [/\b89\d{16,18}\b/g, '[ICCID oculto]'],
  [/(?:\+?55\s?)?\(?\b\d{2}\)?\s?9\d{4}-?\d{4}\b/g, '[telefone oculto]'],
  [/\b\d{11}\b/g, '[número oculto]'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[e-mail oculto]'],
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}|\d{8,10}:[A-Za-z0-9_-]{30,})\b/g, '[token oculto]'],
  [/((?:senha|password|passwd|secret|segredo|api[_-]?key)\s*[:=]\s*)\S+/gi, '$1[oculto]'],
];

export function mask(text) {
  let count = 0;
  let out = String(text);
  for (const [re, rep] of MASKS) {
    out = out.replace(re, (...m) => { count++; return rep.includes('$1') ? m[1] + '[oculto]' : rep; });
  }
  return { text: out, count };
}

export const DEFAULT_RISKY = ['rm -rf', 'drop table', 'drop database', 'truncate', 'git push --force', 'git reset --hard', 'deploy', 'chmod 777', 'shutdown', 'reboot', 'kubectl delete'];

export function checkRisky(text, patterns = DEFAULT_RISKY) {
  const t = String(text).toLowerCase();
  return (patterns || []).find((p) => p && t.includes(String(p).toLowerCase())) || null;
}

const RO = /^\s*(ls|pwd|cat|less|head|tail|grep|rg|find|wc|df|du|ps|top|free|uptime|whoami|git\s+(status|log|diff|show|branch|remote)|docker\s+(ps|logs)|kubectl\s+(get|describe|logs)|journalctl|systemctl\s+status)\b/;
export function isReadOnlyCmd(cmd) {
  const c = String(cmd).replace(/\|\s*(grep|head|tail|wc|sort|uniq|less)\b/g, '');
  return RO.test(cmd) && !/[>;&`$]|\btee\b|\|/.test(c);
}
