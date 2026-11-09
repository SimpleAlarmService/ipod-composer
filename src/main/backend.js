// Python 동기화 백엔드(backend/server.py) 사이드카 관리
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..', '..', 'backend');

class Backend extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.seq = 0;
    this.pending = new Map();
    this.ready = null;
    this.lastError = null;
  }

  // 패키징된 앱: Resources/backend/composer-backend (PyInstaller)
  // 개발 모드: backend/.venv의 Python으로 server.py 실행
  command() {
    const frozen = process.resourcesPath
      ? path.join(process.resourcesPath, 'backend', 'composer-backend', 'composer-backend')
      : null;
    if (frozen && fs.existsSync(frozen)) return { cmd: frozen, args: [], cwd: path.dirname(frozen) };
    const venv = path.join(ROOT, '.venv', 'bin', 'python');
    if (fs.existsSync(venv)) return { cmd: venv, args: ['-I', path.join(ROOT, 'server.py')], cwd: ROOT };
    return null;
  }

  start() {
    if (this.ready) return this.ready;
    const run = this.command();
    if (!run) {
      this.lastError = '백엔드 Python 환경이 없습니다. 터미널에서 backend/setup.sh 를 실행하세요.';
      this.ready = Promise.reject(new Error(this.lastError));
      this.ready.catch(() => {});
      return this.ready;
    }
    this.ready = new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        PATH: ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || ''].join(':'),
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
      };
      const p = spawn(run.cmd, run.args, { env, cwd: run.cwd });
      this.proc = p;
      let buf = '';
      const timer = setTimeout(() => reject(new Error('백엔드 시작 시간 초과')), 30000);
      p.stdout.on('data', (d) => {
        buf += d;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let m;
          try {
            m = JSON.parse(line);
          } catch (_) {
            continue;
          }
          if (m.event === 'ready') {
            clearTimeout(timer);
            resolve();
          } else if (m.event) {
            this.emit(m.event, m.data);
          } else if (this.pending.has(m.id)) {
            const { res, rej } = this.pending.get(m.id);
            this.pending.delete(m.id);
            m.error ? rej(new Error(m.error)) : res(m.result);
          }
        }
      });
      p.stderr.on('data', (d) => {
        const s = String(d);
        if (!/WARNING/.test(s)) process.stderr.write('[backend] ' + s);
      });
      p.on('exit', (code) => {
        clearTimeout(timer);
        for (const { rej } of this.pending.values()) rej(new Error('백엔드가 종료되었습니다'));
        this.pending.clear();
        this.proc = null;
        this.ready = null;
        if (code) this.lastError = `백엔드 종료 (코드 ${code})`;
        reject(new Error(this.lastError || '백엔드 종료'));
      });
    });
    this.ready.catch((e) => (this.lastError = e.message));
    return this.ready;
  }

  async call(method, params = {}) {
    await this.start();
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  stop() {
    if (this.proc) this.proc.kill();
  }
}

module.exports = new Backend();
