import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { API_METHODS } from '../shared/api';
import { AppState } from '../shared/types';

const api: Record<string, unknown> = {};
for (const name of API_METHODS) {
  api[name] = (...args: unknown[]) => ipcRenderer.invoke(`api:${name}`, ...args);
}
api.onState = (cb: (s: AppState) => void) => {
  const handler = (_e: IpcRendererEvent, s: AppState) => cb(s);
  ipcRenderer.on('state', handler);
  return () => ipcRenderer.removeListener('state', handler);
};

contextBridge.exposeInMainWorld('api', api);
