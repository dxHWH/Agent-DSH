@echo off
chcp 65001 >nul
rem 点踩归档：企业微信机器人授权（每台机器执行一次）。凭证只保存在本机 %USERPROFILE%\.config\wecom。
set "CLI=%~dp0resources\wecom-cli\wecom-cli.exe"
if not exist "%CLI%" (
  echo 未找到 %CLI%
  pause
  exit /b 1
)
echo === 当前授权状态 ===
"%CLI%" auth show
echo.
echo 即将输入机器人 Bot ID 和 Secret（向管理员获取）。直接关闭窗口可取消。
pause
"%CLI%" auth init --manual
echo.
echo === 授权后状态 ===
"%CLI%" auth show
pause
