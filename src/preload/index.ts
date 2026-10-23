import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { ImportProgress, LibraryApi } from '../shared/types'

const api: LibraryApi = {
  listBooks: (query) => ipcRenderer.invoke('library:list', query),
  importFiles: (paths) => ipcRenderer.invoke('library:import', paths),
  pickAndImport: (folders) => ipcRenderer.invoke('library:pickAndImport', folders),
  onImportProgress: (listener) => {
    const handler = (_e: IpcRendererEvent, progress: ImportProgress) => listener(progress)
    ipcRenderer.on('library:importProgress', handler)
    return () => ipcRenderer.off('library:importProgress', handler)
  },
  removeBook: (id) => ipcRenderer.invoke('library:remove', id),
  showInFolder: (id) => ipcRenderer.invoke('library:showInFolder', id),
  libraryPath: () => ipcRenderer.invoke('library:path'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  convertToEpub: (id) => ipcRenderer.invoke('library:convertToEpub', id),
  convertToAzw3: (id) => ipcRenderer.invoke('library:convertToAzw3', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (input) => ipcRenderer.invoke('settings:save', input),
  testSmtp: (input) => ipcRenderer.invoke('kindle:testSmtp', input),
  sendToKindle: (id) => ipcRenderer.invoke('kindle:send', id),
  findKindles: () => ipcRenderer.invoke('usb:find'),
  booksOnKindle: (root) => ipcRenderer.invoke('usb:booksOnKindle', root),
  copyToKindle: (id, root) => ipcRenderer.invoke('usb:copy', id, root),
  ejectKindle: (root) => ipcRenderer.invoke('usb:eject', root)
}

contextBridge.exposeInMainWorld('api', api)
