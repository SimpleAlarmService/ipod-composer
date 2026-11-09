#!/bin/sh
# Composer 백엔드 환경 구성: uv로 Python 3.12 venv를 만들고 의존성을 설치한다.
set -e
cd "$(dirname "$0")"
command -v uv >/dev/null || { echo "uv가 필요합니다: brew install uv"; exit 1; }
command -v fpcalc >/dev/null || echo "경고: fpcalc 없음 → brew install chromaprint"
command -v yt-dlp >/dev/null || echo "경고: yt-dlp 없음 → brew install yt-dlp"
command -v ffmpeg >/dev/null || echo "경고: ffmpeg 없음 → brew install ffmpeg"
[ -x .venv/bin/python ] || uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt
echo "백엔드 준비 완료"
