import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell, type WebContents } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ActionResult, KindleSettingsInput, ListQuery } from '../shared/types'
import { sendToKindle, testSmtp } from './kindle'
import { booksOnKindle, copyToKindle, ejectKindle, findKindles } from './kindle-usb'
import { Library } from './library'
import { SUPPORTED_FORMATS } from './metadata'
import { SettingsStore } from './settings'

protocol.registerSchemesAsPrivileged([
  { scheme: 'cover', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

let library: Library
let settings: SettingsStore

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 500,
    title: 'Shelfie',
    // Packaged builds take the icon from the .exe; in dev, point at the source PNG.
    icon: app.isPackaged ? undefined : join(__dirname, '../../build/icon.png'),
    backgroundColor: '#16171b',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

function registerIpc(): void {
  ipcMain.handle('library:list', (_e, query: ListQuery) => library.db.listBooks(query ?? {}))
  const importWithProgress = (sender: WebContents, paths: string[]) =>
    library.importFiles(paths, (done, total) => {
      if (!sender.isDestroyed()) sender.send('library:importProgress', { done, total })
    })

  ipcMain.handle('library:import', (e, paths: string[]) => importWithProgress(e.sender, paths))
  ipcMain.handle('library:pickAndImport', async (e, folders?: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender)!
    const { canceled, filePaths } = await dialog.showOpenDialog(
      win,
      folders
        ? { title: 'Add a folder of books', properties: ['openDirectory', 'multiSelections'] }
        : {
            title: 'Add books',
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'Ebooks', extensions: SUPPORTED_FORMATS }]
          }
    )
    return canceled ? [] : importWithProgress(e.sender, filePaths)
  })
  ipcMain.handle('library:remove', async (_e, id: number) => {
    const dir = library.absDir(id)
    if (dir) await shell.trashItem(dir).catch(() => undefined)
    library.db.deleteBook(id)
  })
  ipcMain.handle('library:showInFolder', (_e, id: number) => {
    const dir = library.absDir(id)
    if (dir) shell.openPath(dir)
  })
  ipcMain.handle('library:path', () => library.root)
  ipcMain.handle('library:convertToEpub', async (_e, id: number): Promise<ActionResult> => {
    try {
      await library.convertToEpub(id)
      return { ok: true, message: 'Converted to EPUB' }
    } catch (err) {
      return { ok: false, message: `Conversion failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  ipcMain.handle('settings:get', () => settings.get())
  ipcMain.handle('settings:save', (_e, input: KindleSettingsInput) => settings.save(input))
  ipcMain.handle('kindle:testSmtp', (_e, input: KindleSettingsInput) => testSmtp(settings, input))
  ipcMain.handle('kindle:send', (_e, id: number) => sendToKindle(library, settings, id))

  // The renderer only passes back roots that findKindles returned; copyToKindle re-checks it's a Kindle.
  ipcMain.handle('usb:find', () => findKindles())
  ipcMain.handle('usb:booksOnKindle', (_e, root: string) => booksOnKindle(library, root))
  ipcMain.handle('usb:copy', (_e, id: number, root: string) => copyToKindle(library, id, root))
  ipcMain.handle('usb:eject', (_e, root: string) => ejectKindle(root))
}

app.whenReady().then(() => {
  // Libraries created before the rename live in "eBookManager Library"; keep using that if it exists.
  const legacyRoot = join(app.getPath('documents'), 'eBookManager Library')
  const root =
    process.env.EBM_LIBRARY_DIR || (existsSync(legacyRoot) ? legacyRoot : join(app.getPath('documents'), 'Shelfie Library'))
  mkdirSync(root, { recursive: true })
  library = new Library(root)
  settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'))

  protocol.handle('cover', async (request) => {
    const id = Number(new URL(request.url).pathname.slice(1))
    const file = Number.isInteger(id) ? await library.coverPath(id) : undefined
    return file ? net.fetch(pathToFileURL(file).toString()) : new Response(null, { status: 404 })
  })

  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
