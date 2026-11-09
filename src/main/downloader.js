// yt-dlp 다운로드 → 메타데이터 보강 → ID3 태깅(커버·가사) → 보관함 정리
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const NodeID3 = require('node-id3');
const ytm = require('./ytmusic');
const { findLyrics, toLrc } = require('./lyrics');

const EXTRA_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(os.homedir(), '.local/bin')];
const ENV = { ...process.env, PATH: [...EXTRA_PATHS, process.env.PATH || ''].join(':') };

function which(bin) {
  for (const dir of ENV.PATH.split(':')) {
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (_) {}
  }
  return null;
}

function run(bin, args) {
  return new Promise((resolve, reject) =>
    execFile(bin, args, { env: ENV, maxBuffer: 1 << 26 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(stdout)
    )
  );
}

async function checkDeps() {
  const out = {};
  for (const bin of ['yt-dlp', 'ffmpeg']) {
    const p = which(bin);
    out[bin] = { path: p, version: null };
    if (p) {
      try {
        const v = await run(p, [bin === 'ffmpeg' ? '-version' : '--version']);
        out[bin].version = v.split('\n')[0].replace(/^ffmpeg version /, '').split(' ')[0];
      } catch (_) {}
    }
  }
  return out;
}

const safe = (s) =>
  (s || '알 수 없음')
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || '_';

async function fetchBuffer(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('커버 다운로드 실패 ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

// 16:9 동영상 썸네일 등은 ffmpeg로 정사각형으로 잘라 1000px JPEG로 만든다
async function squareCover(buf, workDir) {
  const ffmpeg = which('ffmpeg');
  if (!ffmpeg) return buf;
  const src = path.join(workDir, 'cover_src');
  const dst = path.join(workDir, 'cover.jpg');
  fs.writeFileSync(src, buf);
  await run(ffmpeg, [
    '-y', '-loglevel', 'error', '-i', src,
    '-vf', "crop='min(iw,ih)':'min(iw,ih)',scale='min(1200,iw)':-2",
    '-q:v', '2', dst,
  ]);
  return fs.readFileSync(dst);
}

async function getCover(meta, workDir) {
  const urls = [ytm.hiResCover(meta.thumb), meta.thumb].filter(Boolean);
  if (meta.videoId) urls.push(`https://i.ytimg.com/vi/${meta.videoId}/hqdefault.jpg`);
  for (const u of urls) {
    try {
      const buf = await fetchBuffer(u);
      if (buf.length < 2000) continue; // 빈 플레이스홀더
      return await squareCover(buf, workDir);
    } catch (_) {}
  }
  return null;
}

// ---------- 아이팟용 마스터링 ----------
// 아이팟의 정수(fixed-point) MP3 디코더는 0dBFS를 넘는 샘플을 잘라 '지직'거린다.
// 요즘 마스터는 트루 피크가 +2dB를 넘기도 하므로, 곡마다 피크를 재서 넘치는 만큼만 낮춘다.
// 또 YouTube 원본은 48kHz라 아이팟이 실시간 리샘플링을 하므로 44.1kHz로 미리 바꾼다.
const MASTER_VERSION = 'ipod-44k-tp-1.5';
const TARGET_TP = -1.5; // dBTP (MP3 인코딩 오버슈트 여유 포함)
const RESAMPLE = 'aresample=44100:filter_size=64:phase_shift=10:cutoff=0.97:dither_method=triangular_hp';

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(which('ffmpeg'), ['-hide_banner', '-nostdin', ...args], { env: ENV });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(err.split('\n').slice(-3).join(' ')))));
  });
}

async function measureTruePeak(file) {
  const out = await runFfmpeg(['-i', file, '-vn', '-af', `${RESAMPLE},ebur128=peak=true`, '-f', 'null', '-']);
  const m = out.match(/True peak:\s*\n\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS/);
  return m && m[1] !== '-inf' ? Number(m[1]) : -99;
}

async function encodeForIpod(src, dst, quality = '0') {
  const truePeak = await measureTruePeak(src);
  const gain = Math.min(0, TARGET_TP - truePeak);
  const af = gain < -0.05 ? `volume=${gain.toFixed(2)}dB,${RESAMPLE}` : RESAMPLE;
  await runFfmpeg([
    '-y', '-i', src, '-vn', '-map_metadata', '-1',
    '-af', af, '-ar', '44100',
    '-c:a', 'libmp3lame', '-q:a', String(quality), '-joint_stereo', '1',
    dst,
  ]);
  return { file: dst, truePeak, gain };
}

