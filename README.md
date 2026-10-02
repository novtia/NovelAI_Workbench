# 画师串工作台

前后端分离的本地工作台：图库 / 抽奖 / 生图。架构为 **DDD 模块化单体 + 事件溯源**。旧目录 `ddd/` 只作对照与数据迁入源。

## 目录

```
workbench/
  frontend/    Vite + React + TypeScript  :5174
  backend/     FastAPI + SQLite 事件库     :8766
```

## 启动

在 `workbench` 目录双击 `start.bat`，或执行：

```powershell
.\start.ps1
```

会打开两个窗口：后端 `http://127.0.0.1:8766`，前端 `http://127.0.0.1:5174`。在启动脚本窗口按 Ctrl+C，或关掉任一服务窗口，两边都会停。浏览器打开 `http://127.0.0.1:5174`。

首次使用需要 Python 3.12+（不要用系统里的 3.8）和 Node.js。后端虚拟环境推荐 uv：

```bash
cd workbench/backend
uv venv --python 3.12 .venv
uv pip install --python .venv/Scripts/python.exe fastapi "uvicorn[standard]" pydantic httpx pillow python-multipart pytest
.venv\Scripts\python.exe server.py
```

或双击 / 运行 `workbench/backend/start.bat`。

```bash
cd workbench/frontend
npm install
npm run dev
```

浏览器打开 `http://127.0.0.1:5174`。Vite 把 `/api` 代理到 `http://127.0.0.1:8766`。

## 数据

- 事件库与内容寻址文件：`backend/data/events.sqlite`、`backend/data/blobs/`
- Token 明文：`backend/data/secrets/nai.token`（不进事件）
- 首次启动若 `ddd/data/gallery.db` 存在且事件库为空，会只读迁入

备份：停止写入后复制 `events.sqlite` 与 `blobs/`。校验：`POST /api/integrity/verify`，重建投影：`POST /api/integrity/rebuild`。

## 测试

```bash
cd workbench/backend && .venv\Scripts\python.exe -m pytest
cd workbench/frontend && npm test
```
