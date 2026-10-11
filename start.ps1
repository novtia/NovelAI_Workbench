# 同时启动画师串工作台的后端与前端。
# 端口不写死：优先 8766 / 5174，被占用或被系统拒绝（WinError 10013）就换下一个。
# 选中的端口通过环境变量交给后端和 Vite，两边保持一致。
# 在本窗口按 Ctrl+C，或关掉任一服务窗口，会把两边一起停掉。

$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot
if (-not $Root) {
    $Root = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$BackendDir = Join-Path $Root "backend"
$FrontendDir = Join-Path $Root "frontend"
# 后端优先 8766，前端优先 5174；后面是备选，再往后是一段连续扫描。
$BackendPreferred = @(8766, 18000, 8001, 8080)
$BackendScan = 18010..18080
$FrontendPreferred = @(5174, 5175, 5176)
$FrontendScan = 5177..5199

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

function Find-FreePort([int[]]$Preferred, [int[]]$Scan) {
    $seen = @{}
    foreach ($candidate in @($Preferred + $Scan)) {
        if ($seen.ContainsKey($candidate)) { continue }
        $seen[$candidate] = $true
        if (Test-PortFree $candidate) { return $candidate }
    }
    return 0
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

if ($env:WORKBENCH_PORT -match '^\d+$') {
    $requested = [int]$env:WORKBENCH_PORT
    $BackendPreferred = @($requested) + @($BackendPreferred | Where-Object { $_ -ne $requested })
}
if ($env:WORKBENCH_WEB_PORT -match '^\d+$') {
    $requestedWeb = [int]$env:WORKBENCH_WEB_PORT
    $FrontendPreferred = @($requestedWeb) + @($FrontendPreferred | Where-Object { $_ -ne $requestedWeb })
}

$Port = Find-FreePort $BackendPreferred $BackendScan
if ($Port -eq 0) {
    Write-Host "没有可用的后端端口。请关掉已有后端，或设置 WORKBENCH_PORT 指定一个空闲端口。"
    exit 1
}
$WebPort = Find-FreePort $FrontendPreferred $FrontendScan
if ($WebPort -eq 0) {
    Write-Host "没有可用的前端端口。请关掉占用 5174 附近的程序，或设置 WORKBENCH_WEB_PORT。"
    exit 1
}

$env:WORKBENCH_PORT = "$Port"
$env:WORKBENCH_WEB_PORT = "$WebPort"
if ($Port -ne $BackendPreferred[0]) {
    Write-Host "端口 $($BackendPreferred[0]) 不可用，后端改用 $Port。"
}
if ($WebPort -ne $FrontendPreferred[0]) {
    Write-Host "端口 $($FrontendPreferred[0]) 不可用，前端改用 $WebPort。"
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

Write-Host "启动前端  http://127.0.0.1:$WebPort/"
$frontend = Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/k", "title workbench-frontend && npm run dev" `
    -WorkingDirectory $FrontendDir `
    -PassThru

Write-Host ""
Write-Host "后端 PID $($backend.Id)    前端 PID $($frontend.Id)"
Write-Host "浏览器打开 http://127.0.0.1:$WebPort"
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
