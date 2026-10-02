# 同时启动画师串工作台的后端与前端。
# 后端固定 127.0.0.1:8766（与 frontend/vite.config.ts 的 /api 代理一致）。
# 前端为 Vite，默认 127.0.0.1:5174。
# 在本窗口按 Ctrl+C，或关掉任一服务窗口，会把两边一起停掉。

$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot
if (-not $Root) {
    $Root = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$BackendDir = Join-Path $Root "backend"
$FrontendDir = Join-Path $Root "frontend"
$Port = 8766

function Test-PortFree([int]$PortNumber) {
    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new(
            [System.Net.IPAddress]::Loopback,
            $PortNumber
        )
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($null -ne $listener) {
            $listener.Stop()
        }
    }
}

function Stop-Tree([System.Diagnostics.Process]$Process) {
    if ($null -eq $Process) {
        return
    }
    try {
        $Process.Refresh()
    } catch {
        return
    }
    if ($Process.HasExited) {
        return
    }
    & cmd.exe /c "taskkill /PID $($Process.Id) /T /F >nul 2>&1"
}

$python = Join-Path $BackendDir ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
    Write-Host "未找到后端虚拟环境：$python"
    Write-Host "请先在 workbench/backend 执行："
    Write-Host "  uv venv --python 3.12 .venv"
    Write-Host "  uv pip install --python .venv\Scripts\python.exe fastapi `"uvicorn[standard]`" pydantic httpx pillow python-multipart pytest"
    exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "未找到 npm。请先安装 Node.js，并确认 npm 在 PATH 里。"
    exit 1
}

if ($env:WORKBENCH_PORT -and $env:WORKBENCH_PORT -ne "$Port") {
    Write-Host "已忽略 WORKBENCH_PORT=$($env:WORKBENCH_PORT)。前端代理固定指向 $Port。"
}
$env:WORKBENCH_PORT = "$Port"

if (-not (Test-PortFree $Port)) {
    Write-Host "端口 $Port 已被占用。请先关掉已有的后端，再重新启动。"
    exit 1
}

if (-not (Test-PortFree 5174)) {
    Write-Host "端口 5174 已被占用。请先关掉占用它的程序，再重新启动。"
    exit 1
}

if (-not (Test-Path -LiteralPath (Join-Path $FrontendDir "node_modules"))) {
    Write-Host "前端依赖未安装，正在 npm install ..."
    Push-Location $FrontendDir
    try {
        & npm install
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    } finally {
        Pop-Location
    }
}

Write-Host "启动后端  http://127.0.0.1:$Port/"
$backend = Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/k", "title workbench-backend && .venv\Scripts\python.exe server.py" `
    -WorkingDirectory $BackendDir `
    -PassThru

Write-Host "启动前端  http://127.0.0.1:5174/"
$frontend = Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/k", "title workbench-frontend && npm run dev" `
    -WorkingDirectory $FrontendDir `
    -PassThru

Write-Host ""
Write-Host "后端 PID $($backend.Id)    前端 PID $($frontend.Id)"
Write-Host "浏览器打开 http://127.0.0.1:5174"
Write-Host "在本窗口按 Ctrl+C，或关掉任一服务窗口，会停止前后端。"

$reason = $null
try {
    while (-not $backend.HasExited -and -not $frontend.HasExited) {
        Start-Sleep -Milliseconds 500
    }
    if ($backend.HasExited) {
        $reason = "后端窗口已关闭"
    } elseif ($frontend.HasExited) {
        $reason = "前端窗口已关闭"
    }
} finally {
    Stop-Tree $backend
    Stop-Tree $frontend
    if ($reason) {
        Write-Host "$reason，已停止另一边。"
    } else {
        Write-Host "已停止前后端。"
    }
}
