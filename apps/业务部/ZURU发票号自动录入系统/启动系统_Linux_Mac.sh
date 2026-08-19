#!/bin/bash
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  echo "首次运行，创建虚拟环境并安装依赖..."
  python3 -m venv .venv
  ./.venv/bin/pip install -r requirements.txt
fi
echo "启动发票号自动录入系统 Web版  http://0.0.0.0:5010"
exec ./.venv/bin/python app.py --host 0.0.0.0 --port "${PORT:-5010}"
