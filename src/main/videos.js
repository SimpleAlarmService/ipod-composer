// YouTube 동영상: 검색, 받기, 아이팟용 영상 변환, 영상 보관함
// 영상은 설정의 videoDir(기본 ~/Movies/iPod Composer) 아래에 H.264 Baseline + AAC (.m4v)로 저장한다.
// 아이팟 비디오·클래식·나노 3세대 이상이 재생할 수 있는 규격: 640x480 이하, Baseline 3.0, 30fps, AAC-LC.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { which, ENV } = require('./downloader');

const safe = (s) =>
  String(s || '영상')
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 110) || '영상';

function probe(file) {
  return new Promise((resolve) =>
    execFile(
      which('ffprobe') || 'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration:format_tags=title,artist,date,comment', '-of', 'json', file],
      { env: ENV, timeout: 8000 },
      (err, out) => {
        if (err) return resolve({});
        try {
          const f = JSON.parse(out).format || {};
          resolve({ duration: Number(f.duration) || 0, tags: f.tags || {} });
        } catch (_) {
          resolve({});
        }
      }
    )
  );
}

class Videos extends EventEmitter {
  constructor(getDir) {
    super();
    this.getDir = getDir;
    this.jobs = new Map(); // key → {state, progress, error, file}
    this.probeCache = new Map(); // file → {mtime, info}
  }

  // ---------- 검색 (yt-dlp) ----------
  search(query, limit = 24) {
    const ytdlp = which('yt-dlp');
    if (!ytdlp) return Promise.reject(new Error('yt-dlp가 필요합니다'));
    return new Promise((resolve, reject) =>
      execFile(
        ytdlp,
        ['--flat-playlist', '--no-warnings', '-J', `ytsearch${limit}:${query}`],
        { env: ENV, timeout: 30000, maxBuffer: 1 << 26 },
        (err, out) => {
          if (err) return reject(new Error('YouTube 검색 실패'));
          try {
            const entries = JSON.parse(out).entries || [];
            resolve(
              entries
                .filter((e) => e.id && e.live_status !== 'is_live' && e.live_status !== 'is_upcoming')
                .map((e) => ({
                  videoId: e.id,
                  title: e.title || '',
                  channel: e.channel || e.uploader || '',
                  duration: e.duration || 0,
                  views: e.view_count || 0,
                  thumb: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
                  job: this.jobInfo(`yt:${e.id}`),
                  file: this.findDownloaded(e.id),
                }))
            );
          } catch (e) {
            reject(e);
          }
        }
      )
    );
  }

  jobInfo(key) {
    const j = this.jobs.get(key);
    return j ? { state: j.state, progress: j.progress, error: j.error } : null;
  }

