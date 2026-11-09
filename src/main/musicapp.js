// 아이팟 터치 지원
// - 감지: libimobiledevice(idevice_id, ideviceinfo)로 USB에 연결된 iOS 기기를 찾는다
// - 곡 넣기: 최신 iOS는 서드파티가 음악 DB를 쓸 수 없으므로, Mac의 Apple Music 앱 보관함에
//   'iPod Composer' 플레이리스트로 넣고 Finder 동기화로 옮긴다 (커버·가사는 ID3 태그로 함께 간다)
const { execFile } = require('child_process');
const fs = require('fs');
const { which, ENV } = require('./downloader');

const PLAYLIST = 'iPod Composer';

function exec(bin, args, timeout = 15000) {
  return new Promise((resolve, reject) =>
    execFile(bin, args, { env: ENV, timeout, maxBuffer: 1 << 24 }, (err, stdout, stderr) =>
      err ? reject(Object.assign(new Error((stderr || err.message).trim()), { code: err.code })) : resolve(stdout)
    )
  );
}

// ProductType → 이름 (아이팟 터치 위주, 나머지는 원래 값)
const TOUCH_NAMES = {
  'iPod1,1': 'iPod touch 1세대', 'iPod2,1': 'iPod touch 2세대', 'iPod3,1': 'iPod touch 3세대',
  'iPod4,1': 'iPod touch 4세대', 'iPod5,1': 'iPod touch 5세대', 'iPod7,1': 'iPod touch 6세대',
  'iPod9,1': 'iPod touch 7세대',
};

async function listIosDevices() {
  const idevice = which('idevice_id');
  const info = which('ideviceinfo');
  if (!idevice || !info) return { available: false, devices: [] };
  let udids = [];
  try {
    udids = (await exec(idevice, ['-l'], 5000)).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (_) {
    return { available: true, devices: [] };
  }
  const devices = [];
  for (const udid of [...new Set(udids)]) {
    const get = (k) => exec(info, ['-u', udid, '-k', k], 5000).then((s) => s.trim()).catch(() => '');
    const [name, type, version] = await Promise.all([get('DeviceName'), get('ProductType'), get('ProductVersion')]);
    devices.push({
      udid,
      name: name || 'iOS 기기',
      productType: type,
      model: TOUCH_NAMES[type] || type || '알 수 없음',
      iosVersion: version,
      isTouch: /^iPod/.test(type),
      // 잠금 해제·'이 컴퓨터를 신뢰' 전이면 정보가 비어 있다
      paired: !!(type && version),
    });
  }
  return { available: true, devices };
}

// JXA: 플레이리스트를 만들고(없으면) 파일들을 추가한다. 이미 플레이리스트에 있는 파일은 건너뛴다.
const JXA = `
function run(argv) {
  const Music = Application('Music');
  const name = argv[0];
  const files = argv.slice(1);
  let pl = Music.userPlaylists.whose({ name: name })();
  pl = pl.length ? pl[0] : Music.make({ new: 'userPlaylist', withProperties: { name: name } });
  const have = {};
  try {
    pl.fileTracks().forEach(function (t) { try { have[t.location().toString()] = true; } catch (e) {} });
  } catch (e) {}
  let added = 0, skipped = 0, failed = [];
  files.forEach(function (p) {
    if (have[p]) { skipped++; return; }
    try { Music.add(Path(p), { to: pl }); added++; } catch (e) { failed.push(p); }
  });
  return JSON.stringify({ added: added, skipped: skipped, failed: failed, playlist: name });
}`;

async function addToMusic(files) {
  const existing = files.filter((f) => fs.existsSync(f));
  if (!existing.length) return { added: 0, skipped: 0, failed: [], playlist: PLAYLIST };
  // 많을 때는 나눠서 보낸다 (osascript 인자 길이 제한)
  const out = { added: 0, skipped: 0, failed: [], playlist: PLAYLIST };
  for (let i = 0; i < existing.length; i += 100) {
    const chunk = existing.slice(i, i + 100);
    let raw;
    try {
      raw = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA, PLAYLIST, ...chunk], 10 * 60 * 1000);
    } catch (e) {
      // -1743: 자동화 권한 거부
      if (/-1743|not authorized|권한/i.test(e.message)) {
        throw new Error('Music 앱 제어 권한이 없습니다. 시스템 설정 → 개인정보 보호 및 보안 → 자동화에서 iPod Composer의 "Music"을 켜 주세요.');
      }
      throw e;
    }
    const r = JSON.parse(raw.trim());
    out.added += r.added;
    out.skipped += r.skipped;
    out.failed.push(...r.failed);
  }
  return out;
}

module.exports = { listIosDevices, addToMusic, PLAYLIST };