const norm = (s) => (s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]|[\s\-_.,'"!?·]/g, '');

// 앨범 정보가 없는 곡(뮤직비디오·URL 입력)을 앨범 트랙에 매칭한다
async function enrichMeta(meta, log) {
  let m = { ...meta };
  if (!m.title || !m.artist || !m.album) {
    try {
      const w = await ytm.getWatchInfo(m.videoId);
      m = {
        ...w,
        ...Object.fromEntries(Object.entries(m).filter(([, v]) => v !== '' && v != null)),
      };
      if (!m.albumBrowseId && w.albumBrowseId) m.albumBrowseId = w.albumBrowseId;
    } catch (e) {
      log('메타데이터 조회 실패: ' + e.message);
    }
  }
  if (m.albumBrowseId && !m.trackNo) {
    try {
      const al = await ytm.getAlbum(m.albumBrowseId);
      const t = al.tracks.find((x) => x.videoId === m.videoId) || al.tracks.find((x) => norm(x.title) === norm(m.title));
      Object.assign(m, {
        album: al.title, albumArtist: al.artist, year: m.year || al.year, thumb: al.thumb,
        trackNo: t?.trackNo, trackCount: al.tracks.length,
      });
    } catch (_) {}
  }
  if (!m.album && m.title && m.artist) {
    // 앨범 검색으로 같은 제목의 곡을 찾는다
    try {
      const albums = await ytm.searchAlbums(`${m.artist} ${m.title}`);
      for (const a of albums.slice(0, 3)) {
        const al = await ytm.getAlbum(a.browseId);
        const t = al.tracks.find((x) => norm(x.title) === norm(m.title));
        if (t) {
          log(`앨범 매칭: ${al.title}`);
          Object.assign(m, {
            album: al.title, albumArtist: al.artist, year: al.year, thumb: al.thumb,
            trackNo: t.trackNo, trackCount: al.tracks.length, albumBrowseId: al.browseId,
            title: t.title, artist: t.artist || m.artist,
          });
          break;
        }
      }
    } catch (_) {}
  }
  return m;
}

function langOf(text) {
  if (/[가-힣]/.test(text)) return 'kor';
  if (/[぀-ヿ]/.test(text)) return 'jpn';
  if (/[一-鿿]/.test(text)) return 'chi';
  return 'eng';
}

class Downloader extends EventEmitter {
  constructor(getSettings) {
    super();
    this.getSettings = getSettings;
    this.jobs = new Map();
    this.queue = [];
    this.active = 0;
    this.seq = 0;
  }

  list() {
    return [...this.jobs.values()].map(({ proc, ...j }) => j);
  }

  update(job, patch) {
    Object.assign(job, patch);
    const { proc, ...pub } = job;
    this.emit('update', pub);
  }

  enqueue(meta) {
    for (const j of this.jobs.values()) {
      if (j.meta.videoId === meta.videoId && !['error', 'done', 'canceled'].includes(j.state)) return j.id;
    }
    const id = `job${++this.seq}`;
    const job = { id, meta, state: 'queued', progress: 0, speed: '', eta: '', log: [], file: null, error: null };
    this.jobs.set(id, job);
    this.queue.push(id);
    this.update(job, {});
    this.pump();
    return id;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    this.queue = this.queue.filter((q) => q !== id);
    if (job.proc) job.proc.kill('SIGTERM');
    this.update(job, { state: 'canceled' });
  }

  clearFinished() {
    for (const [id, j] of this.jobs) if (['done', 'error', 'canceled'].includes(j.state)) this.jobs.delete(id);
    this.emit('cleared');
  }

  pump() {
    const max = this.getSettings().concurrency || 2;
    while (this.active < max && this.queue.length) {
      const id = this.queue.shift();
      const job = this.jobs.get(id);
      if (!job || job.state === 'canceled') continue;
      this.active++;
      this.process(job)
        .catch((e) => this.update(job, { state: 'error', error: e.message.split('\n').filter(Boolean).slice(-2).join(' ') }))
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  async process(job) {
    const settings = this.getSettings();
    const log = (msg) => {
      job.log.push(msg);
      this.update(job, {});
    };
    const ytdlp = which('yt-dlp');
    if (!ytdlp) throw new Error('yt-dlp를 찾을 수 없습니다. brew install yt-dlp 로 설치하세요.');
    if (!which('ffmpeg')) throw new Error('ffmpeg를 찾을 수 없습니다. brew install ffmpeg 로 설치하세요.');

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-'));
    try {
      // 1) 메타데이터 보강
      this.update(job, { state: 'meta', progress: 0 });
      const meta = await enrichMeta(job.meta, log);
      this.update(job, { meta });

      // 2) 다운로드 (병렬로 가사·커버 준비)
      this.update(job, { state: 'downloading' });
      const lyricsP = findLyrics(meta, log).catch(() => null);
      const coverP = getCover(meta, workDir).catch(() => null);

      const url = `https://music.youtube.com/watch?v=${meta.videoId}`;
      const args = [
        '--no-playlist', '--newline', '--progress', '--no-warnings', '--no-mtime',
        '-f', 'bestaudio/best', // 원본(Opus/AAC) 그대로 받고 변환은 아래 ffmpeg가 직접 한다
        '--progress-template', 'download:@@%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
        '-o', path.join(workDir, 'audio.%(ext)s'),
        '--print', 'after_move:filepath',
        url,
      ];
      let outFile = null;
      await new Promise((resolve, reject) => {
        const proc = spawn(ytdlp, args, { env: ENV });
        job.proc = proc;
        let errBuf = '';
        const onLine = (line) => {
          if (line.startsWith('@@')) {
            const [p, sp, eta] = line.slice(2).split('|');
            const pct = parseFloat(p);
            if (!isNaN(pct)) this.update(job, { progress: pct / 100, speed: (sp || '').trim(), eta: (eta || '').trim() });
          } else if (line.trim().startsWith('/')) {
            outFile = line.trim();
          }
        };
        let buf = '';
        proc.stdout.on('data', (d) => {
          buf += d;
          const lines = buf.split(/\r?\n/);
          buf = lines.pop();
          lines.forEach(onLine);
        });
        proc.stderr.on('data', (d) => (errBuf += d));
        proc.on('close', (code) => {
          if (buf) onLine(buf);
          job.proc = null;
          if (job.state === 'canceled') return reject(new Error('취소됨'));
          code === 0 ? resolve() : reject(new Error(errBuf || `yt-dlp 종료 코드 ${code}`));
        });
      });
      if (!outFile || !fs.existsSync(outFile)) {
        outFile = fs.readdirSync(workDir).map((f) => path.join(workDir, f)).find((f) => /audio\.\w+$/.test(f));
      }
      if (!outFile) throw new Error('받은 오디오 파일을 찾지 못했습니다');

      // 2-1) 아이팟용 MP3 변환: 44.1kHz + 트루 피크 여유 확보
      this.update(job, { state: 'converting', progress: 1 });
      const master = await encodeForIpod(outFile, path.join(workDir, 'ipod.mp3'), settings.quality || '0');
      outFile = master.file;
      log(`변환: 44.1kHz, 원본 트루 피크 ${master.truePeak.toFixed(1)} dBTP → 게인 ${master.gain.toFixed(1)} dB`);

      // 3) 태깅
      this.update(job, { state: 'tagging' });
      const [lyrics, cover] = await Promise.all([lyricsP, coverP]);
      const tags = {
        title: meta.title,
        artist: meta.artist,
        album: meta.album || '',
        performerInfo: meta.albumArtist || meta.artist,
        year: meta.year || '',
        trackNumber: meta.trackNo ? (meta.trackCount ? `${meta.trackNo}/${meta.trackCount}` : String(meta.trackNo)) : '',
        comment: { language: 'eng', text: url },
        userDefinedUrl: [{ description: 'YouTube Music', url }],
        encodedBy: 'Composer',
        userDefinedText: [{ description: 'COMPOSER_MASTER', value: MASTER_VERSION }],
        length: meta.duration ? String(Math.round(meta.duration * 1000)) : '',
      };
      if (cover) {
        tags.image = { mime: 'image/jpeg', type: { id: 3, name: 'front cover' }, description: 'Cover', imageBuffer: cover };
      }
      if (lyrics?.plain) {
        const language = langOf(lyrics.plain);
        tags.unsynchronisedLyrics = { language, text: lyrics.plain };
        if (lyrics.synced?.length) {
          tags.synchronisedLyrics = [
            {
              language,
              timeStampFormat: NodeID3.TagConstants.TimeStampFormat.MILLISECONDS,
              contentType: NodeID3.TagConstants.SynchronisedLyrics.ContentType.LYRICS,
              shortText: 'Lyrics',
              synchronisedText: lyrics.synced.map((l) => ({ text: l.text, timeStamp: Math.round(l.t * 1000) })),
            },
          ];
        }
      }
      const ok = NodeID3.write(tags, outFile);
      if (ok !== true) throw new Error('ID3 태그 쓰기 실패');

      // 4) 보관함 정리: 아티스트/앨범/NN 제목.mp3
      // (아이팟용으로 다시 받는 경우 기존 파일 자리를 그대로 덮어쓴다)
      const root = settings.musicDir;
      let dir = path.join(root, safe(meta.albumArtist || meta.artist), safe(meta.album || '싱글'));
      let base = (meta.trackNo ? String(meta.trackNo).padStart(2, '0') + ' ' : '') + safe(meta.title);
      if (job.meta.replaceFile) {
        dir = path.dirname(job.meta.replaceFile);
        base = path.basename(job.meta.replaceFile, '.mp3');
      }
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, base + '.mp3');
      fs.copyFileSync(outFile, dest);
      if (lyrics?.synced?.length && settings.writeLrc !== false) {
        fs.writeFileSync(path.join(dir, base + '.lrc'), toLrc(lyrics.synced), 'utf8');
      }
      this.update(job, {
        state: 'done',
        progress: 1,
        file: dest,
        result: {
          cover: !!cover,
          lyrics: lyrics ? (lyrics.instrumental ? '연주곡' : lyrics.synced ? '싱크 가사' : '일반 가사') : '없음',
          lyricsSource: lyrics?.source || null,
        },
      });
      this.emit('done', dest);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}

// 이미 받은 곡의 가사를 다시 찾아 태그와 .lrc에 쓴다
async function refreshLyrics(file, { writeLrc = true, log = () => {} } = {}) {
  const t = NodeID3.read(file, { exclude: ['APIC'] }) || {};
  const url = t.comment?.text || t.userDefinedUrl?.[0]?.url || '';
  const videoId = (url.match(/[?&]v=([\w-]{11})/) || [])[1];
  const meta = {
    videoId,
    title: t.title || path.basename(file, '.mp3').replace(/^\d+\s+/, ''),
    artist: t.artist || '',
    album: t.album || '',
    duration: Number(t.length) / 1000 || 0,
  };
  const lyrics = await findLyrics(meta, log);
  if (!lyrics?.plain) return { file, found: false, instrumental: !!lyrics?.instrumental };
  const language = langOf(lyrics.plain);
  const tags = { unsynchronisedLyrics: { language, text: lyrics.plain } };
  if (lyrics.synced?.length) {
    tags.synchronisedLyrics = [
      {
        language,
        timeStampFormat: NodeID3.TagConstants.TimeStampFormat.MILLISECONDS,
        contentType: NodeID3.TagConstants.SynchronisedLyrics.ContentType.LYRICS,
        shortText: 'Lyrics',
        synchronisedText: lyrics.synced.map((l) => ({ text: l.text, timeStamp: Math.round(l.t * 1000) })),
      },
    ];
  }
  const ok = NodeID3.update(tags, file);
  if (ok !== true) throw new Error('태그 쓰기 실패');
  if (lyrics.synced?.length && writeLrc) fs.writeFileSync(file.replace(/\.mp3$/i, '.lrc'), toLrc(lyrics.synced), 'utf8');
  return { file, found: true, synced: !!lyrics.synced?.length, source: lyrics.source };
}

function addBinDir(dir) {
  if (!ENV.PATH.split(":").includes(dir)) ENV.PATH = dir + ":" + ENV.PATH;
}

module.exports = { Downloader, checkDeps, refreshLyrics, encodeForIpod, measureTruePeak, MASTER_VERSION, which, run, ENV, addBinDir };
