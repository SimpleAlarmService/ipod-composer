// The preservation project provides already unpacked device files in this release asset.
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');
const catalog = require('./games_catalog.json');

const PROJECT = 'https://github.com/Olsro/ipodclickwheelgamespreservationproject';
const RELEASE = 'version16';
const RELEASE_URL = `${PROJECT}/releases/tag/${RELEASE}`;
const ARCHIVE = 'iPod.Games.Files.7z';
const ARCHIVE_BYTES = 1800542124;
const ARCHIVE_HASH = 'c532208b700e10edf621ec65cf188d546a2a4f043106bad3dd53caf9ed14df06';
const ARCHIVE_ROOT = 'iPod Games Files';
const run = promisify(execFile);

function gameSupport(device) {
  if (device.virtual || device.needsInit) return null;
  const { family, generation } = device;
  if (family === 'iPod' && ['5th Gen', '5.5th Gen'].includes(generation)) return 'video';
  if (family === 'iPod Classic' && ['6th Gen', '6.5th Gen', '7th Gen'].includes(generation)) return 'common';
  if (family === 'iPod Nano' && ['3rd Gen', '4th Gen', '5th Gen'].includes(generation)) return 'common';
  return null;
}

async function entry(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

async function deviceDirectory(dir, dev) {
  const stat = await entry(dir);
  if (!stat?.isDirectory() || (dev !== undefined && stat.dev !== dev)) {
    throw new Error('아이팟의 디스크 폴더를 확인할 수 없습니다. USB 연결을 확인하세요.');
  }
  return stat;
}

const mountIdentity = (device, mount, control) => JSON.stringify([device.serial, mount.dev, mount.ino, control.ino]);

async function deviceState(device) {
  const support = gameSupport(device);
  if (!support || path.dirname(device.path) !== '/Volumes') throw new Error('지원되는 실제 아이팟을 연결하세요.');
  const mount = await deviceDirectory(device.path);
  if (mount.dev === (await fs.stat('/Volumes')).dev) throw new Error('아이팟이 디스크로 연결되어 있지 않습니다.');
  const control = path.join(device.path, 'iPod_Control');
  const controlStat = await deviceDirectory(control, mount.dev);
  const itunes = path.join(control, 'iTunes');
  await deviceDirectory(itunes, mount.dev);
  const auth = await entry(path.join(itunes, 'IC-Info.sidb'));
  const gameDir = path.join(control, 'Games_RO');
  const gameStat = await entry(gameDir);
  if (gameStat) await deviceDirectory(gameDir, mount.dev);
  const installed = gameStat
    ? (await fs.readdir(gameDir, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name.toUpperCase())
    : [];
  return {
    mountKey: mountIdentity(device, mount, controlStat),
    hasAuth: !!(auth?.isFile() && auth.dev === mount.dev && auth.size),
    installed, support,
  };
}

function gamePath(root, game) {
  const group = game.videoOnly ? 'iPod Videos (5G and 5.5G only)' : 'All iPods';
  return path.join(root, ARCHIVE_ROOT, group, 'iPod_Control', 'Games_RO', game.id);
}

async function copyGameFolder(source, destination) {
  await fs.mkdir(destination);
  for (const item of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, item.name);
    const to = path.join(destination, item.name);
    if (item.isDirectory()) await copyGameFolder(from, to);
    else if (item.isFile()) {
      await pipeline(createReadStream(from), createWriteStream(to, { flags: 'wx' }));
    } else throw new Error('게임 팩에 지원하지 않는 파일이 있습니다.');
  }
}

class Games {
  constructor(cache, progress) {
    this.cache = cache;
    this.releaseDir = path.join(cache, RELEASE);
    this.progress = progress;
    this.importing = null;
  }

  async info() {
    return {
      catalog,
      ready: (await entry(this.releaseDir))?.isDirectory() ?? false,
      archiveBytes: ARCHIVE_BYTES,
      release: RELEASE,
    };
  }

  cancel() {
    this.importing?.abort();
  }

  async prepare(localArchive) {
    if (this.importing) throw new Error('게임 팩을 준비 중입니다.');
    if ((await this.info()).ready) return this.info();
    if (this.importing) throw new Error('게임 팩을 준비 중입니다.');
    const controller = new AbortController();
    this.importing = controller;
    let work;
    try {
      await fs.mkdir(this.cache, { recursive: true });
      const { bavail, bsize } = await fs.statfs(this.cache);
      if (bavail * bsize < 6e9) throw new Error('게임 팩을 준비하려면 Mac에 6 GB의 여유 공간이 필요합니다.');
      if (localArchive && (await fs.stat(localArchive)).size !== ARCHIVE_BYTES) {
        throw new Error('보존 프로젝트 v16의 iPod.Games.Files.7z 파일을 선택하세요.');
      }
      work = await fs.mkdtemp(path.join(this.cache, '.import-'));
      const archive = path.join(work, ARCHIVE);
      const phase = localArchive ? 'import' : 'download';
      this.progress({ phase, done: 0, total: ARCHIVE_BYTES });
      let source;
      if (localArchive) {
        source = createReadStream(localArchive);
      } else {
        const url = `${PROJECT}/releases/download/${RELEASE}/${ARCHIVE}`;
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`GitHub 다운로드 실패 (${response.status})`);
        source = response.body;
      }
      const hash = createHash('sha256');
      let done = 0;
      let lastUpdate = 0;
      const measure = new Transform({
        transform: (chunk, _encoding, next) => {
          done += chunk.length;
          if (done > ARCHIVE_BYTES) return next(new Error('게임 팩의 크기가 릴리스와 다릅니다.'));
          hash.update(chunk);
          if (Date.now() - lastUpdate > 150 || done === ARCHIVE_BYTES) {
            this.progress({ phase, done, total: ARCHIVE_BYTES });
            lastUpdate = Date.now();
          }
          next(null, chunk);
        },
      });
      await pipeline(source, measure, createWriteStream(archive), { signal: controller.signal });
      if (done !== ARCHIVE_BYTES || hash.digest('hex') !== ARCHIVE_HASH) {
        throw new Error('게임 팩의 SHA-256이 보존 프로젝트의 릴리스와 일치하지 않습니다.');
      }
      this.progress({ phase: 'extract' });
      const unpacked = path.join(work, 'unpacked');
      await fs.mkdir(unpacked);
      await run('/usr/bin/tar', ['-xf', archive, '-C', unpacked, '--no-same-owner', '--no-same-permissions'], {
        signal: controller.signal,
        env: { ...process.env, COPYFILE_DISABLE: '1' },
      });
      for (const game of catalog) {
        if (!(await entry(gamePath(unpacked, game)))?.isDirectory()) throw new Error(`게임 팩에서 ${game.title} 파일을 찾지 못했습니다.`);
      }
      controller.signal.throwIfAborted();
      await fs.rename(unpacked, this.releaseDir);
      return this.info();
    } finally {
      try {
        if (work) await fs.rm(work, { recursive: true, force: true });
      } finally {
        this.importing = null;
      }
    }
  }

  async sync(device, mountKey, ids) {
    if (!Array.isArray(ids) || !ids.length) throw new Error('동기화할 게임을 선택하세요.');
    const selected = catalog.filter((game) => ids.includes(game.id));
    if (selected.length !== ids.length) throw new Error('게임 선택을 다시 확인하세요.');
    if (!(await this.info()).ready) throw new Error('게임 팩을 먼저 받아 주세요.');
    const target = await deviceState(device);
    if (target.mountKey !== mountKey) throw new Error('아이팟 연결이 바뀌었습니다. 기기를 다시 선택하세요.');
    if (!target.hasAuth) throw new Error('이 아이팟에서 게임 인증 파일을 찾지 못했습니다.');
    if (selected.some((game) => game.videoOnly && target.support !== 'video')) {
      throw new Error('iPod video 전용 게임이 선택되었습니다.');
    }

    const control = path.join(device.path, 'iPod_Control');
    const gameDir = path.join(control, 'Games_RO');
    const pending = selected.filter((game) => !target.installed.includes(game.id));
    if (!pending.length) return { added: 0, skipped: selected.length };
    const { bavail, bsize } = await fs.statfs(device.path);
    if (pending.reduce((sum, game) => sum + game.bytes, 0) > bavail * bsize) {
      throw new Error('아이팟의 저장 공간이 부족합니다.');
    }
    const assertMounted = async () => {
      const mount = await deviceDirectory(device.path);
      const current = await deviceDirectory(control, mount.dev);
      if (mountIdentity(device, mount, current) !== mountKey) throw new Error('아이팟 연결이 끊어졌습니다.');
      return mount.dev;
    };

    let added = 0;
    const dev = await assertMounted();
    await fs.mkdir(gameDir).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    await deviceDirectory(gameDir, dev);
    const staging = await fs.mkdtemp(path.join(control, '.composer-games-'));
    try {
      for (const [index, game] of pending.entries()) {
        await assertMounted();
        this.progress({ phase: 'sync', done: index, total: pending.length, title: game.title });
        const destination = path.join(gameDir, game.id);
        if (await entry(destination)) continue;
        const source = gamePath(this.releaseDir, game);
        const copy = path.join(staging, game.id);
        // Publish a game folder only after all its files have been copied.
        if (!(await entry(source))?.isDirectory()) throw new Error(`게임 팩에서 ${game.title} 파일을 찾지 못했습니다.`);
        await copyGameFolder(source, copy);
        await assertMounted();
        // macOS can add AppleDouble files even when creating plain files on FAT32.
        await run('/usr/sbin/dot_clean', ['-m', staging]);
        await assertMounted();
        await deviceDirectory(gameDir, dev);
        if (await entry(destination)) continue;
        await fs.rename(copy, destination);
        added++;
      }
      return { added, skipped: selected.length - added };
    } finally {
      await assertMounted();
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
}

module.exports = { Games, PROJECT, RELEASE_URL, gameSupport, deviceState };
