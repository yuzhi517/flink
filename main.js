const { app, BrowserWindow, ipcMain, shell, net: electronNet } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const net = require("node:net");
const { spawn, execFile } = require("node:child_process");

const PORT = 12345;
const PROFILES_PATH = path.join(__dirname, "profiles.json");
const BIN_DIR = path.join(__dirname, "resources", "singbox");
const BIN_NAME = process.platform === "win32" ? "sing-box.exe" : "sing-box";

let mainWindow = null;
let core = null;
let activeConfig = null;
let activeProfileName = null;
let proxyBackup = null;
let coreLogTail = [];
let tunMode = false;
let activeRegion = "sg";
let quitting = false;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || error.message));
      resolve(String(stdout || "").trim());
    });
  });
}

function loadProfiles() {
  if (!fs.existsSync(PROFILES_PATH)) return {};
  return JSON.parse(fs.readFileSync(PROFILES_PATH, "utf8"));
}

function decryptProfile(code, entry) {
  const normalized = String(code || "").trim().toUpperCase();
  const key = crypto.scryptSync(normalized, Buffer.from(entry.salt, "base64"), 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "base64"));
  decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(entry.data, "base64")), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

function tryUnlock(code) {
  const profiles = loadProfiles();
  for (const entry of Object.values(profiles)) {
    try {
      const config = decryptProfile(code, entry);
      return { ok: true, name: entry.name, config };
    } catch (_) {
      // Wrong code for this entry; try the next one.
    }
  }
  return { ok: false, error: "家庭码不正确" };
}

