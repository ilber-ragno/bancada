// Ponte mínima entre a tela e o app do Mac: só o Touch ID. A página nunca vê o token do app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bancadaMac', {
  canTouchId: () => ipcRenderer.invoke('touchid:can'),
  touchIdLogin: async (login) => { const r = await ipcRenderer.invoke('touchid:login', String(login || '')); if (r?.error) throw new Error(r.error); },
  touchIdEnable: async (on) => { const r = await ipcRenderer.invoke('touchid:enable', !!on); if (r?.error) throw new Error(r.error); },
});
