const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

// Stabilité VM (GPU flaky)
app.commandLine.appendSwitch("disable-gpu");
app.disableHardwareAcceleration();

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    backgroundColor: "#0b0b0f",

    // IMPORTANT: on montre toujours la fenêtre
    show: true,

    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // DevTools auto (pour voir les erreurs renderer)
  mainWindow.webContents.openDevTools({ mode: "detach" });

  const indexPath = path.join(__dirname, "index.html");
  console.log("[main] load:", indexPath);

  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error("[main] did-fail-load:", code, desc, url);
  });

  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    console.error("[main] render-process-gone:", details);
  });

  mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    console.log(`[renderer console][lvl=${level}] ${message} (${sourceId}:${line})`);
  });

  mainWindow.loadFile(indexPath);

  const notifyViewport = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("viewport-changed");
  };

  mainWindow.on("resize", notifyViewport);
  mainWindow.on("enter-full-screen", notifyViewport);
  mainWindow.on("leave-full-screen", notifyViewport);

  ipcMain.on("toggle-fullscreen", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    win.setFullScreen(!win.isFullScreen());
    notifyViewport();
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
