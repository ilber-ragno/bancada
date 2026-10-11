// Canal de eventos por WebSocket. Cada evento só chega a quem pode vê-lo.
const clients = new Set(); // { ws, userId, sid }
let canSee = () => true;
let stillValid = () => true;
let userById = () => null;

export function configureBus({ filter, validate, findUser }) {
  canSee = filter; stillValid = validate; userById = findUser;
}

export function addClient(ws, userId, sid) {
  const c = { ws, userId, sid };
  clients.add(c);
  ws.on('close', () => clients.delete(c));
}

function deliver(c, data) {
  if (c.ws.readyState !== 1) return;
  if (!stillValid(c.sid, c.userId)) { try { c.ws.close(4401, 'sessão encerrada'); } catch {} clients.delete(c); return; }
  c.ws.send(data);
}

export function broadcast(event) {
  const data = JSON.stringify(event);
  for (const c of clients) {
    const u = userById(c.userId);
    if (u && canSee(u, event)) deliver(c, data);
  }
}

export function sendTo(userId, event) {
  const data = JSON.stringify(event);
  for (const c of clients) if (c.userId === userId) deliver(c, data);
}

export function dropUser(userId) {
  for (const c of clients) if (c.userId === userId) { try { c.ws.close(4401, 'acesso alterado'); } catch {} clients.delete(c); }
}
