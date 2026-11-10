const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const NodeID3 = require('node-id3');
const ytm = require('./ytmusic');
const { parseLrc, setExtraProvider } = require('./lyrics');
const backend = require('./backend');
const { Tools } = require('./tools');
const musicApp = require('./musicapp');
const { Ads } = require('./ads');
const { Videos } = require('./videos');
const { Games, PROJECT: GAMES_PROJECT, RELEASE_URL: GAMES_RELEASE, gameSupport, deviceState: gameDeviceState } = require('./games');
const { Downloader, checkDeps, refreshLyrics, refreshCover, imageDims, MASTER_VERSION } = require('./downloader');

// 앱 이름을 'iPod Composer'로 바꿨지만 설정 폴더는 예전 'Composer' 그대로 쓴다 (설정·가상 기기 유지)
app.setName('iPod Composer');
app.setPath('userData', process.env.COMPOSER_USER_DATA || path.join(app.getPath('appData'), 'Composer'));
nativeTheme.themeSource = 'light'; // 2010년대 스큐어모픽은 라이트 전용

// ---------- 설정 ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const defaults = () => ({
  musicDir: path.join(os.homedir(), 'Music', 'Composer'),
  videoDir: path.join(os.homedir(), 'Movies', 'iPod Composer'), // Apple 광고 등 영상
  concurrency: 2,
  quality: '0',
  writeLrc: true,
  autoSync: false, // 다운로드가 끝나면 연결된 아이팟에 자동 동기화
  toolAutoCheck: true, // yt-dlp·ffmpeg 업데이트를 하루 한 번 확인
  toolAutoInstall: false, // 새 버전이 있으면 자동으로 설치
  musicAutoAdd: false, // 다운로드가 끝나면 Apple Music 앱에도 추가 (아이팟 터치·아이폰용)
  lastToolCheck: 0,
  syncMode: 'add', // add: 기존 곡 유지 · mirror: 보관함과 똑같이
  virtualIpods: [], // 테스트용 가상 아이팟 경로
});
let settings;
function loadSettings() {
  try {
    settings = { ...defaults(), ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch (_) {
    settings = defaults();
  }
  if (process.env.COMPOSER_MUSIC_DIR) settings.musicDir = process.env.COMPOSER_MUSIC_DIR;
  if (process.env.COMPOSER_VIDEO_DIR) settings.videoDir = process.env.COMPOSER_VIDEO_DIR;
  fs.mkdirSync(settings.musicDir, { recursive: true });
}
function saveSettings(patch) {
  settings = { ...settings, ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  fs.mkdirSync(settings.musicDir, { recursive: true });
  return settings;
}

// ---------- 보관함 ----------
function walk(dir, out = []) {
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.mp3$/i.test(e.name)) out.push(p);
  }
  return out;
}

function probeDuration(file) {
  try {
    const out = require('child_process').execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:' + process.env.PATH }, timeout: 5000 }
    );
    return Number(String(out).trim()) || 0;
  } catch (_) {
    return 0;
  }
}

const libCache = new Map(); // path → { mtime, entry }
function readEntry(file) {
  const st = fs.statSync(file);
  const c = libCache.get(file);
  if (c && c.mtime === st.mtimeMs) return c.entry;
  const t = NodeID3.read(file, { exclude: ['SYLT'] }) || {};
  const dims = imageDims(t.image?.imageBuffer);
  const [no, count] = String(t.trackNumber || '').split('/');
  const entry = {
    file,
    title: t.title || path.basename(file, '.mp3'),
    artist: t.artist || '',
    albumArtist: t.performerInfo || t.artist || '',
    album: t.album || '',
    year: t.year || '',
    trackNo: Number(no) || 0,
    trackCount: Number(count) || 0,
    duration: Number(t.length) / 1000 || probeDuration(file),
    hasLyrics: !!t.unsynchronisedLyrics?.text,
    coverWidth: dims?.w || 0,
    master: [].concat(t.userDefinedText || []).find((x) => x.description === 'COMPOSER_MASTER')?.value || null,
    videoId: ((t.comment?.text || '').match(/[?&]v=([\w-]{11})/) || [])[1] || null,
    size: st.size,
    added: st.birthtimeMs || st.mtimeMs,
  };
  libCache.set(file, { mtime: st.mtimeMs, entry });
  return entry;
}

