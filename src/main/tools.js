// 외부 도구(yt-dlp, ffmpeg, fpcalc) 버전 확인·업데이트
// - Homebrew로 설치된 도구: brew update → brew outdated 로 확인, brew upgrade/install 로 설치
// - Homebrew가 없을 때: yt-dlp만 GitHub 공식 릴리스(yt-dlp_macos)를 앱 전용 폴더에 받는다
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { which, run, ENV, addBinDir } = require('./downloader');

const TOOLS = [
  { id: 'yt-dlp', bin: 'yt-dlp', formula: 'yt-dlp', label: 'yt-dlp', versionArgs: ['--version'] },
  { id: 'ffmpeg', bin: 'ffmpeg', formula: 'ffmpeg', label: 'FFmpeg', versionArgs: ['-version'] },
  { id: 'fpcalc', bin: 'fpcalc', formula: 'chromaprint', label: 'Chromaprint', versionArgs: ['-version'] },
];

const BREW_PATHS = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
const brewPath = () => BREW_PATHS.find((p) => fs.existsSync(p)) || null;

// yt-dlp 2026.10.26 / brew 2026.10.26_1 / ffmpeg 9.0.2_1 → 비교용으로 정리
const cleanVer = (v) => String(v || '').replace(/_\d+$/, '').replace(/\.0(\d)/g, '.$1');
const sameVer = (a, b) => cleanVer(a) === cleanVer(b);

class Tools extends EventEmitter {
  constructor({ binDir, getSettings, saveSettings, isBusy }) {
    super();
    this.binDir = binDir;
    this.getSettings = getSettings;
    this.saveSettings = saveSettings;
    this.isBusy = isBusy;
    this.state = { checking: false, installing: false, lastCheck: getSettings().lastToolCheck || null, error: null, tools: [], log: [] };
    fs.mkdirSync(binDir, { recursive: true });
    addBinDir(binDir);
  }

  snapshot() {
    return { ...this.state, brew: !!brewPath(), log: this.state.log.slice(-6) };
  }
  emitState() {
    this.emit('state', this.snapshot());
  }
  logLine(line) {
    const l = String(line).trim();
    if (!l) return;
    this.state.log.push(l);
    if (this.state.log.length > 200) this.state.log.shift();
    this.emitState();
  }

  async localStatus() {
    const out = [];
    for (const t of TOOLS) {
      const p = which(t.bin);
      let version = null;
      let source = 'missing';
      if (p) {
        try {
          const real = fs.realpathSync(p);
          source = real.includes('/Cellar/') ? 'brew' : real.startsWith(this.binDir) ? 'managed' : 'other';
          const v = await run(p, t.versionArgs);
          const line = v.split('\n')[0];
          version =
            t.id === 'ffmpeg'
              ? line.replace(/^ffmpeg version /, '').split(' ')[0]
              : t.id === 'fpcalc'
                ? (line.match(/([\d.]+)/) || [])[1]
                : line.trim();
          // brew 설치본은 Cellar 경로의 버전(리비전 포함)이 정확하다
          const cellar = real.match(/\/Cellar\/[^/]+\/([^/]+)\//);
          if (cellar) version = cellar[1];
        } catch (_) {}
      }
      out.push({ id: t.id, label: t.label, formula: t.formula, path: p, version, source });
    }
    return out;
  }

  async brew(args, { stream = false, env = {}, okCodes = [0] } = {}) {
    const b = brewPath();
    if (!b) throw new Error('Homebrew가 없습니다');
    return new Promise((resolve, reject) => {
      const p = spawn(b, args, {
        env: { ...ENV, HOMEBREW_NO_ENV_HINTS: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1', NONINTERACTIVE: '1', ...env },
      });
      let out = '';
      let err = '';
      const onData = (d) => {
        const s = String(d);
        out += s;
        if (stream) s.split(/\r?\n/).forEach((l) => this.logLine(l));
      };
      p.stdout.on('data', onData);
      p.stderr.on('data', (d) => {
        err += d;
        if (stream) String(d).split(/\r?\n/).forEach((l) => this.logLine(l));
      });
      p.on('close', (code) => (okCodes.includes(code) ? resolve(out) : reject(new Error((err || out).trim().split('\n').slice(-2).join(' ')))));
    });
  }

  async githubLatestYtdlp() {
    const r = await fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', {
      headers: { 'user-agent': 'Composer', accept: 'application/vnd.github+json' },
    });
    if (!r.ok) throw new Error('GitHub 조회 실패 ' + r.status);
    const j = await r.json();
    const asset = j.assets?.find((a) => a.name === 'yt-dlp_macos');
    return { version: j.tag_name, url: asset?.browser_download_url };
  }

