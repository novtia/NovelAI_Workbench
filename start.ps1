# 启动画师串工作台（Tauri 2 桌面应用）。
#   .\start.ps1           开发模式：热更新前端 + 编译运行 Rust 后端，数据在 backend\data
#   .\start.ps1 -Build    打包安装程序（输出在 src-tauri\target\release\bundle）
#   .\start.ps1 -Check    只检查环境，不启动
#
# 前端开发服务固定在 5174 端口（src-tauri\tauri.conf.json 的 devUrl 写死了它），被占用时会直接报错。
# 想换数据目录：先设置环境变量 WORKBENCH_DATA_DIR，再运行本脚本。

param(
    [switch]$Build,
    [switch]$Check
)

$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot
if (-not $Root) {
    $Root = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$FrontendDir = Join-Path $Root "frontend"
$DevPort = 5174

function Test-PortFree([int]$PortNumber) {
    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $PortNumber)
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

function Require-Command([string]$Name, [string]$Hint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Write-Host "未找到 $Name。$Hint"
        exit 1
    }
}

Require-Command "npm" "请先安装 Node.js，并确认 npm 在 PATH 里。"
Require-Command "cargo" "请先安装 Rust（https://rustup.rs），并确认 cargo 在 PATH 里。"

if (-not (Test-Path -LiteralPath (Join-Path $Root "node_modules"))) {
    Write-Host "安装 Tauri CLI 依赖 ..."
    Push-Location $Root
    try {
        & npm install
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $FrontendDir "node_modules"))) {
    Write-Host "安装前端依赖 ..."
    Push-Location $FrontendDir
    try {
        & npm install
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
        Pop-Location
    }
}

if ($Check) {
    Write-Host "环境检查通过：npm、cargo、前后端依赖都就绪。"
    exit 0
}

Push-Location $Root
try {
    if ($Build) {
        Write-Host "打包中（首次编译 Rust 依赖需要几分钟）..."
        & npm run tauri -- build
        exit $LASTEXITCODE
    }

    if (-not (Test-PortFree $DevPort)) {
        Write-Host "端口 $DevPort 被占用。请先关掉占用它的程序（比如上一次没退干净的 Vite），再重新运行。"
        exit 1
    }

    if ($env:WORKBENCH_DATA_DIR) {
        Write-Host "数据目录：$env:WORKBENCH_DATA_DIR"
    } else {
        Write-Host "数据目录：$(Join-Path $Root 'backend\data')（开发模式默认）"
    }
    Write-Host "启动中（首次编译 Rust 依赖需要几分钟）..."
    & npm run tauri -- dev
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
