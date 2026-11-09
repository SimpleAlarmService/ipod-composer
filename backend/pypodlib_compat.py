"""pypodlib 0.1.0 호환 패치.

pypodlib 0.1.0 휠에는 sync_executor가 무조건 import 하는 `pypodlib.podcasts`
패키지가 빠져 있다(iOpenPod에서 분리할 때 누락). Composer는 팟캐스트를
동기화하지 않으므로, 음악 동기화 경로에서 쓰이는 이름만 가진 대체 모듈을
sys.modules에 등록한다. 팟캐스트 항목이 실제로 들어오면 명확한 오류를 낸다.
"""
import sys
import types
from dataclasses import dataclass


def install() -> None:
    try:
        import pypodlib.podcasts  # noqa: F401  (향후 버전에 포함되면 그대로 사용)
        return
    except ImportError:
        pass

    def _unsupported(*_a, **_k):
        raise RuntimeError("Composer는 팟캐스트 동기화를 지원하지 않습니다")

    @dataclass
    class DeviceDownloadSafety:  # 팟캐스트 다운로드 전용 정책 객체
        ipod_path: str = ""
        reported_volume_format: str = ""
        expected_volume_identity_key: str = ""

        def __init__(self, *args, **kwargs):
            pass

    pkg = types.ModuleType("pypodlib.podcasts")
    pkg.__path__ = []  # 패키지로 인식시키기

    downloader = types.ModuleType("pypodlib.podcasts.downloader")
    downloader.DeviceDownloadSafety = DeviceDownloadSafety
    downloader.extract_chapters = lambda *_a, **_k: None
    downloader.download_and_probe_episode = _unsupported
    downloader.probe_episode_file = _unsupported

    models = types.ModuleType("pypodlib.podcasts.models")
    models.STATUS_DOWNLOADED = "downloaded"
    models.STATUS_NOT_DOWNLOADED = "not_downloaded"
    models.STATUS_ON_IPOD = "on_ipod"
    models.normalize_artwork_url = lambda url, *_a, **_k: url or ""

    artwork = types.ModuleType("pypodlib.podcasts.artwork")
    artwork.is_remote_artwork_source = lambda *_a, **_k: False
    artwork.resolve_feed_artwork_source = lambda *_a, **_k: ""
    artwork.resolve_local_artwork_path = lambda *_a, **_k: None

    sys.modules.update({
        "pypodlib.podcasts": pkg,
        "pypodlib.podcasts.downloader": downloader,
        "pypodlib.podcasts.models": models,
        "pypodlib.podcasts.artwork": artwork,
    })
    # subscription_store는 일부러 넣지 않는다: 호출부가 ImportError를 잡아 건너뛴다
