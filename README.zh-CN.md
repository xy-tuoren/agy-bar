# agy-bar

[English](./README.md) | **简体中文**

[![CI](https://github.com/xy-tuoren/agy-bar/actions/workflows/ci.yml/badge.svg)](https://github.com/xy-tuoren/agy-bar/actions/workflows/ci.yml)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg)](#)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

为 **Antigravity CLI (`agy`)** 原生打造的**零依赖仪表盘状态栏与 CLI 监控套件**：提供 **8 级精细上下文与额度进度条**、**5 分钟缓存过期倒计时**、**实时输出速率 (`tok/s`)**、**本地用量/预估费用统计 (`agy-bar stats`)** 与 **多 CLI 协作实时看板 (`agy-bar monitor`)**。

![agy-bar 真彩渲染预览](./assets/preview.svg)

---

## 为什么选 `agy-bar`？（零风险、纯原生 CLI 设计）

- **100% 走官方原生 `statusLine` 接口** — 不修改/不注入任何客户端二进制，不劫持代理，不接触账号凭据，完全不联网；**官方怎么更新都不会失效，零封号风险**。
- **无需安装桌面客户端** — 纯终端 `agy`、SSH 远程服务器、WSL 和多终端并行协作开箱即用。
- **极致流畅不卡顿** — 零第三方依赖，底栏热路径仅做 O(1) 单会话增量写入；历史汇总与多会话看板独立拆分为 `stats` / `monitor` 子命令，绝不拖慢输入体验。

---

## 核心特性

- **统一健康语义色 + 8 级精细进度条** — 左侧上下文（`CTX`）与右侧额度（`5h` / `7d`）默认统一采用 `健康绿 → 预警黄 → 危急红` 配色（也可通过 `colorMode` 切为双色区分）；默认 `smooth` 样式采用 Unicode 1/8 细分块（`███▍░░░░`），6 格即可呈现 48 级丝滑刻度，并完整识别 **Gemini 4 Carbon / Hydrogen / Neon / Argon** 与 **Claude** 额度池。
- **5 分钟缓存过期倒计时** — 显示缓存命中率与剩余保活倒计时（`CACHE 88%·3m42s`），剩余 `≤ 90s` 变黄、`≤ 30s` / `exp` 变红，帮你及时续轮避免重建缓存白烧额度。
- **项目目录名 + Vim 徽章 + `/compact` 提醒** — 第一行直接展示 `目录名 (分支*)` 及自动识别的 Vim `[NORMAL]` / `[INSERT]` 徽章；当上下文触及危急红线时自动提示 `→/compact`。
- **精确首字时间 (`TTFT`)、纯流式速率 (`tok/s`)、可选花费 (`~$0.42`) 与上下文增量 (`+12.4K`)** — 在底栏同时展示首字等待时长与纯解码输出速率（`TTFT 1.9s·158t/s`，在 Node 22.13+ 上仅以只读模式读取本地会话数值时间戳，不读聊天正文，Node 20 自动降级为纯 `stdin` 估算，支持 `config set dbTiming off` 关闭），把「等待思考多久」和「真正吐字多快」彻底分开，并同步汇总到 `stats` 与 `monitor`。
- **本地用量账本与费用估算 (`agy-bar stats`)** — 支持 `today` / `7d` / `30d` / `all` 统计、按模型/思考档位汇总、每日柱状图、**参考 API 预估费用与缓存省钱金额**，并展示本机观测到的额度净变化（非常适合拼车/多号场景对账）。
- **终端标签页标题自动同步（`● 工作中` / `✓ 已完成`）** — 彻底解决 Ghostty / iTerm2 / Kitty / WezTerm 多开时标签页全叫 `agy --dangerously-skip-permissions` 的痛点：通过标准 OSC 0 自动显示状态图标 + 会话标题（零额外 Token 消耗）；同时提供 `agy-bar title "简短主题"`，让 Agent 利用已有上下文花 ~10 tokens 即可顺手更新标签摘要，零额外 API 请求。
- **多 CLI 协作监视面板 (`agy-bar monitor`)** — 一屏实时监控本机同时运行的所有 `agy` 终端。
- **脱敏抓包调试 (`agy-bar debug`)** — 支持单次自动脱敏捕获真实 `agy` payload，排查新版字段变更或提 Issue 极方便。
- **安全安装/无损卸载 + `/agy-bar` Skill** — 自动备份原有 `statusLine`，卸载一键还原；自带 `/agy-bar` Skill，可在 `agy` 中用自然语言调整配置或查统计。

---

## 快速安装

环境要求：**Node.js >= 20.0.0** 与 **Antigravity CLI (`agy`)**。

### 方式一：让 `agy` 自动帮你装（最省事）

直接在 `agy` 对话中发送这一句：

```text
请按 https://github.com/xy-tuoren/agy-bar/blob/main/AGENTS.md 帮我安装 agy-bar。
```

### 方式二：手动从 GitHub 安装

```sh
git clone https://github.com/xy-tuoren/agy-bar.git ~/agy-bar
cd ~/agy-bar
node bin/agy-bar.mjs install
```

### 方式三：通过 `npx` 安装（发布至 npm 后）

```sh
npx agy-bar install
```

安装完成后**重启 `agy`** 即可生效（已有会话可先运行 `/skills reload` 加载 `/agy-bar`）。若不想安装配套 Skill，加 `--no-skill`。

---

## 常用命令与配置

### 预览、用量统计、多 CLI 监视与抓包调试

```sh
# 在终端实时预览各类场景、预设与主题
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs preview --scenario all --width 116
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs preview --preset compact --theme nord --bar-style smooth

# 查看本机 CLI 用量统计、缓存节省与 API 预估费用
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs stats today
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs stats 7d --model claude
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs stats 30d --json

# 实时监视多个并发 agy 终端
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs monitor
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs monitor --once

# 单次脱敏抓包并查看真实 AGY payload
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs debug --capture
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs debug

# 设置、查看或清除当前终端标签页标题（支持 Ghostty / iTerm2 / Kitty / WezTerm / Terminal）
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs title "开发 agy-bar 状态栏"
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs title
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs title --clear
```

> **进阶技巧：让 Agent 换话题时自动缩写标签名（仅耗 ~10 tokens，零额外 API 调用）**
> 在你的全局 `~/.gemini/antigravity-cli/AGENTS.md`（或规则文件）里加上这一句即可：
> ```text
> 当用户在长对话中明显切换到新任务或新话题时，静默执行一次 `node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs title "<4~8字中文简短主题>"` 更新终端标签页标题。
> ```

### 个性化配置（修改后下次刷新即生效，无需重启 `agy`）

```sh
# 切换布局预设：dashboard | compact | minimal
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config preset compact

# 切换主题：auto | slate-dark | slate-light | ocean | nord | mono
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config theme ocean

# 切换进度条风格：smooth (███▍░░) | blocks (███░░░) | line (━━━───) | ascii ([###---])
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config bar-style smooth

# 配色模式：health（左右统一健康绿→黄→红）| distinct（左侧蓝 / 右侧绿）
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config set colorMode health

# 开关单项（支持 dir、vim、cost、session、contextDelta、compactHint、cacheTtl、speed、git 等）
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config enable cost session contextDelta
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config disable dir speed

# 按模型单独设告警红线，或调整缓存倒计时 / 关闭本地账本
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config set modelThreshold.claude.warn 65 modelThreshold.claude.danger 85
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config set cacheTtlSec 300 ledger on

# 自检、查看与重置
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs doctor
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config show
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config reset
```

### 更新与卸载

```sh
# 更新（保留个人配置、历史账本与原始 statusLine 备份）
cd ~/agy-bar && git pull && node bin/agy-bar.mjs install

# 卸载并无损恢复安装前的 statusLine
node ~/agy-bar/bin/agy-bar.mjs uninstall

# 彻底清理（同时删除配套 Skill 与 ~/.gemini/config/agy-bar 目录）
node ~/agy-bar/bin/agy-bar.mjs uninstall --remove-skill --purge
```

---

## 本地开发

```sh
npm test           # 运行内置单元测试（macOS / Linux / Windows 三端 CI 验证）
npm run preview    # 终端实时预览
npm run preview:svg # 重新生成 assets/preview.svg
npm run stats      # 查看本机统计
npm run monitor    # 启动多 CLI 监控面板
npm run doctor     # 检查本机安装状态
```

## 开源协议

[MIT](./LICENSE) © [xy-tuoren](https://github.com/xy-tuoren)
