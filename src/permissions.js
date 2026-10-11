// Papéis e permissões. A tela usa a mesma lista, mas quem decide é sempre o servidor.
export const PERMS = ['view', 'message', 'terminal', 'commit', 'pr', 'approve', 'danger', 'schedule', 'teams', 'agents', 'notebooks', 'skills', 'mcp', 'projects', 'rules', 'integrations', 'audit', 'invite', 'users'];

export const ROLES = {
  admin: { label: 'Administrador', perms: PERMS },
  lider: { label: 'Líder técnico', perms: ['view', 'message', 'terminal', 'commit', 'pr', 'approve', 'danger', 'schedule', 'teams', 'agents', 'notebooks', 'skills', 'projects', 'audit', 'invite'] },
  dev: { label: 'Desenvolvedor', perms: ['view', 'message', 'terminal', 'commit', 'pr', 'schedule', 'notebooks'] },
  leitura: { label: 'Somente leitura', perms: ['view'] },
};

export function permsOf(user) {
  if (!user || !user.active) return new Set();
  const set = new Set((ROLES[user.role] || ROLES.leitura).perms);
  for (const p of user.extra || []) if (PERMS.includes(p)) set.add(p);
  for (const p of user.deny || []) set.delete(p);
  return set;
}

export const RANK = { leitura: 0, dev: 1, lider: 2, admin: 3 };

// Contas de IA: o dono decide quem mais pode usar
export const canUseAccount = (acc, user) => !acc || (!!user && (acc.owner === user.id || acc.share === 'all' || (acc.share === 'people' && (acc.people || []).includes(user.id))));

// Agentes e portais: só o dono, quem acessa o projeto, ou pessoas escolhidas. Administradores enxergam tudo.
export function sharedWith(node, user) {
  if (!node?.owner || !user) return true;
  if (node.owner === user.id || permsOf(user).has('users')) return true;
  if (node.share === 'private') return false;
  if (node.share === 'people') return (node.people || []).includes(user.id);
  return true;
}

export const canSeeProject = (user, projectId) => !!user && (user.projects === '*' || (Array.isArray(user.projects) && user.projects.includes(projectId)));

export function can(user, perm, projectId) {
  if (!permsOf(user).has(perm)) return false;
  return projectId ? canSeeProject(user, projectId) : true;
}
