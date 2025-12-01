//const { contextBridge, ipcRenderer } = require('electron/renderer');
//const { on } = require('ws');
const { ipcRenderer } = require('electron');

window.TX_API = { onServiceStatus: (callback) => ipcRenderer.on('serviceStatus', (_event, value) => callback(value))};

window.addEventListener('DOMContentLoaded', () => {
  const replaceText = (selector, text) => {
    const element = document.getElementById(selector)
    if (element) element.innerText = text
  }

  for (const type of ['chrome', 'node', 'electron']) {
    replaceText(`${type}-version`, process.versions[type])
  }
})

window.HAMLIB_API = {
  downloadHamlib: () => ipcRenderer.invoke('hamlib_download'),
  getHamlibVersion: () => ipcRenderer.invoke('hamlib_get_version'),
  getRigList: () => ipcRenderer.invoke('hamlib_list'),
  startRigctld: (opts) => ipcRenderer.invoke('hamlib_start_rigctld', opts),
  stopHamlib: () => ipcRenderer.invoke('hamlib_stop'),
  getSerialPorts: () => ipcRenderer.invoke('hamlib_get_serialports')
};
