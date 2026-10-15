<#
  在一个全新目录里人工验证 Agent Desktop 免安装版的完整安装流程（模拟一台从未装过的新机器）。

  用法：
    powershell -ExecutionPolicy Bypass -File scripts\launch-fresh-test.ps1 -TestRoot D:\AgentDesktop-Test
    再次打开同一测试环境（不重新复制、不清数据）：加 -Resume
    测完：退出测试窗口（Ctrl+Q）后删除 D:\AgentDesktop-Test

  隔离方式（本机真实数据一律不读不写）：
    --user-data-dir=<TestRoot>\userdata   数据根 = <TestRoot>\userdata\dsh-home
                                          （旧版 DSH Desktop 数据不会被迁移进来）
    WECOM_CLI_CONFIG_DIR=<TestRoot>\wecom  企业微信授权从「未授权」开始，不碰 %USERPROFILE%\.config\wecom
  单实例锁按数据目录区分，所以能和你正在用的 Agent Desktop 同时运行。
  设置里的「重启 Agent Desktop」按钮沿用原启动参数，重启后仍在隔离环境中。
  Ctrl+Q 退出后要再打开，用 -Resume 重新运行本脚本（不要直接双击 exe，那样会进入真实数据目录）。
#>
param(
  [Parameter(Mandatory = $true)][string]$TestRoot,
  [string]$Bundle,
  [switch]$Resume
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $Bundle) {
  $Bundle = Get-ChildItem (Join-Path $repo 'release') -Directory | Where-Object Name -like 'Agent-Desktop-portable-*' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $Bundle -or -not (Test-Path (Join-Path $Bundle 'Agent Desktop\Agent Desktop.exe'))) {
  throw '未找到汇总包 release\Agent-Desktop-portable-*，先运行 npm run bundle:portable'
}

$app = Join-Path $TestRoot 'Agent Desktop'
if (-not $Resume) {
  if (Test-Path $TestRoot) { throw "$TestRoot 已存在。全新测试请先删除；继续上次测试请加 -Resume" }
  Write-Host "复制汇总包（约 560 MB）: $Bundle -> $TestRoot"
  New-Item -ItemType Directory $TestRoot | Out-Null
  robocopy $Bundle $TestRoot /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "复制失败（robocopy 退出码 $LASTEXITCODE）" }
}
$userData = Join-Path $TestRoot 'userdata'
$wecom = Join-Path $TestRoot 'wecom'
New-Item -ItemType Directory $userData, $wecom -Force | Out-Null

$env:WECOM_CLI_CONFIG_DIR = $wecom
Write-Host "数据根    : $userData\dsh-home"
Write-Host "企业微信凭证  : $wecom"
Write-Host "启动      : $app\Agent Desktop.exe"
Start-Process (Join-Path $app 'Agent Desktop.exe') -WorkingDirectory $app -ArgumentList "--user-data-dir=`"$userData`""