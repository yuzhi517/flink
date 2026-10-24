const loginView = document.querySelector("#login-view");
const homeView = document.querySelector("#home-view");
const codeInput = document.querySelector("#code");
const unlockBtn = document.querySelector("#unlock-btn");
const loginError = document.querySelector("#login-error");
const logoutBtn = document.querySelector("#logout-btn");
const connectBtn = document.querySelector("#connect-btn");
const homeError = document.querySelector("#home-error");
const statusDot = document.querySelector("#status-dot");
const statusTitle = document.querySelector("#status-title");
const statusSub = document.querySelector("#status-sub");
const profileName = document.querySelector("#profile-name");
const modeButtons = [...document.querySelectorAll(".mode-btn")];
const modeNote = document.querySelector("#mode-note");
const regionButtons = [...document.querySelectorAll(".region-btn")];
const regionNote = document.querySelector("#region-note");
const latencyPill = document.querySelector("#latency-pill");
const latencyValue = document.querySelector("#latency-value");

let name = "";
let busy = false;
let mode = "proxy";
let region = "sg";
let latencyTimer = null;
let latencyInFlight = false;
const isMac = window.flink.platform === "darwin";

function showError(el, message) {
  el.textContent = message || "";
  el.hidden = !message;
}

function syncControlState() {
  for (const button of modeButtons) {
    button.disabled = busy || (isMac && button.dataset.mode === "tun");
  }
  for (const button of regionButtons) button.disabled = busy;
}

function setBusy(value, label) {
  busy = value;
  unlockBtn.disabled = value;
  connectBtn.disabled = value;
  syncControlState();
  if (value) {
    statusDot.className = "status-dot busy";
    statusTitle.textContent = label || "处理中…";
  }
}

function setMode(next) {
  mode = next === "tun" ? "tun" : "proxy";
  for (const button of modeButtons) {
    const active = button.dataset.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  if (isMac) {
    modeNote.textContent = "macOS 暂不启用 TUN，系统代理可覆盖浏览器和 AI 应用";
  } else {
    modeNote.textContent =
      mode === "tun"
        ? "全局 TUN 接管所有应用，连接时需管理员授权"
        : "系统代理不需要管理员权限，适合大多数应用";
  }
  syncControlState();
}

function setRegion(next) {
  region = next === "us" ? "us" : "sg";
  for (const button of regionButtons) {
    const active = button.dataset.region === region;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  regionNote.textContent =
    region === "us"
      ? "美国出口适合美区服务，延迟通常更高"
      : "新加坡适合 AI 与加密货币信息";
}

function stopLatencyPolling() {
  if (latencyTimer) {
    clearInterval(latencyTimer);
    latencyTimer = null;
  }
  latencyPill.hidden = true;
  latencyValue.textContent = "--";
  latencyValue.className = "latency-value";
}

async function refreshLatency() {
  if (latencyInFlight) return;
  latencyInFlight = true;
  try {
    const result = await window.flink.latency();
    if (!result.ok) {
      latencyValue.textContent = "超时";
      latencyValue.className = "latency-value bad";
      return;
    }
    const ms = Number(result.ms);
    latencyValue.textContent = `${ms} ms`;
    latencyValue.className =
      ms < 250 ? "latency-value good" : ms < 500 ? "latency-value warn" : "latency-value bad";
  } catch (_) {
    latencyValue.textContent = "超时";
    latencyValue.className = "latency-value bad";
  } finally {
    latencyInFlight = false;
  }
}

function startLatencyPolling() {
  stopLatencyPolling();
  latencyPill.hidden = false;
  latencyValue.textContent = "--";
  refreshLatency();
  latencyTimer = setInterval(refreshLatency, 5000);
}

function setConnected(connected) {
  const label = region === "us" ? "美国" : "新加坡";
  statusDot.className = `status-dot${connected ? " on" : ""}`;
  statusTitle.textContent = connected ? "已连接" : "未连接";
  statusSub.textContent = connected
    ? `${label} · ${mode === "tun" ? "全局 TUN 已接管" : "系统代理已接管"}`
    : `${label} · 自动选择 IPv6 / IPv4`;
  connectBtn.textContent = connected ? "断开连接" : "连接";
  if (connected) startLatencyPolling();
  else stopLatencyPolling();
}

async function unlock() {
  const code = codeInput.value.trim();
  if (!code) {
    showError(loginError, "请输入家庭码");
    return;
  }
  showError(loginError, "");
  unlockBtn.disabled = true;
  unlockBtn.textContent = "验证中…";
  try {
    const result = await window.flink.unlock(code);
    if (!result.ok) {
      showError(loginError, result.error || "家庭码不正确");
      return;
    }
    name = result.name || "家庭网络";
    profileName.textContent = name;
    loginView.hidden = true;
    homeView.hidden = false;
    codeInput.value = "";
    setConnected(false);
  } catch (error) {
    showError(loginError, String(error));
  } finally {
    unlockBtn.disabled = false;
    unlockBtn.textContent = "解锁并继续";
  }
}

async function toggleConnection() {
  if (busy) return;
  showError(homeError, "");
  setBusy(true, "正在连接…");
  try {
    const status = await window.flink.status();
    if (status.connected) {
      stopLatencyPolling();
      const result = await window.flink.disconnect();
      if (!result.ok) throw new Error(result.error || "断开失败");
      setConnected(false);
    } else {
      const result = await window.flink.connect(mode, region);
      if (!result.ok) throw new Error(result.error || "连接失败");
      setConnected(true);
    }
  } catch (error) {
    statusDot.className = "status-dot err";
    statusTitle.textContent = "连接失败";
    statusSub.textContent = "请检查网络或家庭码";
    showError(homeError, String(error.message || error));
    setConnected(false);
  } finally {
    busy = false;
    unlockBtn.disabled = false;
    connectBtn.disabled = false;
    syncControlState();
  }
}

async function applySettingChange(label) {
  if (busy) return;
  const status = await window.flink.status();
  if (!status.connected) {
    setConnected(false);
    return;
  }
  stopLatencyPolling();
  setBusy(true, label);
  try {
    const disconnected = await window.flink.disconnect();
    if (!disconnected.ok) throw new Error(disconnected.error || "切换失败");
    const result = await window.flink.connect(mode, region);
    if (!result.ok) throw new Error(result.error || "切换失败");
    setConnected(true);
  } catch (error) {
    statusDot.className = "status-dot err";
    statusTitle.textContent = "切换失败";
    statusSub.textContent = "请重试或断开后重新连接";
    showError(homeError, String(error.message || error));
    setConnected(false);
  } finally {
    busy = false;
    unlockBtn.disabled = false;
    connectBtn.disabled = false;
    syncControlState();
  }
}

unlockBtn.addEventListener("click", unlock);
codeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") unlock();
});
connectBtn.addEventListener("click", toggleConnection);

