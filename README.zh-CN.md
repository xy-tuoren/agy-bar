# agy-bar

[English](./README.md) | **简体中文**

[![CI](https://github.com/xy-tuoren/agy-bar/actions/workflows/ci.yml/badge.svg)](https://github.com/xy-tuoren/agy-bar/actions/workflows/ci.yml)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg)](#)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

为 **Antigravity CLI (`agy`)** 打造的**零依赖现代极简仪表盘状态栏**：提供可视化上下文与额度进度条、缓存命中率、Git 分支/修改状态、多套配色主题与窄屏自适应降级。

```text
? for shortcuts · git:main*                                                 Gemini 4 Carbon · high
CTX ███░░░░░ 42.6% (1.0M) │ CACHE 88%              5h █████░ 85% (2h30m) │ 7d ████░░ 64% (3d)
```

---

## 核心特性

- **可视化进度条 + 分级预警** — 上下文窗口与 5 小时 / 每周额度均支持进度条展示，按阈值自动切换健康 / 警告 / 危急配色。
- **零依赖、纯本地离线** — 纯 Node.js ESM（`>= 20.0.0`），仅消费 AGY 通过 `stdin` 传入的状态 JSON 及当前仓库 `.git/HEAD`（可选脏状态检查），不联网、不读对话正文。
- **窄屏自适应** — 随终端宽度收窄按优先级自动隐藏次要信息（倒计时 → 进度条 → 缓存 → 容量），绝不折行顶乱界面。
- **3 套布局预设** — `dashboard`（经典双行仪表盘）、`compact`（紧凑单行）、`minimal`（极简数值）。
- **6 套内置主题** — `auto`（自动匹配 AGY 的 `colorScheme` 与终端明暗）、`slate-dark`、`slate-light`、`ocean`、`nord`、`mono`（原生支持 `NO_COLOR`）。
- **安全安装与无损卸载** — 自动备份 `~/.gemini/antigravity-cli/settings.json` 中原有的 `statusLine` 配置，卸载时无损还原。
- **配套 `/agy-bar` Skill** — 安装时默认附带配置向导 Skill，可在 `agy` 对话中直接用自然语言切换预设、主题与开关项。

---

## 快速安装

环境要求：**Node.js >= 20.0.0** 与 **Antigravity CLI (`agy`)**。

### 方式一：通过 GitHub 源码安装（推荐）

```sh
git clone https://github.com/xy-tuoren/agy-bar.git ~/agy-bar
cd ~/agy-bar
node bin/agy-bar.mjs install
```

### 方式二：通过 `npx` 安装（发布至 npm 后）

```sh
npx agy-bar install
```

安装完成后**重启 `agy`** 即可在底部看到新状态栏（已有会话可执行 `/skills reload` 加载 `/agy-bar`）。

如不希望安装配套 Skill，可加上 `--no-skill`：

```sh
node bin/agy-bar.mjs install --no-skill
```

---

## 自定义配置

### 终端实时预览

```sh
node bin/agy-bar.mjs preview --scenario all --width 100
node bin/agy-bar.mjs preview --preset compact --theme nord --bar-style line --width 84
```

### 命令行调整（即时生效，无需重启 `agy`）

配置保存在 `~/.gemini/config/agy-bar/config.json`：

```sh
# 切换布局预设：dashboard | compact | minimal
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config preset compact

# 切换主题：auto | slate-dark | slate-light | ocean | nord | mono
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config theme ocean

# 切换进度条样式：blocks (██░░) | line (━━──) | ascii ([##--])
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config bar-style line

# 开关单项显示
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config disable git cache
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config enable reset capacity

# 调整进度条宽度与告警阈值
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config set barWidth 8 contextWarn 75 quotaDanger 10

# 查看或重置配置
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config show
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config reset
```

### 在 `agy` 中用自然语言配置

- `/agy-bar 换成 compact 紧凑模式，主题用 nord`
- `/agy-bar 隐藏 git 和重置倒计时`
- `/agy-bar 把进度条改成线条样式`

---

## 诊断、更新与卸载

```sh
# 自检安装状态与渲染输出
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs doctor

# 更新（保留个人配置与原始 statusLine 备份）
cd ~/agy-bar && git pull && node bin/agy-bar.mjs install

# 卸载并还原安装前的 statusLine 配置
node ~/agy-bar/bin/agy-bar.mjs uninstall

# 彻底清理（同时删除配套 Skill 与配置目录）
node ~/agy-bar/bin/agy-bar.mjs uninstall --remove-skill --purge
```

---

## 本地开发与测试

```sh
npm test        # 运行内置单元测试（macOS / Linux / Windows 三端 CI 验证）
npm run preview # 在终端预览渲染效果
npm run doctor  # 检查本机安装状态
```

## 开源协议

[MIT](./LICENSE) © [xy-tuoren](https://github.com/xy-tuoren)
