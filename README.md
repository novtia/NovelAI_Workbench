# 画师串工作台

本地桌面工作台：图库 / 抽奖 / 生图。**Tauri 2 + Rust 后端 + React 前端**，架构为 DDD 模块化单体 + 事件溯源。旧目录 `ddd/` 只作对照与数据迁入源。

## 目录

```
workbench/
  frontend/    Vite + React + TypeScript（界面）
  src-tauri/   Rust 后端（Tauri 2）
    src/kernel/      事件库、哈希链、blob、投影重放、完整性校验
    src/contexts/    gallery（图库）/ lottery（抽奖）/ generation（生图）/ settings / identity
    src/commands.rs  前端调用的命令（取代原来的 HTTP 接口）
    src/protocol.rs  wb 自定义协议：给 <img> 提供图片
    tests/           集成测试与 Python 对照测试
  backend/data/      运行数据（事件库、图片、Token），不进版本库
```

前端与后端之间不再走 HTTP：命令用 Tauri `invoke`，生图任务进度用事件 `jobs-event`，图片用协议地址（Windows 上是 `http://wb.localhost/...`，其它平台是 `wb://localhost/...`）。

## 启动

首次需要 [Node.js](https://nodejs.org) 和 [Rust](https://rustup.rs)；Windows 还需要 WebView2（Win10/11 通常已自带）和 MSVC 生成工具。

在 `workbench` 目录双击 `start.bat`，或执行：

```powershell
.\start.ps1            # 开发模式：前端热更新 + 编译运行 Rust
.\start.ps1 -Build     # 打包安装程序
.\start.ps1 -Check     # 只检查环境
```

等价的手动命令：

```bash
cd workbench
npm install && npm --prefix frontend install
npm run dev       # = tauri dev
npm run build     # = tauri build，产物在 src-tauri/target/release/bundle
```

开发时前端固定使用 `5174` 端口（`src-tauri/tauri.conf.json` 的 `devUrl`），被占用会直接报错而不是换端口。

## 数据

数据目录的解析顺序：

1. 环境变量 `WORKBENCH_DATA_DIR`
2. 开发模式（`tauri dev`）：`backend/data`
3. 打包后的程序：exe 旁边已存在的 `data/` 目录
4. 否则系统应用数据目录（Windows：`%APPDATA%\ink.moyan.workbench`）

目录内容：

- 事件库与内容寻址文件：`events.sqlite`、`blobs/`
- Token 明文：`secrets/nai.token`（不进事件）
- 首次启动若事件库为空，且旧版 `ddd/data/gallery.db` 存在（开发目录结构下自动查找，或用环境变量 `WORKBENCH_LEGACY_DIR` 指定），会只读迁入

**沿用旧 Python 版的数据**：打包后的程序不会自动去 `backend/data` 找，请把整个 `backend/data` 复制到 exe 旁并改名为 `data`，或启动前设置 `WORKBENCH_DATA_DIR` 指向它。事件库格式与 Python 版完全兼容（哈希链、投影校验和都逐条对得上）。

备份：停止写入后复制 `events.sqlite` 与 `blobs/`。设置页的「系统」里可以校验完整性、重建投影。

## 测试

```bash
cd workbench/src-tauri && cargo test        # 单元测试 + 集成测试
cd workbench/frontend && npm test           # 前端测试
cd workbench/frontend && npm run build      # 类型检查 + 构建
```

`tests/golden.rs` 用真实旧库对照 Python 的结果，默认跳过；要运行时先设置 `WB_GOLDEN_DB`（旧 `events.sqlite` 的**副本**）和 `WB_GOLDEN_BASELINE`（`tests/py_baseline.py` 生成的基线 JSON），具体步骤见文件开头的注释。Python 后端源码已移除，备份在仓库上一级目录的 `workbench-python-backend-backup.zip`，生成基线前需先解压回 `backend/`。
