#!/bin/sh
# 동기화 백엔드를 PyInstaller로 묶는다 → backend/dist/composer-backend/
set -e
cd "$(dirname "$0")"
[ -x .venv/bin/pyinstaller ] || uv pip install --python .venv/bin/python pyinstaller
.venv/bin/pyinstaller --noconfirm --clean --onedir --name composer-backend \
  --distpath dist --workpath .pyi-build --specpath .pyi-build \
  --paths . \
  --collect-submodules pypodlib --collect-data pypodlib \
  --collect-submodules syncedlyrics --collect-data syncedlyrics \
  --collect-all wasmtime \
  --collect-submodules Crypto \
  --hidden-import pypodlib_compat \
  server.py
echo "built: $(pwd)/dist/composer-backend"
