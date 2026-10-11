// Controle de acesso sobre o documento de estado:
//  - filterFor: o que cada pessoa recebe (só projetos liberados, sem segredos).
//  - mergeFrom: o que cada pessoa consegue alterar (o resto volta ao valor do servidor).
import { can, canSeeProject, permsOf, sharedWith, canUseAccount } from './permissions.js';
import { hasSecret } from './vault.js';
import { publicUser, allUsers } from './users.js';

const byId = (arr) => new Map((arr || []).map((x) => [x.id, x]));

export function makeView(doc, user) {
  const nodes = [...(doc.nodes || []), ...Object.values(doc.wsData || {}).flatMap((w) => w.nodes || []), ...(doc.archive || [])];
  const nodeMap = byId(nodes);
  const linksOf = (id) => (doc.links || []).filter((l) => l.a === id || l.b === id).map((l) => nodeMap.get(l.a === id ? l.b : l.a)).filter(Boolean);
  const visible = (n) => {
    if (!n || !permsOf(user).has('view')) return false;
    if (n.type === 'note') return true;
    if (n.type === 'portal') return sharedWith(n, user);
    if (n.type === 'agent' && !sharedWith(n, user)) return false;
    if (n.type === 'orch') { const w = linksOf(n.id).filter((x) => x.type === 'agent'); return !w.length || w.some((x) => canSeeProject(user, x.projectId)); }
    return canSeeProject(user, n.projectId);
  };
  const projectOf = (n) => (doc.projects || []).find((p) => p.id === n?.projectId);
  return { nodeMap, linksOf, visible, projectOf };
}

// Permissão para agir numa janela (orquestrador exige acesso a todos os projetos ligados)
export function canNode(doc, user, perm, n) {
  if (!n) return false;
  const v = makeView(doc, user);
  if (n.type === 'orch') return can(user, perm) && v.linksOf(n.id).filter((x) => x.type === 'agent').every((x) => canSeeProject(user, x.projectId));
  if (n.type === 'note') return can(user, 'notebooks');
  if (n.type === 'portal') return can(user, 'view') && sharedWith(n, user);
  if (n.type === 'files') return can(user, perm === 'message' ? 'view' : perm, n.projectId);
  return can(user, perm, n.projectId) && sharedWith(n, user);
}

export function filterFor(full, user) {
  const v = makeView(full, user);
  const seeAll = user.projects === '*';
  const nodesVisible = (list) => (list || []).filter(v.visible);
  const nodes = nodesVisible(full.nodes);
  const ids = new Set([...nodes, ...nodesVisible(full.archive), ...Object.values(full.wsData || {}).flatMap((w) => nodesVisible(w.nodes))].map((n) => n.id));
  const teams = (full.teams || []).map((t) => ({ ...t, members: t.members.filter((id) => ids.has(id)) })).filter((t) => seeAll || t.members.length);
  return {
    ...full,
    projects: (full.projects || []).filter((p) => canSeeProject(user, p.id)),
    groups: (full.groups || []).map((g) => ({ ...g, projectIds: g.projectIds.filter((id) => canSeeProject(user, id)) })).filter((g) => g.projectIds.length),
    nodes,
    archive: nodesVisible(full.archive),
    wsData: Object.fromEntries(Object.entries(full.wsData || {}).map(([k, w]) => [k, { ...w, nodes: nodesVisible(w.nodes) }])),
    links: (full.links || []).filter((l) => ids.has(l.a) && ids.has(l.b)),
    approvals: (full.approvals || []).filter((a) => ids.has(a.nodeId)),
    events: (full.events || []).filter((e) => seeAll ? true : (!e.nodeId || ids.has(e.nodeId))).slice(0, can(user, 'audit') ? 300 : 80),
    runs: (full.runs || []),
    teams,
    schedules: (full.schedules || []).filter((s) => seeAll || (s.target?.type === 'team' ? teams.some((t) => t.id === s.target.id) : ids.has(s.target?.id))),
    mcps: (full.mcps || []).map((m) => ({ ...m, env: (m.env || []).map((e) => ({ key: e.key, set: hasSecret('mcp:' + m.id, e.key) })) })),
    prefs: { [user.id]: (full.prefs || {})[user.id] },
    inbox: undefined,
    accounts: (full.accounts || []).filter((a) => a.owner === user.id || canUseAccount(a, user) || can(user, 'users')),
    invites: (full.invites || []).filter((i) => i.createdBy === user.id || can(user, 'users')),
    users: can(user, 'users') ? allUsers().map(publicUser) : allUsers().filter((u) => u.active).map((u) => ({ id: u.id, name: u.name, color: u.color, role: u.role, active: true, projects: [] })),
    me: publicUser(user),
  };
}

