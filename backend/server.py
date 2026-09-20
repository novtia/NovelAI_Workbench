"""画师串工作台后端启动入口。

在 backend 目录执行：

    python server.py

系统 Python 若低于 3.12，会自动改用 .venv 里的解释器。
默认端口 8766（Windows 上 8000 常被系统保留，会报 WinError 10013）。
可用环境变量 WORKBENCH_PORT 覆盖。
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

HOST = "127.0.0.1"
PREFERRED_PORTS = (8766, 18000, 8001, 8080)
MIN_VERSION = (3, 12)


def venv_python() -> Path | None:
    if sys.platform.startswith("win"):
        candidate = ROOT / ".venv" / "Scripts" / "python.exe"
    else:
        candidate = ROOT / ".venv" / "bin" / "python"
    return candidate if candidate.is_file() else None


def ensure_python() -> None:
    if sys.version_info >= MIN_VERSION:
        return
    target = venv_python()
    if target is None:
        ver = f"{sys.version_info.major}.{sys.version_info.minor}"
        print(f"当前 python 是 {ver}，本项目需要 3.12+。")
        print("请先创建虚拟环境后再启动：")
        print("  uv venv --python 3.12 .venv")
        print("  uv pip install --python .venv\\Scripts\\python.exe fastapi \"uvicorn[standard]\" pydantic httpx pillow python-multipart pytest")
        print("  .venv\\Scripts\\python.exe server.py")
        raise SystemExit(1)
    raise SystemExit(
        subprocess.call([str(target), str(Path(__file__).resolve()), *sys.argv[1:]])
    )


def pick_port() -> int:
    env = os.environ.get("WORKBENCH_PORT")
    if env:
        return int(env)
    for port in PREFERRED_PORTS:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.bind((HOST, port))
        except OSError:
            continue
        else:
            return port
        finally:
            sock.close()
    raise SystemExit("没有可用端口，请设置环境变量 WORKBENCH_PORT")


def main() -> None:
    import uvicorn

    port = pick_port()
    print(f"Python {sys.version.split()[0]}")
    print(f"画师串工作台后端：http://{HOST}:{port}/")
    print(f"OpenAPI：http://{HOST}:{port}/docs")
    print(f"数据目录：{ROOT / 'data'}")
    print("前端请另开终端：cd workbench/frontend && npm run dev")
    print("浏览器打开：http://127.0.0.1:5173")
    uvicorn.run(
        "app.main:app",
        host=HOST,
        port=port,
        reload=False,
        factory=False,
    )


if __name__ == "__main__":
    ensure_python()
    main()
