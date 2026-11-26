# agy-bar

[English](./README.md) | **简体中文**

[![CI](https://github.com/xy-tuoren/agy-bar/actions/workflows/ci.yml/badge.svg)](https://github.com/xy-tuoren/agy-bar/actions/workflows/ci.yml)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg)](#)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

为 **Antigravity CLI (`agy`)** 原生打造的**零依赖仪表盘状态栏与 CLI 监控套件**：提供 **8 级精细上下文与额度进度条**、**5 分钟缓存过期倒计时**、**实时输出速率 (`tok/s`)**、**本地用量/预估费用统计 (`agy-bar stats`)** 与 **多 CLI 协作实时看板 (`agy-bar monitor`)**。

![agy-bar 真彩渲染预览](./assets/preview.svg)

![agy-bar 52 周终端 Token 热力图预览](./assets/stats-preview.svg)

---

## 为什么选 `agy-bar`？（零风险、纯原生 CLI 设计）

- **100% 走官方原生 `statusLine` 接口** — 不修改/不注入任何客户端二进制，不劫持代理，不接触账号凭据，完全不联网；**官方怎么更新都不会失效，零封号风险**。
- **无需安装桌面客户端** — 纯终端 `agy`、SSH 远程服务器、WSL 和多终端并行协作开箱即用。
- **极致流畅不卡顿** — 零第三方依赖，底栏热路径仅做 O(1) 单会话增量写入；历史汇总与多会话看板独立拆分为 `stats` / `monitor` 子命令，绝不拖慢输入体验。

---

## 核心特性

- **统一健康语义色 + 8 级精细进度条** — 左侧上下文（`CTX`）与右侧额度（`5h` / `7d`）默认统一采用 `健康绿 → 预警黄 → 危急红` 配色（也可通过 `colorMode` 切为双色区分）；默认 `smooth` 样式采用 Unicode 1/8 细分块（`███▍░░░░`），6 格即可呈现 48 级丝滑刻度，并完整识别 **Gemini 4 Carbon / Hydrogen / Neon / Argon** 与 **Claude** 额度池。
- **5 分钟缓存过期倒计时** — 显示缓存命中率与剩余保活倒计时（`CACHE 88%·3m42s`），剩余 `≤ 90s` 变黄、`≤ 30s` / `exp` 变红，帮你及时续轮避免重建缓存白烧额度。
- **清晰两行分工与克制配色** — 第一行专注「身份与累计总览」：空闲隐藏 `? for shortcuts` 噪音，直接展示 `目录 (分支*) · PX 7897`（工作态按需亮起 `● 34s · esc`、`⚡2`、`PLAN`/`SANDBOX`），右侧用低饱和配色汇总 `DAY 188M/$18.4 · WK 837M · MO 902M · ALL 931M │ 模型`；第二行左侧专注当前对话（`CTX` / `CACHE` / `TTFT·t/s` / `~$1.24`），右侧稳稳留给 `5h` / `7d` 账号额度条。
- **精确首字时间 (`TTFT`)、纯流式速率 (`tok/s`)、本对话/今日预估费用 (`CHAT ~$1.24 · DAY $13.18`) 与上下文增量** — 底栏第二行左侧分离展示首字等待时长与纯解码输出速率（`TTFT 1.9s·158t/s`，Node 22.13+ 只读数值时间戳，Node 20 自动降级），右侧 `5h` 额度旁直接展示**本对话预估消耗与今日预估费用**（均支持 `agy -c` 重启后完整延续，`< 1ms` 缓存增量刷新）。
- **终端全量 Token 活动面板与热力图 (`agy-bar stats`)** — 只读增量扫描本机 Antigravity CLI 与桌面端全部历史会话库（不读聊天正文，带增量缓存二次运行 `< 20ms`），在终端内直接渲染 **全量 / 今日 / 本月 / 年度 4 项总览卡片**、**52 周真彩终端活动热力图**（`purple` / `green` / `cyan` / `amber` 四套渐变）、连续活跃天数、CLI 与桌面端占比、各模型 TTFT/速率排行、**参考 API 费用与缓存省钱金额**及拼车额度变化。
- **终端标签页标题自动同步（`● 工作中` / `✓ 已完成`）** — 彻底解决 Ghostty / iTerm2 / Kitty / WezTerm 多开时标签页全叫 `agy --dangerously-skip-permissions` 的痛点：通过标准 OSC 0 自动显示状态图标 + 会话标题（零额外 Token 消耗）；同时提供 `agy-bar title "简短主题"`，让 Agent 利用已有上下文花 ~10 tokens 即可顺手更新标签摘要，零额外 API 请求。
- **无需 TUN 模式直连代理启动器 (`agy-bar run` & `agy-bar proxy`)** — 安装时自动在 `~/.local/bin/agy-bar` 创建全局短命令（与 `agy` 同目录）。直接运行 `agy-bar run` 即可**无需开启 TUN 模式**，自动识别本机系统代理或 Clash Verge / Clash / Surge / v2ray 本地监听端口（`7897`、`7890`、`6152`、`10809`、`1087` 等），为 `agy` 注入标准代理环境变量与回环安全的 `NO_PROXY` 并透传全部参数，零二进制侵入。
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

`install` 会自动把 `agy-bar` 短命令安装到 `~/.local/bin/agy-bar`（与 `agy` 同目录），在任意终端中直接运行 `agy-bar ...` 即可。

### 无需 TUN 模式直接敲 `agy` 自动走本地代理

在终端交互式执行 `install` 时，`agy-bar` 会先清楚说明并弹出 `[y/N]` 询问是否要在 `~/.zshrc` / `~/.bashrc` / `config.fish` 中添加 7 行可无损卸载的托管 `agy()` 函数（非交互脚本/默认不改你的 shell 配置，除非显式传 `--proxy-hook`）：

```sh
# 启用可选 Shell Hook 后，直接敲 agy 即可免 TUN 自动走代理（无代理时静默直连）
agy
agy -c --dangerously-skip-permissions

# 不改 ~/.zshrc 也能随时用 agy-bar run 启动
agy-bar run -c

# 将自动检测到的本地代理固定保存，或手动指定端口
agy-bar proxy auto
agy-bar proxy set http://127.0.0.1:7897

# 查看代理与 shell hook 状态、临时开关、或随时启用/移除 shell hook
agy-bar proxy status
agy-bar proxy off
agy-bar proxy hook      # 随时启用直接敲 agy 免 TUN
agy-bar proxy unhook    # 随时无损移除 ~/.zshrc 中的托管块

# 单次临时直连（绕过代理）或给当前终端导出代理变量
command agy -c          # 或: AGY_BAR_NO_PROXY=1 agy -c
eval "$(agy-bar proxy env)"
```

### 预览、用量统计、多 CLI 监视与抓包调试

```sh
# 在终端实时预览各类场景、预设与主题
agy-bar preview --scenario all --width 116
agy-bar preview --preset compact --theme nord --bar-style smooth

# 查看全量历史 Token 总览卡片、52 周真彩终端热力图与实时校准 API 预估费用
agy-bar stats
agy-bar stats 30d --palette green --source cli
agy-bar stats all --model neon --json

# 查看、手动同步或自定义模型参考单价（默认每 24 小时后台静默从公开 models.dev/LiteLLM 同步，零鉴权不阻塞底栏）
agy-bar pricing show
agy-bar pricing sync
agy-bar pricing set gemini-4-neon 3 15 0.15
agy-bar config set pricingAutoSync off   # 如需严格离线可随时关闭自动同步

# 实时监视多个并发 agy 终端
agy-bar monitor
agy-bar monitor --once

# 单次脱敏抓包并查看真实 AGY payload
agy-bar debug --capture
agy-bar debug

# 设置、查看或清除当前终端标签页标题（支持 Ghostty / iTerm2 / Kitty / WezTerm / Terminal）
agy-bar title "开发 agy-bar 状态栏"
agy-bar title
agy-bar title --clear
```

> **进阶技巧：让 Agent 换话题时自动缩写标签名（仅耗 ~10 tokens，零额外 API 调用）**
> 在你的全局 `~/.gemini/antigravity-cli/AGENTS.md`（或规则文件）里加上这一句即可：
> ```text
> 当用户在长对话中明显切换到新任务或新话题时，静默执行一次 `agy-bar title "<4~8字中文简短主题>"` 更新终端标签页标题。
> ```

### 个性化配置（修改后下次刷新即生效，无需重启 `agy`）

```sh
# 切换布局预设：dashboard | compact | minimal
agy-bar config preset compact

# 切换主题：auto | slate-dark | slate-light | ocean | nord | mono
agy-bar config theme ocean

# 切换进度条风格：segments（▮▮▮▯▯▯ 默认分格）| squares（■■■□□□）| pills（▰▰▰▱▱▱）| dots（●●●○○○）| smooth | blocks | line | ascii
agy-bar config bar-style segments

# 目录路径风格：short（~/code/agy-bar 默认精简路径）| parent（code/agy-bar）| name（agy-bar）
agy-bar config set dirStyle short

# 配色模式：health（左右统一健康绿→黄→红）| distinct（左侧蓝 / 右侧绿）
agy-bar config set colorMode health

# 开关单项（支持 dir、vim、cost、session、contextDelta、compactHint、cacheTtl、speed、git 等）
agy-bar config enable cost session contextDelta
agy-bar config disable dir speed

# 按模型单独设告警红线，或调整缓存倒计时 / 关闭本地账本
agy-bar config set modelThreshold.claude.warn 65 modelThreshold.claude.danger 85
agy-bar config set cacheTtlSec 300 ledger on

# 自检、查看与重置
agy-bar doctor
agy-bar config show
agy-bar config reset
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
