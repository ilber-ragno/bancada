// Service worker da Bancada: mostra as notificações push e abre o painel ao tocar.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Bancada', body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Bancada', { body: data.body || '', tag: 'bancada', renotify: true }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow('/');
  }));
});