function listLibrary() {
  return walk(settings.musicDir)
    .map((f) => {
      try {
        return readEntry(f);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

// ---------- 창 ----------
let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1220,
    height: 780,
    minWidth: 980,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#c9c9c9',
    title: 'iPod Composer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);

app.whenReady().then(() => {
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock.setIcon(path.join(__dirname, '..', '..', 'build', 'icon.png'));
  }
  loadSettings();
  const dl = new Downloader(() => settings);
  const busyJobs = () => dl.list().some((j) => !['done', 'error', 'canceled'].includes(j.state));
  const tools = new Tools({
    binDir: path.join(app.getPath('userData'), 'bin'),
    getSettings: () => settings,
    saveSettings: (patch) => saveSettings(patch),
    isBusy: busyJobs,
  });
  tools.on('state', (st) => send('tools:state', st));
  tools.schedule();
  ipcMain.handle('tools:state', async () => {
    if (!tools.state.tools.length) tools.state.tools = await tools.localStatus();
    return tools.snapshot();
  });
  ipcMain.handle('tools:check', () => tools.check());
  ipcMain.handle('tools:install', (_e, ids) => tools.install(ids));
  dl.on('update', (job) => send('dl:update', job));
  let autoTimer = null;
  dl.on('done', (file) => {
    send('library:changed');
    if (settings.musicAutoAdd && file) {
      musicApp.addToMusic([file]).then((r) => send('music:added', r)).catch((e) => send('music:error', e.message));
    }
    // 대기열이 비면 연결된 실제/가상 아이팟 중 첫 번째에 자동 동기화
    if (!settings.autoSync) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      const busy = dl.list().some((j) => !['done', 'error', 'canceled'].includes(j.state));
      const target = devices[0];
      // 자동 동기화는 확인 창이 없으므로 절대 곡을 지우지 않는 '추가만' 모드로 돈다
      if (!busy && target) syncDevice(target.path, { mode: 'add' }).catch(() => {});
    }, 1500);
  });
  dl.on('cleared', () => send('dl:cleared'));

  setExtraProvider((q) => backend.call('lyrics', q));
  backend.on('progress', (p) => send('ipod:progress', p));
  backend.start().catch(() => {});

  // ---------- 아이팟 ----------
  let devices = [];
  let scanning = null;
  const scan = () =>
    (scanning ||= backend
      .call('scan', { extraPaths: settings.virtualIpods })
      .then((list) => {
        devices = list.map((device) => ({ ...device, gamesSupport: gameSupport(device) }));
        send('ipod:devices', devices);
        return devices;
      })
      .catch((e) => {
        send('ipod:error', e.message);
        return devices;
      })
      .finally(() => (scanning = null)));
  try {
    fs.watch('/Volumes', () => setTimeout(scan, 1500));
  } catch (_) {}
  setTimeout(scan, 800);

  let syncing = false;
  let gameSyncing = false;
  const ejecting = new Set();
  async function syncDevice(devPath, opts = {}) {
    if (syncing || gameSyncing || ejecting.has(devPath)) throw new Error('이미 동기화 또는 꺼내기 작업이 진행 중입니다');
    syncing = true;
    send('ipod:state', { path: devPath, state: 'planning' });
    try {
      const plan = await backend.call('plan', {
        path: devPath,
        musicDir: settings.musicDir,
        mode: opts.mode || settings.syncMode,
        allowedPaths: opts.allowedPaths || null,
        dryRun: !!opts.planOnly, // 미리 보기는 기기에 아무것도 쓰지 않는다
        videoDir: settings.videoDir, // 영상을 지원하는 기기면 함께 동기화
      });
      if (opts.planOnly) {
        send('ipod:state', { path: devPath, state: 'idle' });
        return plan;
      }
      if (!plan.hasChanges) {
        send('ipod:state', { path: devPath, state: 'idle', message: '이미 최신 상태입니다' });
        return { ok: true, nothing: true, plan };
      }
      if (plan.bytesToAdd - plan.bytesToRemove > plan.freeBytes) throw new Error('아이팟 저장 공간이 부족합니다');
      send('ipod:state', { path: devPath, state: 'syncing', plan });
      const r = await backend.call('execute', { token: plan.token });
      send('ipod:state', { path: devPath, state: 'idle', result: r });
      scan();
      return { ...r, plan };
    } catch (e) {
      send('ipod:state', { path: devPath, state: 'error', message: e.message });
      throw e;
    } finally {
      syncing = false;
    }
  }

  ipcMain.handle('ipod:devices', () => devices);
  ipcMain.handle('ipod:scan', () => scan());
  ipcMain.handle('ipod:library', (_e, p) => backend.call('library', { path: p }));
  ipcMain.handle('ipod:plan', (_e, p, opts) => syncDevice(p, { ...opts, planOnly: true }));
  ipcMain.handle('ipod:sync', (_e, p, opts) => syncDevice(p, opts || {}));
  ipcMain.handle('ipod:cancel', () => backend.call('cancel'));
  ipcMain.handle('ipod:eject', async (_e, p) => {
    if (gameSyncing) throw new Error('게임 동기화가 끝난 뒤 아이팟을 꺼내세요.');
    if (ejecting.has(p)) throw new Error('이미 아이팟을 꺼내고 있습니다.');
    ejecting.add(p);
    try {
      const result = await backend.call('eject', { path: p });
      setTimeout(scan, 1000);
      return result;
    } finally {
      ejecting.delete(p);
    }
  });
  ipcMain.handle('ipod:models', () => backend.call('models'));
  ipcMain.handle('ipod:createVirtual', async (_e, model) => {
    const dir = path.join(app.getPath('userData'), 'VirtualiPods', `${model}-${Date.now().toString(36)}`);
    const info = await backend.call('createVirtual', { path: dir, model });
    saveSettings({ virtualIpods: [...settings.virtualIpods, dir] });
    await scan();
    return info;
  });
  ipcMain.handle('ipod:removeVirtual', async (_e, p) => {
    saveSettings({ virtualIpods: settings.virtualIpods.filter((x) => x !== p) });
    await shell.trashItem(p).catch(() => {});
    return scan();
  });
  ipcMain.handle('backend:status', async () => {
    try {
      return { ok: true, ...(await backend.call('ping')) };
    } catch (e) {
      return { ok: false, error: backend.lastError || e.message };
    }
  });

  const games = new Games(path.join(app.getPath('userData'), 'Clickwheel Games'), (progress) => send('games:progress', progress));
  const connectedGameDevice = (p) => devices.find((device) => device.path === p && gameSupport(device));
  ipcMain.handle('games:info', () => games.info());
  ipcMain.handle('games:download', () => games.prepare());
  ipcMain.handle('games:import', async () => {
    const selected = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'iPod Games Files', extensions: ['7z'] }],
    });
    return selected.canceled || !selected.filePaths[0] ? null : games.prepare(selected.filePaths[0]);
  });
  ipcMain.handle('games:cancel', () => games.cancel());
  ipcMain.handle('games:guide', () => shell.openExternal(GAMES_PROJECT + '#how-to-use'));
  ipcMain.handle('games:release', () => shell.openExternal(GAMES_RELEASE));
  ipcMain.handle('games:utm', () => shell.openExternal('https://mac.getutm.app/'));
  ipcMain.handle('games:device', async (_e, p) => {
    const device = connectedGameDevice(p);
    if (!device) throw new Error('지원되는 실제 아이팟을 연결하세요.');
    return gameDeviceState(device);
  });
  ipcMain.handle('games:sync', async (_e, { path: p, mountKey, ids, authorized } = {}) => {
    if (authorized !== true) throw new Error('iTunes에서 이 아이팟의 게임 인증을 먼저 마쳐 주세요.');
    if (syncing || gameSyncing || ejecting.has(p)) throw new Error('진행 중인 아이팟 작업이 끝난 뒤 다시 시도하세요.');
    gameSyncing = true;
    try {
      await scan();
      const device = connectedGameDevice(p);
      if (!device) throw new Error('지원되는 실제 아이팟을 연결하세요.');
      return await games.sync(device, mountKey, ids);
    } finally {
      gameSyncing = false;
      scan();
    }
  });

  ipcMain.handle('deps', () => checkDeps());
  ipcMain.handle('settings:get', () => ({ ...settings, masterVersion: MASTER_VERSION }));
  ipcMain.handle('settings:set', (_e, patch) => saveSettings(patch));
  ipcMain.handle('settings:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: settings.musicDir,
    });
    if (r.canceled || !r.filePaths[0]) return settings;
    return saveSettings({ musicDir: r.filePaths[0] });
  });

  ipcMain.handle('ytm:search', (_e, q) => ytm.search(q));
  ipcMain.handle('ytm:album', (_e, id) => ytm.getAlbum(id));
  // URL 붙여넣기: 노래/영상 URL 또는 앨범 URL
  ipcMain.handle('ytm:resolve', async (_e, input) => {
    const al = ytm.parseAlbumId(input);
    if (al) {
      const id = al.browseId || (await ytm.albumIdFromPlaylist(al.playlistId));
      if (id) return { kind: 'album', album: await ytm.getAlbum(id) };
    }
    const vid = ytm.parseVideoId(input);
    if (vid) {
      const w = await ytm.getWatchInfo(vid);
      return { kind: 'track', track: { kind: 'track', ...w } };
    }
    return null;
  });

  ipcMain.handle('dl:enqueue', (_e, tracks) => [].concat(tracks).map((t) => dl.enqueue(t)));
  ipcMain.handle('dl:cancel', (_e, id) => dl.cancel(id));
  ipcMain.handle('dl:list', () => dl.list());
  ipcMain.handle('dl:clear', () => dl.clearFinished());

  ipcMain.handle('library:list', () => listLibrary());
  ipcMain.handle('library:cover', (_e, file) => {
    try {
      const t = NodeID3.read(file, { include: ['APIC'] });
      const img = t.image;
      if (!img?.imageBuffer) return null;
      return `data:${img.mime || 'image/jpeg'};base64,${img.imageBuffer.toString('base64')}`;
    } catch (_) {
      return null;
    }
  });
  ipcMain.handle('library:lyrics', (_e, file) => {
    const lrcFile = file.replace(/\.mp3$/i, '.lrc');
    let synced = null;
    if (fs.existsSync(lrcFile)) synced = parseLrc(fs.readFileSync(lrcFile, 'utf8'));
    const t = NodeID3.read(file, { include: ['USLT', 'SYLT'] }) || {};
    if (!synced && t.synchronisedLyrics?.[0]?.synchronisedText?.length) {
      synced = t.synchronisedLyrics[0].synchronisedText.map((l) => ({ t: l.timeStamp / 1000, text: l.text }));
    }
    return { plain: t.unsynchronisedLyrics?.text || '', synced };
  });
  // 가사 없는 곡(또는 지정한 곡)의 가사를 다시 찾는다
  // 예전 방식(48kHz, 피크 초과)으로 받은 곡을 원본에서 아이팟용으로 다시 받아 같은 자리에 덮어쓴다
  // ---------- 아이팟 터치 / Apple Music ----------
  let iosDevices = [];
  const pollIos = async () => {
    try {
      const r = await musicApp.listIosDevices();
      const key = JSON.stringify(r.devices);
      if (key !== JSON.stringify(iosDevices)) {
        iosDevices = r.devices;
        send('ios:devices', iosDevices);
      }
    } catch (_) {}
  };
  setTimeout(pollIos, 1500);
  setInterval(pollIos, 5000);
  ipcMain.handle('ios:devices', () => iosDevices);
  ipcMain.handle('music:add', async (_e, files) => {
    const targets = files?.length ? files : listLibrary().map((t) => t.file);
    return musicApp.addToMusic(targets);
  });
  // ---------- Apple 레전드 광고 ----------
  const videos = new Videos(() => settings.videoDir);
  videos.on('update', (u) => send('videos:update', u));
  videos.on('done', () => send('videos:changed'));
  const ads = new Ads(videos);
  ads.on('update', (u) => send('ads:update', u));
  ads.on('done', () => send('ads:changed'));
  ipcMain.handle('videos:search', (_e, q) => videos.search(q));
  ipcMain.handle('videos:download', (_e, v) => videos.downloadYouTube(v).then(() => true));
  ipcMain.handle('videos:library', () => videos.library());
  ipcMain.handle('videos:remove', async (_e, file) => {
    if (file && file.startsWith(settings.videoDir) && fs.existsSync(file)) await shell.trashItem(file);
    send('videos:changed');
    return true;
  });
  ipcMain.handle('ads:list', () => ads.list());
  ipcMain.handle('ads:download', (_e, id) => ads.download(id).then(() => true));
  ipcMain.handle('ads:remove', async (_e, id) => {
    const ad = ads.list().find((a) => a.id === id);
    if (ad?.file) await shell.trashItem(ad.file);
    send('ads:changed');
    return true;
  });
  ipcMain.handle('ads:reveal', () => {
    const dir = path.join(settings.videoDir, 'Apple 광고');
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  });
  ipcMain.handle('library:remaster', (_e, files) => {
    const targets = listLibrary().filter(
      (t) => t.videoId && (files?.length ? files.includes(t.file) : t.master !== MASTER_VERSION)
    );
    return targets.map((t) =>
      dl.enqueue({
        videoId: t.videoId,
        title: t.title,
        artist: t.artist,
        album: t.album,
        albumArtist: t.albumArtist,
        year: t.year,
        trackNo: t.trackNo,
        trackCount: t.trackCount,
        duration: t.duration,
        replaceFile: t.file,
      })
    );
  });
  // 저화질·테두리 있는 커버를 앨범 아트로 다시 맞춘다
  ipcMain.handle('library:fixCovers', async (_e, files) => {
    const targets = files?.length ? files : listLibrary().map((t) => t.file);
    const results = [];
    for (let i = 0; i < targets.length; i++) {
      send('library:fixProgress', { current: i, total: targets.length, file: targets[i], kind: 'cover' });
      try {
        results.push(await refreshCover(targets[i]));
      } catch (e) {
        results.push({ file: targets[i], fixed: false, error: e.message });
      }
      libCache.delete(targets[i]);
    }
    send('library:fixProgress', { current: targets.length, total: targets.length, done: true });
    send('library:changed');
    return results;
  });
  ipcMain.handle('library:fixLyrics', async (_e, files) => {
    const targets = files?.length ? files : listLibrary().filter((t) => !t.hasLyrics).map((t) => t.file);
    const results = [];
    for (let i = 0; i < targets.length; i++) {
      send('library:fixProgress', { current: i, total: targets.length, file: targets[i] });
      try {
        results.push(await refreshLyrics(targets[i], { writeLrc: settings.writeLrc !== false }));
      } catch (e) {
        results.push({ file: targets[i], found: false, error: e.message });
      }
      libCache.delete(targets[i]);
    }
    send('library:fixProgress', { current: targets.length, total: targets.length, done: true });
    send('library:changed');
    return results;
  });
  ipcMain.handle('library:reveal', (_e, file) => shell.showItemInFolder(file || settings.musicDir));
  ipcMain.handle('library:trash', async (_e, file) => {
    await shell.trashItem(file);
    const lrc = file.replace(/\.mp3$/i, '.lrc');
    if (fs.existsSync(lrc)) await shell.trashItem(lrc);
    libCache.delete(file);
    return true;
  });
  ipcMain.handle('open:external', (_e, url) => {
    if (/^https:\/\/(music\.)?youtube\.com\//.test(url)) shell.openExternal(url);
  });

  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('before-quit', () => backend.stop());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