function isPortOpen(port, timeout = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

async function waitForPort(port, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    if (await isPortOpen(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function detectMacService() {
  try {
    const out = await run("networksetup", ["-listallnetworkservices"]);
    const services = out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("An asterisk"));
    for (const preferred of ["Wi-Fi", "Ethernet", "USB 10/100/1000 LAN"]) {
      if (services.includes(preferred)) return preferred;
    }
    return services[0] || "Wi-Fi";
  } catch (_) {
    return "Wi-Fi";
  }
}

async function readMacProxy(service, flag) {
  try {
    const out = await run("networksetup", [flag, service]);
    const values = {};
    for (const line of out.split("\n")) {
      const [key, ...rest] = line.split(":");
      if (rest.length) values[key.trim()] = rest.join(":").trim();
    }
    return {
      enabled: values.Enabled === "Yes",
      server: values.Server || "",
      port: values.Port || "",
    };
  } catch (_) {
    return { enabled: false, server: "", port: "" };
  }
}

async function readMacBypass(service) {
  try {
    const out = await run("networksetup", ["-getproxybypassdomains", service]);
    if (!out || /There aren't any bypass domains/i.test(out)) return [];
    return out.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

async function applyMacProxy(enable, backup) {
  const service = backup?.service || (await detectMacService());
  if (enable) {
    const web = await readMacProxy(service, "-getwebproxy");
    const secure = await readMacProxy(service, "-getsecurewebproxy");
    const socks = await readMacProxy(service, "-getsocksfirewallproxy");
    const bypass = await readMacBypass(service);
    proxyBackup = { service, web, secure, socks, bypass };
    await run("networksetup", ["-setwebproxy", service, "127.0.0.1", String(PORT)]);
    await run("networksetup", ["-setsecurewebproxy", service, "127.0.0.1", String(PORT)]);
    await run("networksetup", ["-setsocksfirewallproxy", service, "127.0.0.1", String(PORT)]);
    await run("networksetup", ["-setproxybypassdomains", service, "127.0.0.1", "localhost", "*.local"]);
    return;
  }
  if (!backup) return;
  const restore = async (flag, state) => {
    if (state.enabled && state.server && state.port) {
      await run("networksetup", [flag, backup.service, state.server, state.port]);
    } else {
      await run("networksetup", [flag, backup.service, "off"]);
    }
  };
  await restore("-setwebproxy", backup.web);
  await restore("-setsecurewebproxy", backup.secure);
  await restore("-setsocksfirewallproxy", backup.socks);
  if (backup.bypass?.length) {
    await run("networksetup", ["-setproxybypassdomains", backup.service, ...backup.bypass]);
  } else {
    await run("networksetup", ["-setproxybypassdomains", backup.service, "Empty"]);
  }
}

async function ps(command) {
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]);
}

async function applyWindowsProxy(enable) {
  const key = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  if (enable) {
    const raw = await ps(
      `$p='${key}'; $v=Get-ItemProperty -Path $p; Write-Output ($v.ProxyEnable|Out-String); Write-Output ($v.ProxyServer|Out-String); Write-Output ($v.ProxyOverride|Out-String)`,
    );
    const [enabled, server, override] = raw.split(/\r?\n/).map((line) => line.trim());
    proxyBackup = { enabled, server, override };
    await ps(
      `$p='${key}'; Set-ItemProperty -Path $p -Name ProxyEnable -Value 1; Set-ItemProperty -Path $p -Name ProxyServer -Value '127.0.0.1:${PORT}'; Set-ItemProperty -Path $p -Name ProxyOverride -Value '<local>;127.0.0.1;localhost'; Add-Type -Namespace WinInet -Name Native -MemberDefinition '[DllImport("wininet.dll")] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);'; [WinInet.Native]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null`,
    );
    return;
  }
  if (!proxyBackup) return;
  const enabled = proxyBackup.enabled === "1" ? 1 : 0;
  const server = (proxyBackup.server || "").replace(/'/g, "''");
  const override = (proxyBackup.override || "").replace(/'/g, "''");
  await ps(
    `$p='${key}'; Set-ItemProperty -Path $p -Name ProxyEnable -Value ${enabled}; Set-ItemProperty -Path $p -Name ProxyServer -Value '${server}'; Set-ItemProperty -Path $p -Name ProxyOverride -Value '${override}'; Add-Type -Namespace WinInet -Name Native -MemberDefinition '[DllImport("wininet.dll")] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);'; [WinInet.Native]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null`,
  );
}

async function setSystemProxy(enable) {
  if (process.platform === "darwin") return applyMacProxy(enable, proxyBackup);
  if (process.platform === "win32") return applyWindowsProxy(enable);
  throw new Error("当前系统暂不支持自动设置代理");
}

function coreBinary() {
  return path.join(BIN_DIR, BIN_NAME);
}

function stopCore() {
  if (core && !core.killed) {
    try {
      core.kill("SIGTERM");
    } catch (_) {}
  }
  core = null;
}

function selectedConfig(region = activeRegion) {
  const config = structuredClone(activeConfig);
  const group = region === "us" ? "us-auto" : "sg-auto";
  if (config.route) config.route.final = group;
  if (Array.isArray(config.dns?.servers)) {
    for (const server of config.dns.servers) {
      if (server.tag === "dns-remote") server.detour = group;
    }
  }
  return config;
}

async function startCore(region = activeRegion) {
  if (!activeConfig) throw new Error("请先输入家庭码");
  if (core && !core.killed) return;
  if (!fs.existsSync(coreBinary())) throw new Error(`缺少 sing-box 核心：${coreBinary()}`);

  const runtimeDir = app.getPath("userData");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const configPath = path.join(runtimeDir, "sing-box.json");
  fs.writeFileSync(configPath, JSON.stringify(selectedConfig(region), null, 2), { mode: 0o600 });

  coreLogTail = [];
  core = spawn(coreBinary(), ["run", "-c", configPath], {
    cwd: runtimeDir,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk) => {
    const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
    coreLogTail = [...coreLogTail, ...lines].slice(-20);
  };
  core.stdout.on("data", collect);
  core.stderr.on("data", collect);
  core.once("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM") {
      coreLogTail = [...coreLogTail, `core exited: ${code ?? signal}`].slice(-20);
    }
    core = null;
  });

  if (!(await waitForPort(PORT))) {
    stopCore();
    throw new Error(`sing-box 未启动成功\n${coreLogTail.join("\n")}`);
  }
  try {
    await setSystemProxy(true);
  } catch (error) {
    stopCore();
    throw error;
  }
}

async function stop() {
  stopCore();
  try {
    await setSystemProxy(false);
  } finally {
    proxyBackup = null;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function adminShell(command) {
  if (process.platform === "darwin") {
    return run("osascript", ["-e", `do shell script ${JSON.stringify(command)} with administrator privileges`]);
  }
  throw new Error("当前系统不支持该提权方式");
}

function powershellQuote(value) {
  return String(value).replace(/'/g, "''");
}

function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (_) {
    return false;
  }
}

function tunConfig(base, region = activeRegion) {
  const config = selectedConfig(region);
  config.inbounds = [
    {
      type: "tun",
      tag: "tun-in",
      interface_name: process.platform === "win32" ? "Flink" : undefined,
      address: ["172.19.0.1/30", "fdfe:dcba:9876::1/126"],
      auto_route: true,
      strict_route: true,
      stack: process.platform === "win32" ? "gvisor" : "system",
      mtu: 9000,
    },
  ];
  return config;
}

async function startWindowsTun(runtimeDir, configPath, logPath) {
  if (!fs.existsSync(path.join(BIN_DIR, "wintun.dll"))) {
    throw new Error("缺少 wintun.dll");
  }
  const launcherPath = path.join(runtimeDir, "start-tun.cmd");
  const launcher = [
    "@echo off",
    `cd /d "${runtimeDir}"`,
    `"${coreBinary()}" run -c "${configPath}" > "${logPath}" 2>&1`,
    "",
  ].join("\r\n");
  fs.writeFileSync(launcherPath, launcher, { mode: 0o600 });

  await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Start-Process -FilePath '${powershellQuote(launcherPath)}' -Verb RunAs -WindowStyle Hidden`,
  ]);
  await new Promise((resolve) => setTimeout(resolve, 3500));

  let status = "";
  try {
    status = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p=Get-Process sing-box -ErrorAction SilentlyContinue; if ($p) { 'Up' } else { '' }`,
    ]);
  } catch (_) {}
  if (!/Up/i.test(status)) {
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    throw new Error(`Windows TUN 启动失败\n${log.split("\n").slice(-20).join("\n")}`);
  }
  tunMode = true;
}

async function startTun(region = activeRegion) {
  if (!activeConfig) throw new Error("请先输入家庭码");
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new Error("TUN 目前仅支持 macOS / Windows");
  }
  if (tunMode) return;
  if (!fs.existsSync(coreBinary())) throw new Error(`缺少 sing-box 核心：${coreBinary()}`);

  const runtimeDir = app.getPath("userData");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const configPath = path.join(runtimeDir, "sing-box-tun.json");
  const pidPath = path.join(runtimeDir, "sing-box-tun.pid");
  const logPath = path.join(runtimeDir, "sing-box-tun.log");
  fs.writeFileSync(configPath, JSON.stringify(tunConfig(activeConfig, region), null, 2), { mode: 0o600 });
  fs.rmSync(pidPath, { force: true });

  if (process.platform === "win32") {
    await startWindowsTun(runtimeDir, configPath, logPath);
    return;
  }

  const command = [
    `${shellQuote(coreBinary())} run -c ${shellQuote(configPath)} > ${shellQuote(logPath)} 2>&1 &`,
    `echo $! > ${shellQuote(pidPath)}`,
  ].join(" ");
  await adminShell(command);
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const pid = fs.existsSync(pidPath) ? fs.readFileSync(pidPath, "utf8").trim() : "";
  let commandLine = "";
  try {
    commandLine = pid ? await run("ps", ["-p", pid, "-o", "command="]) : "";
  } catch (_) {}
  if (!pid || !pidAlive(pid) || !commandLine.includes("sing-box")) {
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    throw new Error(`TUN 启动失败\n${log.split("\n").slice(-20).join("\n")}`);
  }
  tunMode = true;
}

async function stopTun() {
  const runtimeDir = app.getPath("userData");
  if (process.platform === "win32") {
    try {
      await run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Start-Process -FilePath 'taskkill.exe' -ArgumentList '/IM sing-box.exe /F' -Verb RunAs -WindowStyle Hidden`,
      ]);
    } catch (_) {}
    tunMode = false;
    return;
  }
  const pidPath = path.join(runtimeDir, "sing-box-tun.pid");
  if (!fs.existsSync(pidPath)) {
    tunMode = false;
    return;
  }
  const pid = fs.readFileSync(pidPath, "utf8").trim();
  if (pid) {
    await adminShell(`kill ${shellQuote(pid)} 2>/dev/null || true; rm -f ${shellQuote(pidPath)}`);
  }
  tunMode = false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    title: "Flink",
    icon: path.join(__dirname, "resources", "icon.png"),
    backgroundColor: "#f8f6fc",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.handle("unlock", async (_event, code) => {
  const result = tryUnlock(code);
  if (result.ok) {
    activeConfig = result.config;
    activeProfileName = result.name;
    return { ok: true, name: result.name };
  }
  return { ok: false, error: result.error };
});

ipcMain.handle("connect", async (_event, mode = "proxy", region = "sg") => {
  try {
    activeRegion = region === "us" ? "us" : "sg";
    if (mode === "tun") {
      if (core && !core.killed) await stop();
      await startTun(activeRegion);
    } else {
      if (tunMode) await stopTun();
      await startCore(activeRegion);
    }
    return { ok: true, name: activeProfileName, mode, region: activeRegion };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle("disconnect", async () => {
  try {
    await stop();
    if (tunMode) await stopTun();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle("status", async () => {
  let tunPid = "";
  try {
    const pidPath = path.join(app.getPath("userData"), "sing-box-tun.pid");
    if (fs.existsSync(pidPath)) tunPid = fs.readFileSync(pidPath, "utf8").trim();
  } catch (_) {}
  const connected = Boolean(
    (core && !core.killed && (await isPortOpen(PORT))) ||
      (tunMode && (process.platform === "win32" || (tunPid && pidAlive(tunPid)))),
  );
  return { connected, name: activeProfileName, mode: tunMode ? "tun" : "proxy", region: activeRegion };
});

function versionParts(value) {
  return String(value || "")
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function isNewerVersion(latest, current) {
  const a = versionParts(latest);
  const b = versionParts(current);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av !== bv) return av > bv;
  }
  return false;
}

ipcMain.handle("check-update", async () => {
  try {
    const configPath = path.join(__dirname, "update-config.json");
    const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
    const repo = String(config.repo || "").trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.startsWith("YOUR_")) {
      return { ok: false, error: "更新源未配置：请先在 update-config.json 填入 GitHub 仓库" };
    }
    const response = await electronNet.fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Flink-Updater",
      },
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: `GitHub 返回 ${response.status}\n${text.slice(0, 200)}` };
    }
    const release = await response.json();
    const latest = String(release.tag_name || "").replace(/^v/i, "");
    const current = app.getVersion();
    const platformName = process.platform === "darwin" ? "macOS" : "Windows";
    const asset = (release.assets || []).find((item) =>
      String(item.name || "").includes(platformName),
    );
    const checksums = (release.assets || []).find((item) => item.name === "checksums.txt");
    return {
      ok: true,
      current,
      latest,
      available: isNewerVersion(latest, current),
      url: release.html_url,
      assetName: asset?.name || "",
      downloadUrl: asset?.browser_download_url || release.html_url,
      checksumsUrl: checksums?.browser_download_url || "",
      notes: String(release.body || "").slice(0, 1200),
    };
  } catch (error) {
    return {
      ok: false,
      error: `无法连接 GitHub：${String(error?.message || error)}\n请先连接 VPN 后重试`,
    };
  }
});

async function downloadToFile(url, destination) {
  const response = await electronNet.fetch(url, {
    headers: { "User-Agent": "Flink-Updater" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, buffer);
  return buffer;
}

async function verifyChecksum(checksumsUrl, assetName, filePath) {
  if (!checksumsUrl) throw new Error("Release 没有 checksums.txt，拒绝自动安装");
  const response = await electronNet.fetch(checksumsUrl, {
    headers: { "User-Agent": "Flink-Updater" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`校验文件下载失败：HTTP ${response.status}`);
  const text = await response.text();
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.endsWith(assetName));
  if (!line) throw new Error("校验文件中找不到当前安装包");
  const expected = line.split(/\s+/)[0].toLowerCase();
  const actual = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  if (actual !== expected) throw new Error(`SHA256 校验失败\n期望 ${expected}\n实际 ${actual}`);
}

ipcMain.handle("install-update", async (_event, payload) => {
  if (process.platform !== "win32") {
    return { ok: false, error: "当前系统不支持一键安装更新" };
  }
  try {
    const { downloadUrl, checksumsUrl, assetName } = payload || {};
    if (!downloadUrl || !assetName) throw new Error("更新信息不完整");
    const stamp = Date.now();
    const tempRoot = path.join(app.getPath("temp"), `flink-update-${stamp}`);
    const zipPath = path.join(tempRoot, "update.zip");
    const extractDir = path.join(tempRoot, "extract");
    fs.mkdirSync(extractDir, { recursive: true });

    await downloadToFile(downloadUrl, zipPath);
    await verifyChecksum(checksumsUrl, assetName, zipPath);

    await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath '${powershellQuote(zipPath)}' -DestinationPath '${powershellQuote(extractDir)}' -Force`,
    ]);

    let newRoot = extractDir;
    if (!fs.existsSync(path.join(newRoot, "Flink.exe"))) {
      const nested = fs
        .readdirSync(extractDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(extractDir, entry.name))
        .find((entry) => fs.existsSync(path.join(entry, "Flink.exe")));
      if (nested) newRoot = nested;
    }
    if (!fs.existsSync(path.join(newRoot, "Flink.exe"))) {
      throw new Error("更新包中找不到 Flink.exe");
    }

    // The update is downloaded and verified while the VPN is still connected.
    // Disconnect only now, so the updater can replace the app without leaving a
    // stale system proxy or TUN route behind.
    if (tunMode) {
      await stopTun();
    } else {
      await stop();
    }

    const appDir = path.dirname(process.execPath);
    const scriptPath = path.join(tempRoot, "install-update.ps1");
    const script = [
      "param([string]$AppDir,[string]$NewDir,[int]$AppPid)",
      "Wait-Process -Id $AppPid -ErrorAction SilentlyContinue",
      "$backup = \"${AppDir}.old-$(Get-Date -Format yyyyMMddHHmmss)\"",
      "try {",
      "  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }",
      "  Move-Item -LiteralPath $AppDir -Destination $backup -Force",
      "  Move-Item -LiteralPath $NewDir -Destination $AppDir -Force",
      "  Start-Process -FilePath (Join-Path $AppDir 'Flink.exe')",
      "} catch {",
      "  if (Test-Path -LiteralPath $backup) {",
      "    if (Test-Path -LiteralPath $AppDir) { Remove-Item -LiteralPath $AppDir -Recurse -Force }",
      "    Move-Item -LiteralPath $backup -Destination $AppDir -Force",
      "  }",
      "  throw",
      "}",
      "",
    ].join("\r\n");
    fs.writeFileSync(scriptPath, script, { encoding: "utf8" });

    const ps = [
      "Start-Process -FilePath 'powershell.exe'",
      `-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${powershellQuote(scriptPath)}','-AppDir','${powershellQuote(appDir)}','-NewDir','${powershellQuote(newRoot)}','-AppPid','${process.pid}')`,
      "-Verb RunAs -WindowStyle Hidden",
    ].join(" ");
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
    setTimeout(() => app.quit(), 800);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle("latency", async () => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const started = Date.now();
    try {
      const response = await electronNet.fetch(
        `https://www.gstatic.com/generate_204?flink=${Date.now()}`,
        { cache: "no-store", signal: controller.signal },
      );
      if (!response.ok && response.status !== 204) {
        throw new Error(`HTTP ${response.status}`);
      }
      return { ok: true, ms: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle("open-external", async (_event, url) => {
  if (typeof url === "string" && /^https?:\/\//.test(url)) await shell.openExternal(url);
});

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(path.join(__dirname, "resources", "icon.png"));
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", (event) => {
  if (tunMode && !quitting) {
    event.preventDefault();
    quitting = true;
    stopTun()
      .catch(() => {})
      .finally(() => app.quit());
    return;
  }
  stopCore();
  try {
    // Best-effort synchronous restore. The async path is used by the UI button.
    if (process.platform === "darwin" && proxyBackup) {
      const { service, web, secure, socks } = proxyBackup;
      for (const [flag, state] of [
        ["-setwebproxy", web],
        ["-setsecurewebproxy", secure],
        ["-setsocksfirewallproxy", socks],
      ]) {
        if (!state) continue;
        if (state.enabled && state.server && state.port) {
          require("node:child_process").execFileSync("networksetup", [flag, service, state.server, state.port]);
        } else {
          require("node:child_process").execFileSync("networksetup", [flag, service, "off"]);
        }
      }
    }
  } catch (_) {}
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
