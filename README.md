# 防遗忘悬浮待办

一个基于 `Tauri 2 + React + TypeScript` 的跨平台桌面待办工具，目标不是做复杂项目管理，而是做一个始终在场、尽量不打扰、帮助你减少遗忘的悬浮待办条。

支持平台：
- Windows
- macOS

## 功能特性
- 始终置顶的桌面待办窗口
- 展开态 / 折叠态切换
- 折叠后可选择：
  - 贴边折叠条
  - 悬浮圆球
- 折叠态支持拖拽，轻点可展开
- 自动折叠，可配置 `10 / 30 / 60 / 300` 秒
- 全局快捷键展开：`Ctrl/Command + Shift + Space`
- 新增、完成、恢复、删除、置顶、编辑待办
- 展开窗口支持拖拽移动
- 展开窗口支持右下角拖拽调大小
- 支持设置展开宽度 / 展开高度
- 支持界面颜色主题切换
- 支持透明度调节
- 本地 JSON 持久化保存
- 支持开机自启

## 技术栈
- `Tauri 2`
- `React`
- `TypeScript`
- `Vite`
- `Rust`

## 本地开发
先安装依赖：

```powershell
pnpm install
```

启动前端开发服务器：

```powershell
pnpm dev
```

启动 Tauri 桌面应用：

```powershell
pnpm tauri dev
```

构建前端：

```powershell
pnpm build
```

检查 Rust / Tauri 后端：

```powershell
cargo check --manifest-path src-tauri\Cargo.toml
```

## 当前交互说明
- 点击窗口外空白处不会立即折叠
- 只有手动点击“折叠”或达到自动折叠时间后才会收起
- 展开态顶部区域可拖动窗口
- 展开态右下角拖拽手柄可调节大小
- 折叠态轻点会展开，拖动则移动折叠窗口位置

## 数据存储
应用会在 Tauri 的应用数据目录中保存：
- `todos.json`
- `settings.json`

数据模型包含：
- 待办列表
- 透明度
- 自动折叠时长
- 开机自启
- 是否贴边折叠
- 展开态宽高
- 窗口位置
- 当前主题

## 仓库结构
- `src/`：前端界面与交互
- `src-tauri/`：Tauri 配置与 Rust 后端
- `README.md`：项目说明
