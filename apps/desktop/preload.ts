import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '../../packages/protocol';
import { stateSchema } from '../../packages/schemas';

const api: DesktopAPI = {
  settings: () => ipcRenderer.invoke('settings:get'),
  saveConfig: config => ipcRenderer.invoke('settings:save', config),
  saveCredential: (provider, value) => ipcRenderer.invoke('credential:save', provider, value),
  validateCredential: (provider, value) => ipcRenderer.invoke('credential:validate', provider, value),
  removeCredential: provider => ipcRenderer.invoke('credential:remove', provider),
  rotatePairing: () => ipcRenderer.invoke('pairing:rotate'),
  trigger: () => ipcRenderer.invoke('assistant:trigger'),
  copyCode: requestId => ipcRenderer.invoke('assistant:copy', requestId),
  resizeWidget: (width, height) => ipcRenderer.send('widget:resize', width, height),
  onState: callback => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
      const state = stateSchema.safeParse(value); if (state.success) callback(state.data);
    };
    ipcRenderer.on('assistant:state', listener);
    ipcRenderer.send('assistant:subscribe');
    return () => ipcRenderer.removeListener('assistant:state', listener);
  }
};
contextBridge.exposeInMainWorld('assistant', api);
