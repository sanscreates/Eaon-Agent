// Bridge between the renderer and the app shell. The renderer gets a small,
// explicit API — no Node, no direct access to the agent process.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eaon', {
  /** Send a request to the engine; resolves with the result or throws. */
  async call(type, payload) {
    const res = await ipcRenderer.invoke('engine:call', type, payload ?? {});
    if (!res?.ok) throw new Error(res?.error ?? 'engine error');
    return res.result;
  },

  /** Subscribe to engine events (text chunks, tool calls, permission asks…). */
  onEvent(handler) {
    const listener = (_e, msg) => handler(msg);
    ipcRenderer.on('engine:event', listener);
    return () => ipcRenderer.off('engine:event', listener);
  },

  /** Menu items and global shortcuts arrive here. */
  onAction(handler) {
    const listener = (_e, msg) => handler(msg);
    ipcRenderer.on('ui:action', listener);
    return () => ipcRenderer.off('ui:action', listener);
  },

  pickFolder: () => ipcRenderer.invoke('app:pick-folder'),
  info: () => ipcRenderer.invoke('app:info'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  openPath: (p) => ipcRenderer.invoke('app:open-path', p),
  setBackground: (color) => ipcRenderer.invoke('app:background', color),
});
