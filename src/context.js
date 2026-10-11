// Contexto compartilhado entre janelas ligadas.
import { findProject, linkedNodes, lastAgentText, getDoc } from './store.js';

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

export function describe(node) {
  if (node.type === 'note') return `[${node.label}] nota: ${clip(node.text, 600) || 'vazia'}`;
  if (node.type === 'orch') {
    const workers = linkedNodes(node.id).filter((x) => x.type === 'agent').map((x) => x.label);
    return `[${node.label}] orquestrador de: ${workers.join(', ') || 'nenhum projeto'}.`;
  }
  const p = findProject(node.projectId);
  if (!p) return `[${node.label}]`;
  const last = lastAgentText(node.id);
  return `[${node.label}] ${node.agent} em ${p.server.split('@').pop()}:${p.path}, branch ${node.branch}${p.env === 'prod' ? ' (produção)' : ''}.${last ? ' Última atividade: ' + clip(last, 300) : ''}`;
}

export function notebooksFor(node) {
  const doc = getDoc();
  const teams = (doc.teams || []).filter((t) => t.members.includes(node.id) || t.lead === node.id).map((t) => t.id);
  return (doc.notebooks || []).filter((b) => b.readers?.all || b.readers?.agents?.includes(node.id) || b.readers?.teams?.some((id) => teams.includes(id)));
}

export function contextFor(node) {
  const notes = notebooksFor(node).map((b) => `[Bloco de notas: ${b.title}]\n${String(b.content || '').slice(0, 4000)}`);
  const links = linkedNodes(node.id).map(describe);
  return [...notes, ...links].join('\n\n');
}