const SERVER_SCHED_FIELDS = ['lastRun', 'history'];

export function mergeFrom(current, incoming, user) {
  const cur = current || {};
  const inc = incoming || {};
  const out = { ...cur };
  const v = makeView(cur, user);
  const perm = (p, pid) => can(user, p, pid);

  // Coleções inteiras protegidas por uma permissão
  const whole = { settings: 'rules', security: 'rules', integrations: 'integrations', teams: 'teams', notebooks: 'notebooks', skills: 'skills', playbooks: 'schedule' };
  for (const [k, p] of Object.entries(whole)) if (inc[k] !== undefined && perm(p)) out[k] = inc[k];

  if (inc.mcps !== undefined && perm('mcp')) out.mcps = inc.mcps.map((m) => ({ ...m, env: (m.env || []).map((e) => ({ key: String(e.key || '').toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 64) })).filter((e) => e.key) }));

  if (inc.schedules !== undefined && perm('schedule')) {
    const old = byId(cur.schedules);
    out.schedules = inc.schedules.map((s) => { const o = old.get(s.id) || {}; const c = { ...s }; for (const f of SERVER_SCHED_FIELDS) c[f] = o[f] ?? (f === 'history' ? [] : null); return c; });
  }

  // Contas de IA: cada pessoa cria, altera e apaga só as próprias (administrador, todas)
  if (inc.accounts !== undefined) {
    const curA = byId(cur.accounts);
    const mine = (a) => a.owner === user.id || perm('users');
    const clean = (a, owner) => ({
      id: String(a.id || '').slice(0, 64), name: String(a.name || '').slice(0, 80), owner,
      engine: ['claude', 'codex', 'gemini'].includes(a.engine) ? a.engine : 'claude', target: String(a.target || '').slice(0, 300),
      share: ['private', 'people', 'all'].includes(a.share) ? a.share : 'private', people: Array.isArray(a.people) ? a.people.map(String).slice(0, 200) : [],
    });
    const result = (cur.accounts || []).filter((a) => !mine(a));
    for (const a of inc.accounts) { const o = curA.get(a.id); if (o && !mine(o)) continue; if (a.id) result.push(clean(a, o ? o.owner : user.id)); }
    out.accounts = result;
  }

  // Preferências: cada pessoa só mexe nas próprias
  if (inc.prefs && inc.prefs[user.id]) out.prefs = { ...(cur.prefs || {}), [user.id]: inc.prefs[user.id] };

  // Layout compartilhado
  for (const k of ['view', 'zTop', 'focused', 'workspaces', 'wsId']) if (inc[k] !== undefined) out[k] = inc[k];

  // Projetos e grupos: invisíveis ficam como estão; visíveis só mudam com permissão
  if (inc.projects !== undefined) {
    const hidden = (cur.projects || []).filter((p) => !canSeeProject(user, p.id));
    out.projects = perm('projects') ? [...hidden, ...inc.projects.filter((p) => !hidden.some((h) => h.id === p.id))] : cur.projects;
  }
  if (inc.groups !== undefined && perm('projects')) {
    const incG = byId(inc.groups);
    const keepHidden = (g) => g.projectIds.filter((id) => !canSeeProject(user, id));
    out.groups = [...inc.groups.map((g) => { const o = (cur.groups || []).find((x) => x.id === g.id); return o ? { ...g, projectIds: [...new Set([...keepHidden(o), ...g.projectIds])] } : g; }),
      ...(cur.groups || []).filter((g) => !incG.has(g.id) && keepHidden(g).length)];
  }

  const projectById = (pid) => (out.projects || []).find((p) => p.id === pid);
  const CONFIG = ['label', 'icon', 'color', 'agent', 'skills', 'mcps', 'notify', 'branch', 'projectId', 'type'];
  const OWNERSHIP = ['owner', 'share', 'people', 'accountId'];
  const accounts = out.accounts || cur.accounts || [];
  const okUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } };

  function mergeNodes(curList = [], incList) {
    if (incList === undefined) return curList;
    const curMap = byId(curList), incMap = byId(incList);
    const result = [];
    for (const n of curList) {
      if (!v.visible(n)) { result.push(n); continue; }
      const nn = incMap.get(n.id);
      if (!nn) { // pessoa fechou a janela
        const allowed = n.type === 'note' ? perm('notebooks') : n.type === 'orch' ? perm('agents') : perm('message', n.projectId);
        if (!allowed) result.push(n);
        continue;
      }
      const m = { ...n, ...nn };
      if (!canNode(cur, user, 'agents', n)) for (const f of CONFIG) m[f] = n[f];
      if (n.owner && n.owner !== user.id && !perm('users')) for (const f of OWNERSHIP) m[f] = n[f];
      m.owner = n.owner || user.id;
      if (m.accountId && m.accountId !== n.accountId && !canUseAccount(accounts.find((a) => a.id === m.accountId), user)) m.accountId = n.accountId;
      if (n.type === 'portal') m.url = okUrl(m.url) || n.url;
      if (n.type === 'note' && !perm('notebooks')) { m.text = n.text; m.label = n.label; }
      const p = projectById(n.projectId);
      if (!canNode(cur, user, 'danger', n) || p?.env === 'prod') m.danger = p?.env === 'prod' ? false : !!n.danger;
      m.type = n.type; m.projectId = n.projectId; m.id = n.id;
      result.push(m);
    }
    for (const nn of incList) {
      if (curMap.has(nn.id)) continue;
      const p = projectById(nn.projectId);
      const ok = nn.type === 'note' ? perm('notebooks') : nn.type === 'orch' ? perm('agents') : nn.type === 'portal' ? perm('view') && okUrl(nn.url)
        : nn.type === 'files' ? !!p && perm('view', nn.projectId) : (nn.type === 'agent' && p && perm('message', nn.projectId));
      if (!ok) continue;
      const acc = nn.accountId && accounts.find((a) => a.id === nn.accountId);
      result.push({ ...nn, owner: user.id, accountId: acc && canUseAccount(acc, user) ? nn.accountId : '', share: ['private', 'project', 'people'].includes(nn.share) ? nn.share : (p?.collab === false ? 'private' : 'project'),
        url: nn.type === 'portal' ? okUrl(nn.url) : undefined, danger: nn.type === 'agent' && p?.env !== 'prod' && perm('danger', nn.projectId) ? !!nn.danger : false });
    }
    return result;
  }
  out.nodes = mergeNodes(cur.nodes, inc.nodes);
  out.archive = mergeNodes(cur.archive, inc.archive);
  if (inc.wsData !== undefined) {
    out.wsData = {};
    const keys = new Set([...Object.keys(cur.wsData || {}), ...Object.keys(inc.wsData || {})]);
    for (const k of keys) {
      const c = (cur.wsData || {})[k], i = (inc.wsData || {})[k];
      if (i) out.wsData[k] = { ...(c || {}), ...i, nodes: mergeNodes(c?.nodes || [], i.nodes || []) };
      else if (c) { const hidden = (c.nodes || []).filter((n) => !v.visible(n)); if (hidden.length) out.wsData[k] = { ...c, nodes: hidden }; }
    }
  }

  // Ligações: as que envolvem algo invisível ficam; o resto segue a tela, se a pessoa pode enviar mensagens
  if (inc.links !== undefined) {
    const all = byId([...(out.nodes || []), ...(out.archive || []), ...Object.values(out.wsData || {}).flatMap((w) => w.nodes || [])]);
    const visibleId = (id) => v.visible(all.get(id) || v.nodeMap.get(id));
    const hiddenLinks = (cur.links || []).filter((l) => !visibleId(l.a) || !visibleId(l.b));
    out.links = perm('message') ? [...hiddenLinks, ...inc.links.filter((l) => all.has(l.a) && all.has(l.b) && visibleId(l.a) && visibleId(l.b))] : cur.links;
  }
  return out;
}
