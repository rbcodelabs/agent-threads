// Electron main script: render an HTML file to a PNG at an exact pixel size.
// usage: electron backdrop-main.cjs <html> <out.png> <width> <height>
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");

const [html, out, w, h] = process.argv.slice(-4);
const width = Number(w);
const height = Number(h);
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.disableHardwareAcceleration();
if (process.platform === "darwin") app.setActivationPolicy("accessory"); // no Dock icon, never steals focus

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width, height, useContentSize: true, show: false, frame: false, webPreferences: { backgroundThrottling: false } });
  await win.loadFile(html);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const image = await win.webContents.capturePage();
  const size = image.getSize();
  const final = size.width === width && size.height === height ? image : image.resize({ width, height, quality: "best" });
  fs.writeFileSync(out, final.toPNG());
  app.quit();
});
