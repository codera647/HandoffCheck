const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld(
  'handoffDesktop',
  Object.freeze({
    signInWithGoogle: () => ipcRenderer.invoke('handoffcheck:google-sign-in'),
  }),
);
