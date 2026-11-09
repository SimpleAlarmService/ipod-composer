"""Composer 백엔드: 아이팟 동기화 사이드카 (JSON Lines over stdio).

요청:  {"id": 1, "method": "scan", "params": {...}}
응답:  {"id": 1, "result": ...} 또는 {"id": 1, "error": "..."}
이벤트: {"event": "progress", "data": {...}}

사용 오픈소스
- pypodlib (MIT, iOpenPod 엔진): iTunesDB/iTunesCDB 쓰기, hash58/72/AB 서명, ArtworkDB
- Chromaprint fpcalc: 음향 지문으로 중복 곡 판별
- syncedlyrics (MIT): 다중 소스 가사 검색 (보조)
- mutagen: 태그 읽기 (pypodlib 내부)
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import sys
import threading
import traceback
import uuid
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pypodlib_compat  # noqa: E402

pypodlib_compat.install()

import pypodlib  # noqa: E402
from pypodlib.sync import EngineOperation, EngineOptions, EngineRequest, SyncEngine  # noqa: E402

logging.basicConfig(level=logging.WARNING, stream=sys.stderr, format="[py] %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("composer")

_out_lock = threading.Lock()
_plans: dict[str, dict] = {}
_cancel = threading.Event()


def emit(obj: dict) -> None:
    line = json.dumps(obj, ensure_ascii=False, default=str)
    with _out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def event(name: str, **data) -> None:
    emit({"event": name, "data": data})


def find_fpcalc() -> str:
    for p in (shutil.which("fpcalc"), "/opt/homebrew/bin/fpcalc", "/usr/local/bin/fpcalc"):
        if p and os.path.exists(p):
            return p
    return ""


def engine_options(**kw) -> EngineOptions:
    return EngineOptions(
        supports_video=False,
        supports_podcast=False,
        supports_photo=False,
        fpcalc_path=find_fpcalc(),
        **kw,
    )


# ───────────────────────── 기기 ─────────────────────────

CHECKSUM_LABEL = {0: "없음", 1: "HASH58", 2: "HASH72", 3: "HASHAB"}


def describe(ipod: pypodlib.IPod) -> dict:
    try:
        usage = shutil.disk_usage(ipod.path)
        total, free = usage.total, usage.free
    except OSError:
        total = free = 0
    needs_init = not has_database(ipod.path)
    n_tracks = 0
    if not needs_init:
        try:
            n_tracks = len(ipod.library().tracks)
        except Exception as e:  # DB 손상
            log.warning("library read failed: %s", e)
    ck = ipod.checksum_type
    ck_val = int(getattr(ck, "value", ck) or 0)
    from pypodlib.device import has_virtual_ipod_info

    virtual = bool(has_virtual_ipod_info(ipod.path))
    if virtual:
        # 가상 기기는 호스트 디스크 대신 모델 용량을 흉내 낸다
        import re
        m = re.search(r"([\d.]+)\s*(GB|MB)", ipod.capacity or "")
        if m:
            total = int(float(m.group(1)) * (1000**3 if m.group(2) == "GB" else 1000**2))
            music = sum(f.stat().st_size for f in Path(ipod.path, "iPod_Control").rglob("*") if f.is_file())
            free = max(0, total - music)
    return {
        "path": ipod.path,
        "name": f"가상 {ipod.model_family} {ipod.generation}" if virtual else (ipod.name or Path(ipod.path).name),
        "displayName": ipod.display_name,
        "model": ipod.model_number,
        "family": ipod.model_family,
        "generation": ipod.generation,
        "capacity": ipod.capacity,
        "color": ipod.color,
        "serial": ipod.serial,
        "checksum": CHECKSUM_LABEL.get(ck_val, str(ck)),
        "totalBytes": total,
        "freeBytes": free,
        "trackCount": n_tracks,
        "virtual": virtual,
        "needsInit": needs_init,
    }


def has_database(path: str) -> bool:
    from pypodlib.device.info import resolve_itdb_path

    return bool(resolve_itdb_path(str(path)))


def ensure_database(ipod: pypodlib.IPod) -> None:
    """초기화된(iTunesDB 없는) 아이팟에 빈 DB를 만든다. 동기화 시점에만 호출."""
    if has_database(ipod.path):
        return
    from pypodlib.device.bootstrap import ensure_device_itunes_database

    event("progress", stage="init", current=0, total=1, message="Creating empty iTunesDB")
    created = ensure_device_itunes_database(ipod.path, ipod.info)
    if not created:
        raise RuntimeError("이 아이팟의 DB 서명 정보(FireWire GUID/HashInfo)가 없어 새 DB를 만들 수 없습니다")


def m_scan(params: dict) -> list[dict]:
    found: dict[str, pypodlib.IPod] = {}
    try:
        for ip in pypodlib.scan_ipods():
            found[os.path.realpath(ip.path)] = ip
    except Exception as e:
        log.warning("scan failed: %s", e)
    for extra in params.get("extraPaths") or []:
        rp = os.path.realpath(extra)
        if rp in found or not os.path.isdir(os.path.join(extra, "iPod_Control")):
            continue
        try:
            found[rp] = pypodlib.connect(extra)
        except Exception as e:
            log.warning("connect %s failed: %s", extra, e)
    return [describe(ip) for ip in found.values()]


def m_models(_params: dict) -> list[dict]:
    from pypodlib.device import available_virtual_ipod_models

    return available_virtual_ipod_models()


def m_create_virtual(params: dict) -> dict:
    from pypodlib.device import create_virtual_ipod

    root = params["path"]
    os.makedirs(root, exist_ok=True)
    create_virtual_ipod(root, params.get("model") or "MC297")
    return describe(pypodlib.connect(root))


def m_library(params: dict) -> list[dict]:
    if not has_database(params["path"]):
        return []
    lib = pypodlib.connect(params["path"]).library(reload=True)
    out = []
    for t in lib.tracks:
        out.append({
            "id": str(t.db_track_id),
            "title": t.title,
            "artist": t.artist,
            "album": t.album,
            "albumArtist": t.album_artist,
            "duration": round(t.duration or 0, 1),
            "size": t.size,
            "hasArtwork": bool(t.get("has_artwork")),
            "hasLyrics": bool(t.get("Lyrics") or t.get("lyrics_flag")),
            "location": t.location,
        })
    return out


def m_eject(params: dict) -> dict:
    from pypodlib.device.eject import eject_ipod

    ipod = pypodlib.connect(params["path"])
    if describe(ipod)["virtual"]:
        return {"ok": True, "message": "가상 아이팟은 꺼낼 필요가 없습니다"}
    ok, msg = eject_ipod(
        ipod.path,
        reported_volume_format=ipod.info.reported_volume_format,
        expected_volume_identity_key=ipod.volume_identity_key,
    )
    return {"ok": ok, "message": msg}


# ───────────────────────── 동기화 ─────────────────────────

def _item(i) -> dict:
    pc = i.pc_track
    ip = i.ipod_track or {}
    return {
        "title": (pc.title if pc else ip.get("Title")) or "",
        "artist": (pc.artist if pc else ip.get("Artist")) or "",
        "album": (pc.album if pc else ip.get("Album")) or "",
        "path": pc.path if pc else None,
        "size": i.estimated_size or (pc.size if pc else ip.get("size")) or 0,
        "changes": list((i.metadata_changes or {}).keys()),
    }


def _progress_cb(p) -> None:
    msg = getattr(p, "message", "") or ""
    if not msg:
        return
    event("progress",
          stage=str(getattr(p, "stage", "")),
          current=int(getattr(p, "current", 0) or 0),
          total=int(getattr(p, "total", 0) or 0),
          message=msg)


def _mapping_source_hints(plan) -> dict[int, str]:
    """db_track_id → 보관함 기준 상대 경로(source_path_hint)"""
    out: dict[int, str] = {}
    mapping = getattr(plan, "mapping", None)
    for entries in (getattr(mapping, "_tracks", None) or {}).values():
        for e in entries if isinstance(entries, list) else [entries]:
            tid = int(getattr(e, "db_track_id", 0) or 0)
            hint = getattr(e, "source_path_hint", None)
            if tid and hint:
                out[tid] = hint
    return out


def m_plan(params: dict) -> dict:
    """mode: "add" (기본, 아이팟의 기존 곡을 지우지 않음) | "mirror" (보관함과 똑같이)"""
    path, music = params["path"], params["musicDir"]
    mode = params.get("mode", "add")
    allowed = params.get("allowedPaths")
    ipod = pypodlib.connect(path)
    if params.get("dryRun") and not has_database(path):
        lib = None
    else:
        ensure_database(ipod)
        ipod = pypodlib.connect(path)
        lib = ipod.library(reload=True)
    opts = engine_options(allowed_paths=frozenset(allowed) if allowed else None)
    out = SyncEngine().run(EngineRequest(
        operation=EngineOperation.PLAN,
        ipod_path=path,
        pc_folders=(music,),
        ipod_tracks=tuple(t.data for t in lib.tracks) if lib else (),
        existing_playlists=tuple(p.data for p in lib.all_playlists) if lib else (),
        options=opts,
        progress_callback=_progress_cb,
    ))
    if not out.success or out.result is None:
        raise RuntimeError("; ".join(d.message for d in out.diagnostics) or "동기화 계획 실패")
    plan = out.result
    kept_removals = 0
    replaced = 0
    if mode != "mirror":
        # '추가만' 모드: 아이팟의 곡은 지우지 않는다.
        # 단, 보관함에 지금도 있는 파일의 '예전 버전'(다시 받아 음향 지문이 바뀐 경우)은
        # 교체 대상이므로 지운다 — 그래야 같은 곡이 두 번 들어가지 않는다.
        hints = _mapping_source_hints(plan)
        keep = []
        for item in plan.to_remove:
            hint = hints.get(int(item.db_track_id or 0))
            if hint and os.path.isfile(os.path.join(music, hint)):
                keep.append(item)
        replaced = len(keep)
        kept_removals = len(plan.to_remove) - replaced
        plan.to_remove = keep
        plan.playlists_to_remove = []
    token = uuid.uuid4().hex
    _plans[token] = {"plan": plan, "path": path, "device_info": ipod.info}
    st = plan.storage
    return {
        "token": token,
        "mode": mode,
        "add": [_item(i) for i in plan.to_add],
        "remove": [_item(i) for i in plan.to_remove],
        "updateMetadata": [_item(i) for i in plan.to_update_metadata],
        "updateFile": [_item(i) for i in plan.to_update_file],
        "updateArtwork": [_item(i) for i in plan.to_update_artwork],
        "keptOnIpod": kept_removals,
        "replaced": replaced,
        "duplicates": sum(len(v) for v in plan.duplicates.values()),
        "fingerprintErrors": [list(e) for e in plan.fingerprint_errors][:20],
        "matched": plan.matched_tracks,
        "bytesToAdd": st.bytes_to_add,
        "bytesToRemove": st.bytes_to_remove,
        "freeBytes": describe(ipod)["freeBytes"],
        "hasChanges": bool(plan.has_changes),
    }


def m_execute(params: dict) -> dict:
    entry = _plans.pop(params["token"], None)
    if not entry:
        raise RuntimeError("동기화 계획이 만료되었습니다. 다시 확인해 주세요.")
    _cancel.clear()
    out = SyncEngine().run(EngineRequest(
        operation=EngineOperation.EXECUTE,
        ipod_path=entry["path"],
        plan=entry["plan"],
        options=engine_options(),
        device_info=entry["device_info"],
        progress_callback=_progress_cb,
        is_cancelled=_cancel.is_set,
    ))
    r = out.result
    errors = [d.message for d in out.diagnostics if d.fatal]
    return {
        "ok": out.success,
        "errors": errors,
        "warnings": [d.message for d in out.diagnostics if not d.fatal],
        "added": getattr(r, "tracks_added", None),
        "removed": getattr(r, "tracks_removed", None),
        "updated": getattr(r, "tracks_updated_metadata", None),
    }


def m_cancel(_params: dict) -> bool:
    _cancel.set()
    return True


# ───────────────────────── 가사 (보조) ─────────────────────────

def m_lyrics(params: dict) -> dict | None:
    """syncedlyrics로 Musixmatch·NetEase·Megalobiz·Genius 등을 차례로 검색한다."""
    import syncedlyrics

    term = f"{params.get('artist', '')} {params.get('title', '')}".strip()
    providers = params.get("providers") or ["Musixmatch", "NetEase", "Megalobiz", "Genius"]
    lrc = None
    try:
        lrc = syncedlyrics.search(term, providers=providers)
    except Exception as e:
        log.warning("syncedlyrics failed: %s", e)
    if not lrc:
        return None
    return {"lrc": lrc, "source": "syncedlyrics"}


METHODS = {
    "ping": lambda p: {"ok": True, "pypodlib": getattr(pypodlib, "__version__", "?"), "fpcalc": find_fpcalc()},
    "scan": m_scan,
    "models": m_models,
    "createVirtual": m_create_virtual,
    "library": m_library,
    "eject": m_eject,
    "plan": m_plan,
    "execute": m_execute,
    "cancel": m_cancel,
    "lyrics": m_lyrics,
}

# cancel/ping은 즉시, 나머지는 하나씩 순서대로(아이팟 DB 동시 쓰기 방지)
_work_lock = threading.Lock()


def handle(req: dict) -> None:
    rid, method = req.get("id"), req.get("method")
    fn = METHODS.get(method)
    if not fn:
        emit({"id": rid, "error": f"unknown method {method}"})
        return
    try:
        if method in ("cancel", "ping"):
            result = fn(req.get("params") or {})
        else:
            with _work_lock:
                result = fn(req.get("params") or {})
        emit({"id": rid, "result": result})
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        emit({"id": rid, "error": str(e) or e.__class__.__name__})


def main() -> None:
    event("ready")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        threading.Thread(target=handle, args=(req,), daemon=True).start()


if __name__ == "__main__":
    main()
