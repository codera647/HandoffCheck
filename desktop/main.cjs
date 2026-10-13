const { app, BrowserWindow, dialog, ipcMain, Menu, shell, session } = require('electron');
const path = require('node:path');
const config = require('./generated/config.json');
const { isAppUrl, isExternalUrl, isTrustedSender } = require('./security.cjs');
const { startGoogleSignIn } = require('./auth.cjs');

const appOrigin = new URL(config.appUrl).origin;
if (!isAppUrl(config.appUrl, appOrigin)) throw new Error('Desktop app URL must use HTTPS.');
let window, pendingSignIn;

function externalLink(url) {
  if (isExternalUrl(url))
    void shell.openExternal(url).catch(() => {
      void dialog.showMessageBox(window, {
        type: 'error',
        message: 'The link could not be opened in your browser.',
      });
    });
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 680,
    minHeight: 500,
    title: 'HandoffCheck',
    backgroundColor: '#f7f7f4',
    show: false,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });
  window.once('ready-to-show', () => {
    if (process.env.HANDOFFCHECK_SMOKE_TEST !== '1') window.show();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    externalLink(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url, appOrigin)) {
      event.preventDefault();
      externalLink(url);
    }
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url, appOrigin)) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.on('closed', () => {
    pendingSignIn?.cancel();
    window = null;
  });
  try {
    await window.loadURL(config.appUrl);
  } catch {
    if (!window || window.isDestroyed()) return;
    window.show();
    const result = await dialog.showMessageBox(window, {
      type: 'error',
      title: 'HandoffCheck',
      message: 'The workspace could not be reached.',
      detail: 'HandoffCheck needs an internet connection. Check your connection, then retry.',
      buttons: ['Retry', 'Close'],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response === 0) {
      window.destroy();
      await createWindow();
    } else app.quit();
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) =>
      callback(
        permission === 'clipboard-sanitized-write' && isAppUrl(contents.getURL(), appOrigin),
      ),
    );
    session.defaultSession.setPermissionCheckHandler(
      (contents, permission) =>
        permission === 'clipboard-sanitized-write' &&
        !!contents &&
        isAppUrl(contents.getURL(), appOrigin),
    );
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { label: 'File', submenu: [{ role: 'quit' }] },
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
          ],
        },
        {
          label: 'View',
          submenu: [
            { role: 'reload' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { role: 'togglefullscreen' },
          ],
        },
        {
          label: 'Help',
          submenu: [
            {
              label: 'About HandoffCheck',
              click: () =>
                dialog.showMessageBox(window, {
                  title: 'HandoffCheck',
                  message: 'HandoffCheck ' + app.getVersion(),
                  detail:
                    'Product and engineering feature handoffs. This desktop app connects to the live workspace.',
                }),
            },
          ],
        },
      ]),
    );
    ipcMain.handle('handoffcheck:google-sign-in', async (event) => {
      if (!window || !isTrustedSender(event, window.webContents, appOrigin))
        throw new Error('Sign-in is unavailable from this page.');
      if (pendingSignIn) throw new Error('Google sign-in is already open in your browser.');
      pendingSignIn = startGoogleSignIn({
        supabaseUrl: config.supabaseUrl,
        publishableKey: config.publishableKey,
        openExternal: (url) => shell.openExternal(url),
      });
      try {
        const tokens = await pendingSignIn.promise;
        if (!window || !isTrustedSender(event, window.webContents, appOrigin))
          throw new Error('Return to the sign-in page and try again.');
        window.show();
        window.focus();
        return tokens;
      } finally {
        pendingSignIn = null;
      }
    });
    await createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