  // 새 버전 확인
  async check({ silent = false } = {}) {
    if (this.state.checking || this.state.installing) return this.snapshot();
    this.state.checking = true;
    this.state.error = null;
    this.emitState();
    try {
      const tools = await this.localStatus();
      if (brewPath()) {
        await this.brew(['update', '--quiet']).catch((e) => this.logLine('brew update 실패: ' + e.message));
        const brewed = tools.filter((t) => t.source === 'brew').map((t) => t.formula);
        if (brewed.length) {
          const j = JSON.parse(await this.brew(['outdated', '--json=v2', '--formula', ...brewed], { env: { HOMEBREW_NO_AUTO_UPDATE: '1' }, okCodes: [0, 1] }));
          for (const f of j.formulae || []) {
            const t = tools.find((x) => x.formula === f.name);
            if (t) t.latest = f.current_version;
          }
        }
        // 설치 안 된 도구는 brew의 최신 안정 버전을 보여 준다
        const missing = tools.filter((t) => t.source === 'missing');
        if (missing.length) {
          const info = JSON.parse(await this.brew(['info', '--json=v2', ...missing.map((t) => t.formula)], { env: { HOMEBREW_NO_AUTO_UPDATE: '1' } }));
          for (const f of info.formulae || []) {
            const t = tools.find((x) => x.formula === f.name);
            if (t) t.latest = f.versions?.stable;
          }
        }
      }
      // brew 밖에서 설치된 yt-dlp(또는 brew 없음)는 GitHub 기준
      const yt = tools.find((t) => t.id === 'yt-dlp');
      if (yt && (yt.source === 'managed' || (!brewPath() && yt.source !== 'other'))) {
        try {
          const gh = await this.githubLatestYtdlp();
          if (!yt.version || !sameVer(yt.version, gh.version)) yt.latest = gh.version;
        } catch (e) {
          this.logLine(e.message);
        }
      }
      for (const t of tools) {
        t.update = !!t.latest && (t.source === 'missing' || !sameVer(t.version, t.latest));
        t.installable = t.source === 'brew' || t.source === 'managed' || (t.source === 'missing' && (brewPath() || t.id === 'yt-dlp'));
        if (t.source === 'other') t.note = '직접 설치한 파일이라 앱에서 업데이트하지 않습니다';
        else if (t.source === 'missing' && !t.installable) t.note = 'Homebrew(brew.sh)를 먼저 설치하세요';
      }
      this.state.tools = tools;
      this.state.lastCheck = Date.now();
      this.saveSettings({ lastToolCheck: this.state.lastCheck });
      if (!silent) this.logLine(`확인 완료 · 업데이트 ${tools.filter((t) => t.update).length}개`);
    } catch (e) {
      this.state.error = e.message;
    } finally {
      this.state.checking = false;
      this.emitState();
    }
    return this.snapshot();
  }

  // 업데이트 설치 (ids 없으면 업데이트가 있는 것 전부)
  async install(ids) {
    if (this.state.installing) throw new Error('이미 설치 중입니다');
    if (this.isBusy()) throw new Error('다운로드가 끝난 뒤에 업데이트하세요');
    const targets = this.state.tools.filter((t) => t.update && t.installable && (!ids || ids.includes(t.id)));
    if (!targets.length) return this.snapshot();
    this.state.installing = true;
    this.state.error = null;
    this.state.log = [];
    this.emitState();
    try {
      const upgrade = targets.filter((t) => t.source === 'brew').map((t) => t.formula);
      const install = targets.filter((t) => t.source === 'missing' && brewPath()).map((t) => t.formula);
      if (upgrade.length) {
        this.logLine(`brew upgrade ${upgrade.join(' ')}`);
        await this.brew(['upgrade', ...upgrade], { stream: true, env: { HOMEBREW_NO_AUTO_UPDATE: '1' } });
      }
      if (install.length) {
        this.logLine(`brew install ${install.join(' ')}`);
        await this.brew(['install', ...install], { stream: true, env: { HOMEBREW_NO_AUTO_UPDATE: '1' } });
      }
      const ytManaged = targets.find((t) => t.id === 'yt-dlp' && (t.source === 'managed' || (t.source === 'missing' && !brewPath())));
      if (ytManaged) {
        const gh = await this.githubLatestYtdlp();
        if (!gh.url) throw new Error('yt-dlp_macos 파일을 찾지 못했습니다');
        this.logLine(`yt-dlp ${gh.version} 받는 중 (GitHub)`);
        const buf = Buffer.from(await (await fetch(gh.url)).arrayBuffer());
        const dst = path.join(this.binDir, 'yt-dlp');
        fs.writeFileSync(dst + '.new', buf, { mode: 0o755 });
        fs.renameSync(dst + '.new', dst);
      }
      this.logLine('설치 완료');
    } catch (e) {
      this.state.error = e.message;
      this.logLine('실패: ' + e.message);
    } finally {
      this.state.installing = false;
    }
    // 설치 후 다시 확인해서 버전을 갱신한다
    await this.check({ silent: true });
    this.emit('installed');
    return this.snapshot();
  }

  // 하루 한 번 자동 확인 (설정에 따라 자동 설치)
  schedule() {
    const tick = async () => {
      const s = this.getSettings();
      if (s.toolAutoCheck === false) return;
      if (Date.now() - (s.lastToolCheck || 0) < 24 * 3600 * 1000) {
        if (!this.state.tools.length) this.state.tools = await this.localStatus().catch(() => []);
        this.emitState();
        return;
      }
      await this.check({ silent: true });
      if (s.toolAutoInstall && this.state.tools.some((t) => t.update && t.installable) && !this.isBusy()) {
        await this.install().catch(() => {});
      }
    };
    setTimeout(tick, 15 * 1000);
    setInterval(tick, 60 * 60 * 1000);
  }
}

module.exports = { Tools };
