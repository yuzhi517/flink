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
const modeLabel = document.querySelector("#mode-label");
const modeNote = document.querySelector("#mode-note");

let name = "";
let busy = false;
let mode = "proxy";
const isMac = window.flink.platform === "darwin";

function showError(el, message) {
  el.textContent = message || "";
  el.hidden = !message;
}

function setBusy(value, label) {
  busy = value;
  unlockBtn.disabled = value;
  connectBtn.disabled = value;
  if (value) {
    statusDot.className = "status-dot busy";
    statusTitle.textContent = label || "处理中…";
  }
}

function setMode(next) {
  mode = next === "tun" ? "tun" : "proxy";
  for (const button of modeButtons) {
    button.classList.toggle("active", button.dataset.mode === mode);
  }
  modeLabel.textContent = mode === "tun" ? "全局 TUN" : "系统代理";
  if (isMac) {
    modeNote.textContent = "macOS 版暂不启用 TUN；系统代理已可覆盖浏览器和 AI 应用。";
  } else {
    modeNote.textContent =
      mode === "tun"
        ? "全局 TUN 会接管所有应用，连接时需要管理员授权。"
        : "系统代理不需要管理员权限；TUN 可接管不遵守系统代理的应用。";
  }
  for (const button of modeButtons) {
    if (button.dataset.mode === "tun" && isMac) button.disabled = true;
  }
}

function setConnected(connected) {
  statusDot.className = `status-dot${connected ? " on" : ""}`;
  statusTitle.textContent = connected ? "已连接" : "未连接";
  statusSub.textContent = connected
    ? `新加坡 · ${mode === "tun" ? "全局 TUN 已接管" : "系统代理已接管"}`
    : "新加坡 · 自动选择 IPv6 / IPv4";
  connectBtn.textContent = connected ? "断开连接" : "连接";
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
      const result = await window.flink.disconnect();
      if (!result.ok) throw new Error(result.error || "断开失败");
      setConnected(false);
    } else {
      const result = await window.flink.connect(mode);
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
  }
}

unlockBtn.addEventListener("click", unlock);
codeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") unlock();
});
connectBtn.addEventListener("click", toggleConnection);
for (const button of modeButtons) {
  button.addEventListener("click", () => {
    if (busy) return;
    setMode(button.dataset.mode);
    setConnected(false);
  });
}

logoutBtn.addEventListener("click", async () => {
  if (busy) return;
  try {
    await window.flink.disconnect();
  } catch (_) {}
  name = "";
  homeView.hidden = true;
  loginView.hidden = false;
  showError(loginError, "");
  showError(homeError, "");
  setMode("proxy");
  setConnected(false);
  codeInput.focus();
});

setMode("proxy");
window.flink.status().then((status) => {
  if (status?.mode) setMode(status.mode);
  if (status?.connected) {
    // The renderer may reload while the core is still running.
    profileName.textContent = status.name || "家庭网络";
    loginView.hidden = true;
    homeView.hidden = false;
    setConnected(true);
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
      const link = document.createElement("a");
      link.textContent = "打开 GitHub 下载";
      link.href = "#";
      link.addEventListener("click", (event) => {
        event.preventDefault();
        window.flink.openExternal(result.downloadUrl || result.url);
      });
      resultEl.append(text, link);
    } catch (error) {
      resultEl.textContent = String(error);
    } finally {
      button.disabled = false;
    }
  });
}
