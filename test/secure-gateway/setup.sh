#!/bin/sh
# setup.sh - create the simulator's own virtualenv (.venv) with its requirements
set -e
cd "$(dirname "$0")"
python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt
.venv/bin/python -c "import xknx.__version__ as v; print('xknx', v.__version__, 'ready in', '$(pwd)/.venv')"
