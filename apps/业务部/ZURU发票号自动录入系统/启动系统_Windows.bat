@echo off
chcp 65001 >nul
cd /d %~dp0
if not exist .venv (
  echo 首次运行，创建虚拟环境并安装依赖...
  py -3 -m venv .venv
  .\.venv\Scripts\python.exe -m pip install -r requirements.txt
)
echo.
echo 启动发票号自动录入系统 Web版  http://127.0.0.1:5010
echo 局域网内其他电脑访问: http://本机IP:5010
echo.
.\.venv\Scripts\python.exe app.py --host 0.0.0.0 --port 5010
pause