for (const button of modeButtons) {
  button.addEventListener("click", async () => {
    if (busy) return;
    setMode(button.dataset.mode);
    await applySettingChange("正在切换接管方式…");
  });
}

for (const button of regionButtons) {
  button.addEventListener("click", async () => {
    if (busy) return;
    setRegion(button.dataset.region);
    await applySettingChange("正在切换地区…");
  });
}

logoutBtn.addEventListener("click", async () => {
  if (busy) return;
  try {
    await window.flink.disconnect();
  } catch (_) {}
  try {
    await window.flink.forgetSession();
  } catch (_) {}
  stopLatencyPolling();
  name = "";
  homeView.hidden = true;
  loginView.hidden = false;
  showError(loginError, "");
  showError(homeError, "");
  setMode("proxy");
  setRegion("sg");
  setConnected(false);
  codeInput.focus();
});

setMode("proxy");
setRegion("sg");
window.flink.status().then((status) => {
  if (status?.mode) setMode(status.mode);
  if (status?.region) setRegion(status.region);
  if (status?.name) {
    profileName.textContent = status.name;
    loginView.hidden = true;
    homeView.hidden = false;
    setConnected(Boolean(status.connected));
  }
});

for (const button of document.querySelectorAll(".update-btn")) {
  button.addEventListener("click", async () => {
    const resultEl = button.nextElementSibling;
    if (!resultEl) return;
    button.disabled = true;
    resultEl.hidden = false;
    resultEl.textContent = "正在检查更新…";
    try {
      const result = await window.flink.checkUpdate();
      if (!result.ok) {
        resultEl.textContent = result.error || "检查更新失败";
        return;
      }
      if (!result.available) {
        resultEl.textContent = `已是最新版本（v${result.current}）`;
        return;
      }
      resultEl.textContent = "";
      const text = document.createTextNode(`发现新版本 v${result.latest}：`);
      resultEl.append(text);
      if (window.flink.platform === "win32") {
        const installButton = document.createElement("button");
        installButton.type = "button";
        installButton.className = "ghost update-install";
        installButton.textContent = "下载并安装";
        installButton.addEventListener("click", async () => {
          installButton.disabled = true;
          resultEl.textContent = "准备下载更新…";
          const unsubscribe = window.flink.onUpdateProgress((progress) => {
            if (progress.stage === "download") {
              if (progress.percent) {
                resultEl.textContent = `正在下载更新… ${progress.percent}%`;
              } else if (progress.received) {
                resultEl.textContent = `正在下载更新… ${(progress.received / 1048576).toFixed(1)} MB`;
              }
            } else if (progress.stage === "verify") {
              resultEl.textContent = "正在校验 SHA256…";
            } else if (progress.stage === "install") {
              resultEl.textContent = "正在断开 VPN 并安装，App 即将退出…";
            }
          });
          try {
            const install = await window.flink.installUpdate({
              downloadUrl: result.downloadUrl,
              checksumsUrl: result.checksumsUrl,
              assetName: result.assetName,
            });
            if (!install.ok) {
              resultEl.textContent = install.error || "安装失败";
              installButton.disabled = false;
              return;
            }
            resultEl.textContent = "下载完成，正在断开 VPN 并安装，App 即将退出…";
          } catch (error) {
            resultEl.textContent = String(error);
            installButton.disabled = false;
          } finally {
            unsubscribe?.();
          }
        });
        resultEl.append(installButton);
      } else {
        const link = document.createElement("a");
        link.textContent = "打开 GitHub 下载";
        link.href = "#";
        link.addEventListener("click", (event) => {
          event.preventDefault();
          window.flink.openExternal(result.downloadUrl || result.url);
        });
        resultEl.append(link);
      }
    } catch (error) {
      resultEl.textContent = String(error);
    } finally {
      button.disabled = false;
    }
  });
}