  // ---------- 영상 보관함 ----------
  walk(dir, out = []) {
    let ents = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return out;
    }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) this.walk(p, out);
      else if (/\.(m4v|mp4|mov)$/i.test(e.name)) out.push(p);
    }
    return out;
  }

  async library() {
    const root = this.getDir();
    const files = this.walk(root);
    const out = [];
    for (const file of files) {
      const st = fs.statSync(file);
      let c = this.probeCache.get(file);
      if (!c || c.mtime !== st.mtimeMs) {
        c = { mtime: st.mtimeMs, info: await probe(file) };
        this.probeCache.set(file, c);
      }
      const tags = c.info.tags || {};
      const vid = (String(tags.comment || '').match(/youtube\.com\/watch\?v=([\w-]{11})/) || [])[1];
      out.push({
        file,
        folder: path.relative(root, path.dirname(file)) || '',
        title: tags.title || path.basename(file).replace(/\.\w+$/, ''),
        artist: tags.artist || '',
        year: tags.date || '',
        duration: c.info.duration || 0,
        size: st.size,
        added: st.mtimeMs,
        thumb: vid ? `https://i.ytimg.com/vi/${vid}/mqdefault.jpg` : null,
      });
    }
    return out.sort((a, b) => b.added - a.added);
  }

  findDownloaded(videoId) {
    const dir = path.join(this.getDir(), 'YouTube');
    try {
      const f = fs.readdirSync(dir).find((n) => n.includes(`[${videoId}]`));
      return f ? path.join(dir, f) : null;
    } catch (_) {
      return null;
    }
  }

  // ---------- 받기 ----------
  update(key, patch) {
    const j = Object.assign(this.jobs.get(key) || {}, patch);
    this.jobs.set(key, j);
    this.emit('update', { key, state: j.state, progress: j.progress, error: j.error, file: j.file || null });
  }

  /**
   * key: 작업 식별자, url: yt-dlp 주소, out: 저장 경로(.m4v), tags: ffmpeg 메타데이터, fallbackUrl: 실패 시 대체 주소
   */
  async download({ key, url, fallbackUrl, out, tags = {} }) {
    const cur = this.jobs.get(key);
    if (cur && ['downloading', 'converting'].includes(cur.state)) return cur.file;
    const ytdlp = which('yt-dlp');
    const ffmpeg = which('ffmpeg');
    if (!ytdlp || !ffmpeg) throw new Error('yt-dlp와 ffmpeg가 필요합니다');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-video-'));
    try {
      this.update(key, { state: 'downloading', progress: 0, error: null, file: null });
      let src;
      try {
        src = await this.fetch(ytdlp, url, work, key);
      } catch (e) {
        if (!fallbackUrl) throw e;
        src = await this.fetch(ytdlp, fallbackUrl, work, key);
      }
      this.update(key, { state: 'converting', progress: 0 });
      const tmp = path.join(work, 'out.m4v');
      await this.convert(ffmpeg, src, tmp, tags, key);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.copyFileSync(tmp, out);
      this.update(key, { state: 'done', progress: 1, file: out });
      this.emit('done', out);
      return out;
    } catch (e) {
      this.update(key, { state: 'error', error: String(e.message).split('\n').filter(Boolean).pop() });
      throw e;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  // YouTube 검색 결과 하나를 받는다 → videoDir/YouTube/제목 [videoId].m4v
  downloadYouTube(v) {
    const out = path.join(this.getDir(), 'YouTube', `${safe(v.title)} [${v.videoId}].m4v`);
    return this.download({
      key: `yt:${v.videoId}`,
      url: `https://www.youtube.com/watch?v=${v.videoId}`,
      out,
      tags: {
        title: v.title,
        artist: v.channel,
        album: 'YouTube',
        comment: `https://www.youtube.com/watch?v=${v.videoId}`,
      },
    });
  }

  fetch(ytdlp, url, work, key) {
    return new Promise((resolve, reject) => {
      const args = [
        '--no-playlist', '--newline', '--progress', '--no-warnings',
        '-f', 'bv*[height<=720]+ba/b[height<=720]/b',
        '--merge-output-format', 'mp4',
        '--progress-template', 'download:@@%(progress._percent_str)s',
        '-o', path.join(work, 'src.%(ext)s'),
        '--print', 'after_move:filepath',
        url,
      ];
      const p = spawn(ytdlp, args, { env: ENV });
      let file = null;
      let err = '';
      let buf = '';
      p.stdout.on('data', (d) => {
        buf += d;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const l of lines) {
          if (l.startsWith('@@')) {
            const v = parseFloat(l.slice(2));
            if (!isNaN(v)) this.update(key, { progress: v / 100 });
          } else if (l.trim().startsWith('/')) file = l.trim();
        }
      });
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (code) => {
        if (buf.trim().startsWith('/')) file = buf.trim();
        code === 0 && file && fs.existsSync(file) ? resolve(file) : reject(new Error(err || `yt-dlp 종료 코드 ${code}`));
      });
    });
  }

  // 아이팟 비디오 규격으로 변환 (가로세로 비율 유지, 640x480 안에 맞춤)
  convert(ffmpeg, src, dst, tags, key) {
    return new Promise((resolve, reject) => {
      const meta = Object.entries(tags).flatMap(([k, v]) => (v ? ['-metadata', `${k}=${v}`] : []));
      const args = [
        '-hide_banner', '-nostdin', '-y', '-i', src,
        '-vf', "scale='min(640,iw)':'min(480,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30",
        '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.0', '-pix_fmt', 'yuv420p',
        '-b:v', '1200k', '-maxrate', '1500k', '-bufsize', '2000k',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
        '-movflags', '+faststart',
        ...meta,
        '-progress', 'pipe:1', '-nostats',
        dst,
      ];
      const p = spawn(ffmpeg, args, { env: ENV });
      let dur = 0;
      let err = '';
      p.stderr.on('data', (d) => {
        err += d;
        const m = String(d).match(/Duration: (\d+):(\d+):([\d.]+)/);
        if (m) dur = +m[1] * 3600 + +m[2] * 60 + +m[3];
      });
      p.stdout.on('data', (d) => {
        const m = String(d).match(/out_time_ms=(\d+)/);
        if (m && dur) this.update(key, { progress: Math.min(1, +m[1] / 1e6 / dur) });
      });
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.split('\n').slice(-3).join(' ')))));
    });
  }
}

module.exports = { Videos, safe };
