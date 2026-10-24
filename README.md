# Flink

家庭内部使用的 macOS / Windows 桌面客户端。

- 新加坡 IPv6 优先，IPv4 自动回退
- 本地家庭码解锁，无后端、无账号注册
- 不收集遥测；配置在家目录中加密保存
- 桌面版使用系统代理（macOS / Windows）

## 运行

```bash
npm install
npm start
```

首次进入输入家庭码。家庭码保存在仓库外的 `../flink-codes.txt`，不会打进应用。

## 打包

```bash
npm run package:mac
npm run package:win
```

产物在 `dist/`，未签名：

- macOS：右键 → 打开，绕过 Gatekeeper
- Windows：SmartScreen → 更多信息 → 仍要运行

## 通过 GitHub 更新

1. 在 GitHub 建一个公开仓库，把本目录推上去。
2. 修改 `update-config.json`，把 `YOUR_GITHUB_USER/flink` 换成你的仓库。
3. 打 tag 并推送：

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions 会构建 macOS 和 Windows 包并生成 Release。App 里的“检查更新”会查询 GitHub Releases，发现新版本后打开下载页。

当前是“检查 + 手动替换”，不是自动覆盖安装。原因是 macOS/Windows 包没有签名，自动替换容易被系统拦截，也更危险。更新时：

- macOS：退出 App，替换 `Applications/Flink.app`
- Windows：退出 App，替换整个 `Flink` 文件夹

## 核心

`resources/singbox/` 内是未修改的 sing-box 官方二进制，版本 1.14.3。

sing-box 使用 GPLv3（含名称限制），源码与许可证：
https://github.com/SagerNet/sing-box

本应用源代码同样按 GPL-3.0-only 发布，详见 `NOTICE.md`。

## 当前范围

- macOS：系统代理；TUN 暂不在 UI 中启用
- Windows：系统代理；TUN 作为实验模式（需要管理员授权和 wintun.dll）
- Android：暂时使用官方 SFA + 二维码跑 TUN，见 `android/README.md`
- 自定义 Android 原生客户端（VpnService + 家庭码登录）尚未实现
