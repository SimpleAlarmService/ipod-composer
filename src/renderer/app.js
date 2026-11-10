/* Composer 렌더러 */
const C = window.composer;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtTime = (s) => {
  if (!s || !isFinite(s)) return '';
  s = Math.round(s);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
};
const fmtBytes = (b) => {
  if (!b) return '0 MB';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) (b /= 1024), i++;
  return `${b.toFixed(b >= 100 || i < 2 ? 0 : 1)} ${u[i]}`;
};
const fmtHours = (s) => (s >= 3600 ? `${(s / 3600).toFixed(1)}시간` : `${Math.round(s / 60)}분`);
const norm = (s) => (s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]|[\s\-_.,'"!?·]/g, '');
const PLACEHOLDER =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#d6d6d6'/><stop offset='1' stop-color='#9a9a9a'/></linearGradient></defs><rect width='100' height='100' fill='url(#g)'/><path d='M40 30 70 25v34a7 6 0 1 1-4-5.5V35l-22 4v24a7 6 0 1 1-4-5.5z' fill='#f2f2f2'/></svg>"
  );

const state = {
  view: 'songs',
  library: [],
  jobs: new Map(),
  devices: [],
  device: null, // 선택된 기기 path
  devState: {}, // path → {state, message}
  devLib: {},
  lastPlan: null,
  search: null,
  album: null,
  cfIndex: 0,
  queue: [],
  qi: -1,
  lyrics: null,
  covers: new Map(),
  settings: {},
  selected: null,
};

/* ───────── 공통 ───────── */
let toastTimer;
function toast(msg) {
  let t = $('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = 1;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.style.opacity = 0), 2600);
}

async function coverFor(entry) {
  const key = entry.album ? `${entry.albumArtist}|${entry.album}` : entry.file;
  if (state.covers.has(key)) return state.covers.get(key);
  const p = C.library.cover(entry.file).then((u) => u || PLACEHOLDER);
  state.covers.set(key, p);
  return p;
}

function show(view, opts = {}) {
  state.view = view;
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === 'view-' + view));
  $$('.src, .src-dev').forEach((a) => {
    const on = a.dataset.view === view && !a.classList.contains('ios') && (view !== 'device' || a.dataset.path === state.device);
    a.classList.toggle('on', on || (view === 'album' && a.dataset.view === 'search'));
  });
  if (view === 'songs') renderSongs();
  if (view === 'albums') renderAlbums();
  if (view === 'downloads') renderDownloads();
  if (view === 'device') renderDevice(opts.refresh);
  if (view === 'applemusic') renderAppleMusic();
  if (view === 'ads') loadAds();
  if (view === 'videos') loadVideoLibrary();
  if (view === 'games') loadGames();
  updateStatus();
}

$('#sidebar').addEventListener('click', (e) => {
  const ej = e.target.closest('.eject');
  if (ej) {
    e.stopPropagation();
    return ejectDevice(ej.dataset.path);
  }
  const a = e.target.closest('.src, .src-dev');
  if (!a) return;
  e.preventDefault();
  if (a.dataset.view === 'device') state.device = a.dataset.path;
  show(a.dataset.view, { refresh: true });
  if (a.dataset.view === 'search') $('#searchInput').focus();
});
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]');
  if (g) show(g.dataset.goto);
});

/* ───────── 보관함 ───────── */
async function loadLibrary() {
  state.library = await C.library.list();
  state.library.sort(
    (a, b) =>
      (a.albumArtist || a.artist).localeCompare(b.albumArtist || b.artist, 'ko') ||
      a.album.localeCompare(b.album, 'ko') ||
      a.trackNo - b.trackNo ||
      a.title.localeCompare(b.title, 'ko')
  );
  $('#cntSongs').textContent = state.library.length || '';
  const missing = state.library.filter((t) => !t.hasLyrics && !/\binst\b|\(inst\)/i.test(t.title)).length;
  $('#btnFixLyrics').hidden = !missing;
  const lowCovers = state.library.filter((t) => t.coverWidth && t.coverWidth < 600).length;
  $('#btnFixCovers').hidden = !lowCovers;
  $('#cntBadCovers').textContent = lowCovers;
  const old = state.library.filter((t) => t.videoId && t.master !== state.masterVersion).length;
  $('#btnRemaster').hidden = !old;
  $('#cntRemaster').textContent = old;
  $('#cntNoLyrics').textContent = missing;
  if (state.view === 'songs') renderSongs();
  if (state.view === 'albums') renderAlbums();
  if (state.view === 'search') renderSearch();
  if (state.view === 'album') renderAlbum();
  updateStatus();
}

function renderSongs() {
  const tb = $('#songsTable tbody');
  const cur = state.queue[state.qi]?.file;
  tb.innerHTML = state.library
    .map(
      (t, i) => `<tr data-i="${i}" class="${t.file === cur ? 'playing-row' : ''}${t.file === state.selected ? ' sel' : ''}">
      <td class="c-st"></td><td>${h(t.title)}</td><td class="c-time">${fmtTime(t.duration)}</td>
      <td>${h(t.artist)}</td><td>${h(t.album)}</td><td class="c-ly">${t.hasLyrics ? '♪' : ''}</td></tr>`
    )
    .join('');
  $('#songsEmpty').hidden = state.library.length > 0;
}
$('#songsTable tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  $$('#songsTable tr.sel').forEach((r) => r.classList.remove('sel'));
  tr.classList.add('sel');
  state.selected = state.library[tr.dataset.i].file;
});
$('#songsTable tbody').addEventListener('dblclick', (e) => {
  const tr = e.target.closest('tr');
  if (tr) playList(state.library, Number(tr.dataset.i));
});
document.addEventListener('keydown', async (e) => {
  if (e.target.matches('input, select, #view-games button') || e.target.closest('#gamesAuthGuide')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  }
  if (state.view === 'songs' && (e.key === 'Backspace' || e.key === 'Delete') && state.selected) {
    const t = state.library.find((x) => x.file === state.selected);
    if (t && confirm(`'${t.title}'을(를) 휴지통으로 옮길까요?`)) {
      await C.library.trash(t.file);
      state.selected = null;
      loadLibrary();
    }
  }
});

function albumsOf(list) {
  const map = new Map();
  for (const t of list) {
    const k = (t.albumArtist || t.artist) + '|' + (t.album || '싱글');
    if (!map.has(k)) map.set(k, { key: k, album: t.album || '싱글', artist: t.albumArtist || t.artist, tracks: [] });
    map.get(k).tracks.push(t);
  }
  return [...map.values()];
}

function renderAlbums() {
  const albums = albumsOf(state.library);
  const grid = $('#albumGrid');
  grid.innerHTML = albums
    .map(
      (a, i) => `<div class="alb" data-i="${i}"><div class="art"><img data-cover="${i}" src="${PLACEHOLDER}" alt=""/></div>
      <b>${h(a.album)}</b><span>${h(a.artist)}</span></div>`
    )
    .join('');
  albums.forEach(async (a, i) => {
    const url = await coverFor(a.tracks[0]);
    const img = grid.querySelector(`[data-cover="${i}"]`);
    if (img) img.src = url;
  });
  grid.onclick = (e) => {
    const el = e.target.closest('.alb');
    if (el) playList(albums[el.dataset.i].tracks, 0);
  };
}

/* ───────── 다운로드 ───────── */
const STATE_LABEL = {
  queued: '대기 중',
  meta: '메타데이터 확인 중…',
  downloading: '받는 중',
  converting: 'MP3로 변환 중…',
  tagging: '커버·가사 붙이는 중…',
  done: '완료',
  error: '실패',
  canceled: '취소됨',
};
const activeJobs = () => [...state.jobs.values()].filter((j) => !['done', 'error', 'canceled'].includes(j.state));

function renderDownloads() {
  const jobs = [...state.jobs.values()].reverse();
  $('#dlEmpty').hidden = jobs.length > 0;
  $('#dlList').innerHTML = jobs
    .map((j) => {
      const m = j.meta;
      const cls = j.state === 'done' ? 'done' : j.state === 'error' || j.state === 'canceled' ? 'err' : '';
      let st = STATE_LABEL[j.state] || j.state;
      if (j.state === 'downloading') st += ` ${Math.round(j.progress * 100)}% · ${j.speed || ''} ${j.eta ? '· 남은 시간 ' + j.eta : ''}`;
      if (j.state === 'done' && j.result) st = `완료 · 커버 ${j.result.cover ? '✓' : '✕'} · 가사: ${j.result.lyrics}${j.result.lyricsSource ? ' (' + j.result.lyricsSource + ')' : ''}`;
      if (j.state === 'error') st = '실패: ' + (j.error || '');
      const pct = ['done'].includes(j.state) ? 100 : ['converting', 'tagging'].includes(j.state) ? 100 : Math.round((j.progress || 0) * 100);
      return `<li data-id="${j.id}">
        <img src="${h(m.thumb || PLACEHOLDER)}" alt=""/>
        <div class="meta"><b>${h(m.title || m.videoId)}</b><span>${h([m.artist, m.album].filter(Boolean).join(' — '))}</span></div>
        <div class="prog"><div class="aqua-bar ${cls}"><i style="width:${pct}%"></i></div>
          <div class="st ${j.state === 'error' ? 'err' : j.state === 'done' ? 'ok' : ''}" title="${h(st)}">${h(st)}</div></div>
        ${cls ? '<span style="width:16px"></span>' : '<button class="x-btn" title="취소">✕</button>'}
      </li>`;
    })
    .join('');
}
$('#dlList').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li && e.target.closest('.x-btn')) C.dl.cancel(li.dataset.id);
});
$('#btnClearDl').onclick = () => C.dl.clear();
C.dl.onCleared(async () => {
  state.jobs = new Map((await C.dl.list()).map((j) => [j.id, j]));
  renderDownloads();
  updateBadge();
});

function updateBadge() {
  const n = activeJobs().length;
  const b = $('#cntDl');
  b.hidden = !n;
  b.textContent = n;
}

let renderDlTimer;
C.dl.onUpdate((job) => {
  state.jobs.set(job.id, job);
  updateBadge();
  if (state.view === 'downloads') {
    clearTimeout(renderDlTimer);
    renderDlTimer = setTimeout(renderDownloads, 60);
  }
  if (job.state === 'done') toast(`받기 완료: ${job.meta.title}`);
  if (job.state === 'error') toast(`실패: ${job.meta.title || job.meta.videoId}`);
  if (['search', 'album'].includes(state.view)) refreshBuyButtons();
  updateLcd();
});
C.library.onChanged(() => loadLibrary());

async function enqueue(tracks) {
  await C.dl.enqueue(tracks);
  updateBadge();
  toast(tracks.length > 1 ? `${tracks.length}곡을 대기열에 추가했습니다` : `대기열에 추가: ${tracks[0].title}`);
}

/* ───────── 검색 / 스토어 ───────── */
// 실제 YouTube 주소만 링크로 본다 (예전에는 'BOYNEXTDOOR'처럼 11글자 이름을 영상 ID로 오인했다)
const isUrl = (s) => /(^|\/\/|\.)(music\.)?youtube\.com\/|youtu\.be\//i.test(s.trim());

$('#searchInput').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim();
  if (!q) return;
  if (state.searchMode === 'video' && !isUrl(q)) return searchVideos(q);
  show('search');
  $('#searchSpin').hidden = false;
  $('#results').innerHTML = '';
  $('#coverflow').hidden = true;
  try {
    if (isUrl(q)) {
      const r = await C.ytm.resolve(q);
      if (!r) throw new Error('인식할 수 없는 링크입니다');
      if (r.kind === 'album') {
        state.album = r.album;
        show('album');
        renderAlbum();
        return;
      }
      state.search = { query: q, albums: [], tracks: [r.track], videos: [] };
      $('#searchTitle').textContent = '링크';
      $('#searchSub').textContent = r.track.title;
    } else {
      state.search = { query: q, ...(await C.ytm.search(q)) };
      $('#searchTitle').textContent = `“${q}” 검색 결과`;
      $('#searchSub').textContent = [
        state.search.artist && `대표 아티스트 ${state.search.artist.name}`,
        `앨범 ${state.search.albums.length}개`,
        `노래 ${state.search.tracks.length}곡`,
      ].filter(Boolean).join(' · ');
    }
    state.cfIndex = 0;
    renderSearch();
  } catch (err) {
    const msg = /abort|timeout|fetch failed|network/i.test(err.message) ? '스토어에 연결하지 못했습니다' : err.message;
    $('#results').innerHTML = `<div class="paste-hint">검색 실패: ${h(msg)} <button class="pill" id="retrySearch" style="margin-left:8px">다시 시도</button></div>`;
    $('#retrySearch').onclick = () => $('#searchInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  } finally {
    $('#searchSpin').hidden = true;
  }
});

function inLibrary(t) {
  return state.library.some(
    (x) => norm(x.title) === norm(t.title) && (!t.album || norm(x.album) === norm(t.album))
  );
}
function jobFor(videoId) {
  let last = null;
  for (const j of state.jobs.values()) if (j.meta.videoId === videoId) last = j;
  return last;
}
function buyButton(t) {
  if (inLibrary(t)) return `<button class="buy ok" disabled>보관함</button>`;
  const j = jobFor(t.videoId);
  if (j && !['error', 'canceled', 'done'].includes(j.state)) {
    return `<span class="mini-bar"><i style="width:${Math.round((j.progress || 0) * 100)}%"></i></span>`;
  }
  return `<button class="buy" data-vid="${h(t.videoId)}">받기</button>`;
}

function trackRows(list, { art = true, no = false } = {}) {
  return list
    .map(
      (t, i) => `<tr data-i="${i}">
      ${art ? `<td class="c-art"><img src="${h(t.thumb || PLACEHOLDER)}" alt=""/></td>` : ''}
      ${no ? `<td class="c-no">${t.trackNo || i + 1}</td>` : ''}
      <td>${h(t.title)}</td><td>${h(t.artist)}</td>${art ? `<td>${h(t.album || '')}</td>` : ''}
      <td class="c-time">${fmtTime(t.duration)}</td><td class="c-buy" data-buy="${h(t.videoId)}">${buyButton(t)}</td></tr>`
    )
    .join('');
}

function renderSearch() {
  const s = state.search;
  if (!s) {
    $('#results').innerHTML = `<div class="paste-hint">검색창에 아티스트·앨범·곡 이름을 입력하거나 노래·앨범 링크를 붙여넣고 Return 키를 누르세요.</div>`;
    return;
  }
  const cf = $('#coverflow');
  cf.hidden = !s.albums.length;
  if (s.albums.length) renderCoverflow();
  let html = '';
  if (s.tracks.length) {
    html += `<div class="res-head"><h2>노래</h2><span>앨범 트랙 기준 · 커버와 트랙 번호가 정확합니다</span></div>
      <table class="grid" id="resTracks"><thead><tr><th style="width:34px"></th><th class="c-name">이름</th><th>아티스트</th><th>앨범</th><th class="c-time">시간</th><th class="c-buy"></th></tr></thead>
      <tbody>${trackRows(s.tracks)}</tbody></table>`;
  }
  if (s.videos.length) {
    html += `<div class="res-head"><h2>동영상</h2><span>앨범 정보는 받을 때 자동으로 찾아 붙입니다</span></div>
      <table class="grid" id="resVideos"><thead><tr><th style="width:34px"></th><th class="c-name">이름</th><th>채널</th><th></th><th class="c-time">시간</th><th class="c-buy"></th></tr></thead>
      <tbody>${trackRows(s.videos)}</tbody></table>`;
  }
  if (!html && !s.albums.length) html = `<div class="paste-hint">결과가 없습니다. 다른 검색어나 링크를 시도해 보세요.</div>`;
  $('#results').innerHTML = html;
}

$('#results').addEventListener('click', (e) => {
  const b = e.target.closest('.buy[data-vid]');
  if (!b) return;
  const list = [...(state.search?.tracks || []), ...(state.search?.videos || [])];
  const t = list.find((x) => x.videoId === b.dataset.vid);
  if (t) enqueue([t]);
});

function refreshBuyButtons() {
  const all = [...(state.search?.tracks || []), ...(state.search?.videos || []), ...(state.album?.tracks || [])];
  $$('[data-buy]').forEach((td) => {
    const t = all.find((x) => x.videoId === td.dataset.buy);
    if (t) td.innerHTML = buyButton(t);
  });
}

/* 커버 플로우 */
function renderCoverflow() {
  const albums = state.search.albums;
  const stage = $('#cfStage');
  if (stage.childElementCount !== albums.length || stage.dataset.q !== state.search.query) {
    stage.dataset.q = state.search.query;
    stage.innerHTML = albums
      .map((a, i) => `<div class="cf-item" data-i="${i}"><img src="${h(a.thumb || PLACEHOLDER)}" alt=""/></div>`)
      .join('');
    const sc = $('#cfScroll');
    sc.max = Math.max(0, albums.length - 1);
  }
  layoutCoverflow();
}
function layoutCoverflow() {
  const albums = state.search?.albums || [];
  const c = state.cfIndex;
  $$('.cf-item').forEach((el, i) => {
    const d = i - c;
    let tf;
    if (d === 0) tf = 'translateX(0) translateZ(60px) rotateY(0)';
    else {
      const sign = Math.sign(d);
      tf = `translateX(${sign * 150 + d * 46}px) translateZ(-70px) rotateY(${-sign * 62}deg)`;
    }
    el.style.transform = tf;
    el.style.zIndex = 100 - Math.abs(d);
    el.classList.toggle('side', d !== 0);
    el.style.visibility = Math.abs(d) > 9 ? 'hidden' : 'visible';
  });
  const a = albums[c];
  if (a) {
    $('#cfTitle').textContent = a.title;
    $('#cfSub').textContent = [a.artist, a.type, a.year].filter(Boolean).join(' · ');
  }
  $('#cfScroll').value = c;
}
$('#cfStage').addEventListener('click', (e) => {
  const it = e.target.closest('.cf-item');
  if (!it) return;
  const i = Number(it.dataset.i);
  if (i === state.cfIndex) openAlbum(state.search.albums[i].browseId);
  else {
    state.cfIndex = i;
    layoutCoverflow();
  }
});
$('#cfScroll').addEventListener('input', (e) => {
  state.cfIndex = Number(e.target.value);
  layoutCoverflow();
});
let wheelAcc = 0;
$('#coverflow').addEventListener('wheel', (e) => {
  e.preventDefault();
  wheelAcc += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (Math.abs(wheelAcc) < 40) return;
  const n = state.search.albums.length;
  state.cfIndex = Math.min(n - 1, Math.max(0, state.cfIndex + Math.sign(wheelAcc)));
  wheelAcc = 0;
  layoutCoverflow();
}, { passive: false });
document.addEventListener('keydown', (e) => {
  if (state.view !== 'search' || !state.search?.albums.length || e.target.matches('input')) return;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    state.cfIndex = Math.min(state.search.albums.length - 1, Math.max(0, state.cfIndex + (e.key === 'ArrowLeft' ? -1 : 1)));
    layoutCoverflow();
  }
  if (e.key === 'Enter') openAlbum(state.search.albums[state.cfIndex].browseId);
});

/* 앨범 상세 */
async function openAlbum(browseId) {
  show('album');
  $('#albumTitle').textContent = '불러오는 중…';
  $('#albumArtist').textContent = '';
  $('#albumMeta').textContent = '';
  $('#albumArt').src = PLACEHOLDER;
  $('#albumTracks tbody').innerHTML = '';
  try {
    state.album = await C.ytm.album(browseId);
    renderAlbum();
  } catch (e) {
    $('#albumTitle').textContent = '앨범을 불러오지 못했습니다';
    $('#albumMeta').textContent = e.message;
  }
}
function renderAlbum() {
  const a = state.album;
  if (!a) return;
  $('#albumTitle').textContent = a.title;
  $('#albumArtist').textContent = a.artist;
  const total = a.tracks.reduce((s, t) => s + (t.duration || 0), 0);
  $('#albumMeta').textContent = [a.type, a.year, `${a.tracks.length}곡`, fmtHours(total)].filter(Boolean).join(' · ');
  $('#albumArt').src = a.cover || a.thumb || PLACEHOLDER;
  $('#albumTracks tbody').innerHTML = trackRows(a.tracks, { art: false, no: true });
}
$('#albumTracks').addEventListener('click', (e) => {
  const b = e.target.closest('.buy[data-vid]');
  if (!b) return;
  const t = state.album.tracks.find((x) => x.videoId === b.dataset.vid);
  if (t) enqueue([t]);
});
$('#albumGetAll').onclick = () => {
  const list = state.album?.tracks.filter((t) => !inLibrary(t) && !activeJobs().some((j) => j.meta.videoId === t.videoId)) || [];
  if (!list.length) return toast('이미 모두 보관함에 있습니다');
  enqueue(list);
};
$('#albumBack').onclick = () => show('search');

/* ───────── 아이팟 ───────── */
function renderDeviceList() {
  const box = $('#deviceList');
  if (!state.devices.length) {
    box.innerHTML = '<div class="src-none">연결된 아이팟 없음</div>';
    return;
  }
  box.innerHTML = state.devices
    .map((d) => {
      const st = state.devState[d.path]?.state;
      const busy = st === 'planning' || st === 'syncing';
      return `<a class="src-dev" data-view="device" data-path="${h(d.path)}" title="${h(d.displayName)}">
        <i class="ico ico-ipod"></i><span style="flex:1;overflow:hidden;text-overflow:ellipsis">${h(d.name)}</span>
        ${busy ? '<i class="spin-mini"></i>' : d.virtual ? '' : `<button class="eject" data-path="${h(d.path)}" title="꺼내기"><svg viewBox="0 0 12 12"><path d="M6 1.5 11 7H1zM1 8.5h10V10.5H1z"/></svg></button>`}
      </a>`;
    })
    .join('');
  $$('.src-dev', box).forEach((a) => a.classList.toggle('on', state.view === 'device' && a.dataset.path === state.device));
}

C.ipod.onDevices((list) => {
  const before = new Set(state.devices.map((d) => d.path));
  state.devices = list;
  renderDeviceList();
  const added = list.find((d) => !before.has(d.path));
  if (added && before.size === 0 && state.initialized) toast(`${added.name} 연결됨`);
  if (state.view === 'device') {
    if (!list.some((d) => d.path === state.device)) show('songs');
    else renderDevice(false);
  }
  if (state.view === 'games') refreshGameDevice();
});
C.ipod.onError((m) => console.warn('ipod', m));

const currentDevice = () => state.devices.find((d) => d.path === state.device);

async function renderDevice(refresh) {
  const d = currentDevice();
  if (!d) return;
  $('#devName').textContent = d.name;
  $('#devModel').textContent = `${d.family} ${d.generation} ${d.color ? '(' + d.color + ')' : ''} · ${d.model}${d.virtual ? ' · 가상 기기' : ''}`;
  $('#devCap').textContent = `${d.capacity || fmtBytes(d.totalBytes)} (여유 ${fmtBytes(d.freeBytes)})`;
  $('#devSerial').textContent = d.serial || '—';
  $('#devHash').textContent = d.checksum === '없음' ? '필요 없음 (구형 기기)' : d.checksum;
  $('#devTracks').textContent = d.needsInit ? '0곡 · 초기화된 기기 (첫 동기화 때 새 데이터베이스를 만듭니다)' : `${d.trackCount}곡`;
  $('#devRemoveVirtual').hidden = !d.virtual;
  $('#devEject').hidden = d.virtual;
  const r = $('#devRender');
  r.classList.toggle('black', /black|space|slate/i.test(d.color || ''));
  r.classList.toggle('nano', /nano/i.test(d.family));
  $$('input[name=syncMode]').forEach((i) => (i.checked = i.value === (state.settings.syncMode || 'add')));
  $('#optAutoSync').checked = !!state.settings.autoSync;
  const ds = state.devState[d.path] || {};
  const busy = ds.state === 'planning' || ds.state === 'syncing';
  $('#devSync').disabled = busy;
  $('#devPreview').disabled = busy;
  $('#devSync').textContent = busy ? (ds.state === 'planning' ? '확인 중…' : '동기화 중…') : '동기화';
  updateCapacity();
  if (refresh || !state.devLib[d.path]) {
    try {
      state.devLib[d.path] = await C.ipod.library(d.path);
    } catch (e) {
      state.devLib[d.path] = [];
    }
    if (!$('#devMusic').hidden) renderDevMusic();
    updateCapacity();
  }
  updateStatus();
}

function updateCapacity() {
  const d = currentDevice();
  if (!d || !d.totalBytes) return;
  const tracks = state.devLib[d.path] || [];
  const music = tracks.reduce((s, t) => s + (t.size || 0), 0);
  const used = d.totalBytes - d.freeBytes;
  const other = Math.max(0, used - music);
  const plan = state.lastPlan?.path === d.path ? state.lastPlan.plan : null;
  const add = plan ? Math.max(0, plan.bytesToAdd - plan.bytesToRemove) : 0;
  const pct = (b) => `${Math.min(100, (b / d.totalBytes) * 100)}%`;
  $('#capMusic').style.width = pct(music);
  $('#capAdd').style.width = pct(add);
  $('#capOther').style.width = pct(other);
  $('#capMusicT').textContent = fmtBytes(music);
  $('#capAddT').textContent = fmtBytes(add);
  $('#capOtherT').textContent = fmtBytes(other);
  $('#capFreeT').textContent = fmtBytes(Math.max(0, d.freeBytes - add));
}

function renderDevMusic() {
  const d = currentDevice();
  const tracks = (state.devLib[d?.path] || []).slice().sort((a, b) =>
    (a.albumArtist || a.artist).localeCompare(b.albumArtist || b.artist, 'ko') || a.album.localeCompare(b.album, 'ko')
  );
  $('#devTable tbody').innerHTML = tracks.length
    ? tracks
        .map(
          (t) => `<tr><td>${h(t.title)}</td><td class="c-time">${fmtTime(t.duration)}</td><td>${h(t.artist)}</td><td>${h(t.album)}</td>
          <td class="c-ly">${t.hasArtwork ? '■' : '<span class="dim">—</span>'}</td><td class="c-ly">${t.hasLyrics ? '♪' : '<span class="dim">—</span>'}</td></tr>`
        )
        .join('')
    : `<tr><td colspan="6" class="dim" style="text-align:center;padding:20px">아이팟에 곡이 없습니다</td></tr>`;
}

$('#devTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  $$('#devTabs button').forEach((x) => x.classList.toggle('on', x === b));
  $('#devSummary').hidden = b.dataset.tab !== 'summary';
  $('#devMusic').hidden = b.dataset.tab !== 'music';
  if (b.dataset.tab === 'music') renderDevMusic();
});
$$('input[name=syncMode]').forEach((i) =>
  i.addEventListener('change', async () => {
    if (i.value === 'mirror' && !confirm('보관함에 없는 곡은 아이팟에서 삭제됩니다. 계속할까요?')) {
      $$('input[name=syncMode]').forEach((x) => (x.checked = x.value === 'add'));
      return;
    }
    state.settings = await C.settings.set({ syncMode: i.value });
    state.lastPlan = null;
    $('#planBox').hidden = true;
  })
);
$('#optAutoSync').addEventListener('change', async (e) => {
  state.settings = await C.settings.set({ autoSync: e.target.checked });
});

function renderPlan(plan) {
  const box = $('#planBox');
  box.hidden = false;
  const parts = [
    `<span>추가 <b>${plan.add.length}</b>곡</span>`,
    `<span>정보 갱신 <b>${plan.updateMetadata.length + plan.updateArtwork.length + plan.updateFile.length}</b>곡</span>`,
    plan.mode === 'mirror'
      ? `<span class="warn">삭제 <b>${plan.remove.length}</b>곡</span>`
      : `<span>아이팟에만 있는 곡 <b>${plan.keptOnIpod}</b>곡 유지</span>` +
        (plan.replaced ? `<span>새 버전으로 교체 <b>${plan.replaced}</b>곡</span>` : ''),
    `<span>필요 공간 <b>${fmtBytes(plan.bytesToAdd)}</b></span>`,
  ];
  if (plan.duplicates) parts.push(`<span>중복 <b>${plan.duplicates}</b>곡 건너뜀</span>`);
  if (!plan.hasChanges) parts.unshift('<span><b>이미 최신 상태입니다</b></span>');
  $('#planSummary').innerHTML = parts.join('');
  const li = (cls, mark, t) => `<li class="${cls}"><i>${mark}</i><span>${h(t.title)}</span><span class="dim">${h(t.artist)}</span><em>${fmtBytes(t.size)}</em></li>`;
  $('#planList').innerHTML = [
    ...plan.add.map((t) => li('add', '+', t)),
    ...plan.updateMetadata.map((t) => li('upd', '↻', t)),
    ...plan.updateArtwork.map((t) => li('upd', '▣', t)),
    ...plan.remove.map((t) => (plan.mode === 'mirror' ? li('rem', '−', t) : li('upd', '⇄', t))),
  ].join('');
  $('#planList').hidden = !$('#planList').childElementCount;
}

$('#devPreview').onclick = async () => {
  const d = currentDevice();
  if (!d) return;
  try {
    const plan = await C.ipod.plan(d.path);
    state.lastPlan = { path: d.path, plan };
    renderPlan(plan);
    updateCapacity();
  } catch (e) {
    toast('미리 보기 실패: ' + e.message);
  }
};
$('#devSync').onclick = async () => {
  const d = currentDevice();
  if (!d) return;
  try {
    const r = await C.ipod.sync(d.path);
    if (r.nothing) toast('아이팟이 이미 최신 상태입니다');
    else if (r.ok) toast(`동기화 완료 · ${r.added ?? 0}곡 추가${r.updated ? `, ${r.updated}곡 갱신` : ''}${r.removed ? `, ${r.removed}곡 삭제` : ''}`);
    else toast('동기화 오류: ' + (r.errors || []).join(', '));
    if (r.plan) renderPlan({ ...r.plan, hasChanges: false, bytesToAdd: 0, bytesToRemove: 0, add: [], updateMetadata: [], updateArtwork: [], updateFile: [], remove: [] });
    state.lastPlan = null;
    renderDevice(true);
  } catch (e) {
    toast('동기화 실패: ' + e.message);
  }
};
async function ejectDevice(p) {
  const d = state.devices.find((x) => x.path === p);
  if (!d) return;
  if (d.virtual) return toast('가상 아이팟은 꺼낼 필요가 없습니다');
  const r = await C.ipod.eject(p).catch((e) => ({ ok: false, message: e.message }));
  toast(r.ok ? `${d.name}을(를) 꺼냈습니다. 이제 분리해도 됩니다.` : '꺼내기 실패: ' + r.message);
}
$('#devEject').onclick = () => ejectDevice(state.device);
$('#devRemoveVirtual').onclick = async () => {
  const d = currentDevice();
  if (d && confirm(`가상 기기 '${d.displayName}'을(를) 휴지통으로 옮길까요?`)) {
    await C.ipod.removeVirtual(d.path);
    show('songs');
  }
};

// 동기화 진행 → LCD
let syncInfo = null;
C.ipod.onState((s) => {
  state.devState[s.path] = s;
  if (s.state === 'syncing') syncInfo = { message: '동기화 준비 중…', pct: 0, name: state.devices.find((d) => d.path === s.path)?.name };
  if (s.state === 'planning') syncInfo = { message: '변경 사항 확인 중…', pct: 0, name: state.devices.find((d) => d.path === s.path)?.name };
  if (s.state === 'idle' || s.state === 'error') {
    syncInfo = null;
    if (s.state === 'error') toast('동기화 오류: ' + s.message);
  }
  renderDeviceList();
  if (state.view === 'device' && s.path === state.device) renderDevice(s.state === 'idle');
  updateLcd();
});
C.ipod.onProgress((p) => {
  if (!syncInfo) return;
  syncInfo.message = translateStage(p.message);
  syncInfo.pct = p.total ? p.current / p.total : syncInfo.pct;
  updateLcd();
});
function translateStage(m) {
  return m
    .replace(/^Scanning media folders/, '보관함 살펴보는 중')
    .replace(/^Resolving track identities/, '곡 식별 중')
    .replace(/^Fingerprinting/i, '음향 지문 계산 중')
    .replace(/^Adding new tracks\.*/, '새 곡 복사 중…')
    .replace(/^Copying/i, '복사 중')
    .replace(/^Writing lyrics: /, '가사 쓰는 중: ')
    .replace(/^Artwork — /, '앨범 커버: ')
    .replace(/converting (\d+) images?/, '$1개 변환')
    .replace(/writing (\d+) changed\/new images?/, '$1개 쓰는 중')
    .replace(/^Signing database/, '데이터베이스 서명 중')
    .replace(/^Writing to iPod/, '아이팟에 쓰는 중')
    .replace(/^Database written — (\d+) tracks/, '데이터베이스 기록 완료 · $1곡')
    .replace(/^Building database structure/, '데이터베이스 구성 중')
    .replace(/^Preparing tracks/, '곡 준비 중')
    .replace(/^Preparing embedded lyrics/, '가사 준비 중');
}

/* ───────── 플레이어 ───────── */
const audio = $('#audio');
audio.volume = 0.8;

function playList(list, i) {
  state.queue = list.slice();
  state.qi = i;
  loadTrack();
}
async function loadTrack() {
  const t = state.queue[state.qi];
  if (!t) return;
  audio.src = C.fileUrl(t.file);
  audio.play().catch(() => {});
  const cover = await coverFor(t);
  $('#lcdArt').src = cover;
  $('#scrArt').src = cover;
  $('#lcdTitle').textContent = t.title;
  $('#lcdSub').textContent = [t.artist, t.album].filter(Boolean).join(' — ');
  $('#scrTitle').textContent = t.title;
  $('#scrArtist').textContent = t.artist;
  $('#scrAlbum').textContent = t.album;
  state.lyrics = await C.library.lyrics(t.file).catch(() => null);
  renderLyrics();
  if (state.view === 'songs') renderSongs();
  updateLcd();
}
function togglePlay() {
  if (!audio.src) {
    if (state.library.length) playList(state.library, 0);
    return;
  }
  audio.paused ? audio.play() : audio.pause();
}
function step(d) {
  if (!state.queue.length) return;
  if (d < 0 && audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  state.qi = (state.qi + d + state.queue.length) % state.queue.length;
  loadTrack();
}
audio.addEventListener('play', () => document.body.classList.add('playing'));
audio.addEventListener('pause', () => document.body.classList.remove('playing'));
audio.addEventListener('ended', () => step(1));
audio.addEventListener('timeupdate', () => {
  const p = audio.duration ? audio.currentTime / audio.duration : 0;
  $('#lcdFill').style.width = p * 100 + '%';
  $('#lcdKnob').style.left = p * 100 + '%';
  $('#scrFill').style.width = p * 100 + '%';
  $('#lcdElapsed').textContent = $('#scrEl').textContent = fmtTime(audio.currentTime) || '0:00';
  $('#lcdRemain').textContent = $('#scrRe').textContent = '-' + (fmtTime(audio.duration - audio.currentTime) || '0:00');
  syncLyrics();
});
$('#lcdBar').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  if (audio.duration) audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
});
$('#btnPlay').onclick = togglePlay;
$('#btnPrev').onclick = () => step(-1);
$('#btnNext').onclick = () => step(1);
$('#volume').oninput = (e) => (audio.volume = Number(e.target.value));

// 가사
function renderLyrics() {
  const box = $('#lyScroll');
  const l = state.lyrics;
  if (l?.synced?.length) {
    box.innerHTML = l.synced.map((x, i) => `<p data-i="${i}">${h(x.text) || '♪'}</p>`).join('');
  } else if (l?.plain) {
    box.innerHTML = `<div class="plain">${h(l.plain)}</div>`;
  } else {
    box.innerHTML = '<p>가사 없음</p>';
  }
  box.style.transform = 'translateY(0)';
  box.dataset.cur = '-1';
}
function syncLyrics() {
  const l = state.lyrics;
  if (!l?.synced?.length || $('#scrLyrics').hidden) return;
  const t = audio.currentTime + 0.25;
  let i = -1;
  for (let k = 0; k < l.synced.length; k++) if (l.synced[k].t <= t) i = k;
  const box = $('#lyScroll');
  if (String(i) === box.dataset.cur) return;
  box.dataset.cur = i;
  $$('p', box).forEach((p) => p.classList.toggle('cur', Number(p.dataset.i) === i));
  const cur = box.querySelector(`p[data-i="${Math.max(0, i)}"]`);
  if (cur) box.style.transform = `translateY(${-(cur.offsetTop - 70)}px)`;
}
function toggleScreen() {
  const ly = $('#scrLyrics');
  ly.hidden = !ly.hidden;
  $('#scrNow').hidden = !ly.hidden;
  $('#scrMode').textContent = ly.hidden ? '지금 재생 중' : '가사';
  $('#lyScroll').dataset.cur = '-1';
  syncLyrics();
}
$('#wMenu').onclick = toggleScreen;
$('#wCenter').onclick = toggleScreen;
$('#wPlay').onclick = togglePlay;
$('#wNext').onclick = () => step(1);
$('#wPrev').onclick = () => step(-1);

// 클릭 휠 회전 → 볼륨
(() => {
  const wheel = $('#wheel');
  let last = null;
  const angle = (e) => {
    const r = wheel.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
  };
  wheel.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    last = angle(e);
    wheel.setPointerCapture(e.pointerId);
  });
  wheel.addEventListener('pointermove', (e) => {
    if (last == null) return;
    const a = angle(e);
    let d = a - last;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    last = a;
    audio.volume = Math.min(1, Math.max(0, audio.volume + d / (Math.PI * 2)));
    $('#volume').value = audio.volume;
    $('#scrMode').textContent = `볼륨 ${Math.round(audio.volume * 100)}`;
    clearTimeout(wheel._t);
    wheel._t = setTimeout(() => ($('#scrMode').textContent = $('#scrLyrics').hidden ? '지금 재생 중' : '가사'), 900);
  });
  wheel.addEventListener('pointerup', () => (last = null));
})();

/* ───────── LCD ───────── */
function updateLcd() {
  const playing = !!audio.src && state.queue[state.qi];
  const jobs = activeJobs();
  const dl = $('#lcdDl');
  if (syncInfo) {
    $('#lcdIdle').hidden = true;
    $('#lcdNow').hidden = true;
    dl.hidden = false;
    dl.innerHTML = `<div class="t">“${h(syncInfo.name || '아이팟')}” 동기화 중</div><div style="font-size:11px">${h(syncInfo.message)}</div><div class="bar"><i style="width:${Math.round(syncInfo.pct * 100)}%"></i></div>`;
    return;
  }
  if (playing) {
    $('#lcdIdle').hidden = true;
    dl.hidden = true;
    $('#lcdNow').hidden = false;
    return;
  }
  $('#lcdNow').hidden = true;
  if (jobs.length) {
    const j = jobs.find((x) => x.state !== 'queued') || jobs[0];
    $('#lcdIdle').hidden = true;
    dl.hidden = false;
    dl.innerHTML = `<div class="t">${h(j.meta.title || '받는 중')}</div><div style="font-size:11px">${h(STATE_LABEL[j.state])}${jobs.length > 1 ? ` · 남은 항목 ${jobs.length - 1}개` : ''}</div><div class="bar"><i style="width:${Math.round((j.progress || 0) * 100)}%"></i></div>`;
  } else {
    dl.hidden = true;
    $('#lcdIdle').hidden = false;
  }
}

/* ───────── 상태 막대 ───────── */
function updateStatus() {
  const el = $('#sbInfo');
  let list = [];
  if (state.view === 'songs' || state.view === 'albums') list = state.library;
  else if (state.view === 'device') list = state.devLib[state.device] || [];
  else if (state.view === 'album') list = state.album?.tracks || [];
  else if (state.view === 'downloads') {
    el.textContent = `진행 중 ${activeJobs().length}개 · 전체 ${state.jobs.size}개`;
    return;
  }
  if (!list.length) {
    el.textContent = '';
    return;
  }
  const dur = list.reduce((s, t) => s + (t.duration || 0), 0);
  const size = list.reduce((s, t) => s + (t.size || 0), 0);
  el.textContent = `${list.length}곡 · ${fmtHours(dur)}${size ? ' · ' + fmtBytes(size) : ''}`;
}

/* ───────── 설정 ───────── */
async function openSettings() {
  const s = (state.settings = await C.settings.get());
  $('#setDir').textContent = s.musicDir;
  $('#setQuality').value = s.quality;
  $('#setConc').value = String(s.concurrency);
  $('#setLrc').checked = s.writeLrc !== false;
  $('#setAuto').checked = !!s.autoSync;
  $('#setToolCheck').checked = s.toolAutoCheck !== false;
  $('#setToolInstall').checked = !!s.toolAutoInstall;
  $('#sheetBack').hidden = false;
  const sel = $('#setModel');
  if (!sel.childElementCount) {
    try {
      const models = await C.ipod.models();
      const seen = new Set();
      sel.innerHTML = models
        .filter((m) => {
          const k = m.model_family + m.generation;
          if (seen.has(k)) return false;
          if (/Shuffle|Mini/.test(m.model_family)) return false; // 화면 없는 기종 제외
          if (m.model_family === 'iPod' && !/^5/.test(m.generation)) return false; // 컬러 이전 구형 제외
          seen.add(k);
          return true;
        })
        .map((m) => `<option value="${m.model_number}">${h(m.model_family + ' ' + m.generation)} (${m.model_number})</option>`)
        .join('');
      sel.value = 'MC297';
    } catch (_) {}
  }
  const b = await C.backendStatus();
  $('#setBackend').textContent = b.ok
    ? `동기화 엔진: pypodlib (iOpenPod) · 음향 지문: ${b.fpcalc ? 'Chromaprint ✓' : '없음 — brew install chromaprint'}`
    : '동기화 엔진 오류: ' + b.error;
}
$('#btnSettings').onclick = openSettings;
$('#setDone').onclick = () => ($('#sheetBack').hidden = true);
$('#sheetBack').addEventListener('click', (e) => e.target.id === 'sheetBack' && ($('#sheetBack').hidden = true));
$('#setPick').onclick = async () => {
  state.settings = await C.settings.pickDir();
  $('#setDir').textContent = state.settings.musicDir;
  loadLibrary();
};
$('#setQuality').onchange = async (e) => (state.settings = await C.settings.set({ quality: e.target.value }));
$('#setConc').onchange = async (e) => (state.settings = await C.settings.set({ concurrency: Number(e.target.value) }));
$('#setLrc').onchange = async (e) => (state.settings = await C.settings.set({ writeLrc: e.target.checked }));
$('#setToolCheck').onchange = async (e) => (state.settings = await C.settings.set({ toolAutoCheck: e.target.checked }));
$('#setToolInstall').onchange = async (e) => (state.settings = await C.settings.set({ toolAutoInstall: e.target.checked }));
$('#setAuto').onchange = async (e) => (state.settings = await C.settings.set({ autoSync: e.target.checked }));
$('#setMakeVirtual').onclick = async () => {
  const btn = $('#setMakeVirtual');
  btn.disabled = true;
  try {
    const d = await C.ipod.createVirtual($('#setModel').value);
    state.settings = await C.settings.get();
    $('#sheetBack').hidden = true;
    state.device = d.path;
    show('device', { refresh: true });
    toast(`가상 아이팟 생성: ${d.displayName}`);
  } catch (e) {
    toast('생성 실패: ' + e.message);
  } finally {
    btn.disabled = false;
  }
};
$('#btnFolder').onclick = () => C.library.reveal();
$('#btnRemaster').onclick = async () => {
  const n = $('#cntRemaster').textContent;
  if (!confirm(`예전 방식으로 받은 ${n}곡을 원본에서 다시 받아 같은 파일에 덮어씁니다.\n(44.1kHz, 피크 여유 확보 — 아이팟에서 베이스가 지직거리는 문제 해결)\n\n끝나면 아이팟을 다시 동기화하세요.`)) return;
  const ids = await C.library.remaster();
  toast(`${ids.length}곡을 다시 받는 중입니다. 대기열에서 진행 상황을 볼 수 있습니다.`);
  show('downloads');
};
$('#btnFixCovers').onclick = async () => {
  const btn = $('#btnFixCovers');
  btn.disabled = true;
  try {
    const res = await C.library.fixCovers();
    const fixed = res.filter((r) => r.fixed).length;
    state.covers.clear();
    toast(fixed ? `${fixed}곡의 커버를 앨범 아트로 바꿨습니다. 아이팟에도 반영하려면 다시 동기화하세요.` : '고칠 커버가 없습니다');
    if (state.view === 'albums') renderAlbums();
  } catch (e) {
    toast('커버 고치기 실패: ' + e.message);
  } finally {
    btn.disabled = false;
  }
};
$('#btnFixLyrics').onclick = async () => {
  const btn = $('#btnFixLyrics');
  btn.disabled = true;
  try {
    const res = await C.library.fixLyrics();
    const found = res.filter((r) => r.found);
    const synced = found.filter((r) => r.synced).length;
    toast(
      found.length
        ? `${res.length}곡 중 ${found.length}곡에 가사를 넣었습니다 (싱크 ${synced}곡). 아이팟에도 넣으려면 다시 동기화하세요.`
        : `${res.length}곡 모두 가사를 찾지 못했습니다`
    );
  } catch (e) {
    toast('가사 찾기 실패: ' + e.message);
  } finally {
    btn.disabled = false;
  }
};
C.library.onFixProgress((p) => {
  const el = $('#sbInfo');
  if (p.done) return updateStatus();
  el.textContent = `${p.kind === 'cover' ? '커버 맞추는 중' : '가사 찾는 중'}… (${p.current + 1}/${p.total})`;
});
$('#btnDock').onclick = () => document.body.classList.toggle('app-nodock');

/* ───────── 아이팟 터치 / Apple Music ───────── */
state.ios = [];
const iosMajor = (v) => parseInt(String(v || '').split('.')[0], 10) || 0;
function iosStatus(d) {
  if (!d.paired) return { cls: 'lock', text: '잠금을 풀고 ‘신뢰’를 눌러 주세요' };
  if (iosMajor(d.iosVersion) < 5) return { cls: 'old', text: '구형 iOS — 직접 동기화 필요 (Finder 미지원)' };
  return { cls: '', text: 'Finder로 동기화' };
}
function renderIosList() {
  $('#iosList').innerHTML = state.ios
    .map(
      (d) => `<a class="src-dev ios" data-view="applemusic" title="${h(d.model)} · iOS ${h(d.iosVersion || '?')}">
        <i class="ico ico-touch"></i><span style="flex:1;overflow:hidden;text-overflow:ellipsis">${h(d.name)}</span><em>iOS ${h(d.iosVersion || '?')}</em></a>`
    )
    .join('');
  if (state.view === 'applemusic') renderAppleMusic();
}
function renderAppleMusic() {
  $('#amDevices').innerHTML = state.ios.length
    ? state.ios
        .map((d) => {
          const st = iosStatus(d);
          return `<li><i class="phone"></i><div><b>${h(d.name)}</b><span>${h(d.model)} · iOS ${h(d.iosVersion || '?')}</span></div><em class="${st.cls}">${h(st.text)}</em></li>`;
        })
        .join('')
    : '<li class="none">연결된 아이팟 터치·아이폰이 없습니다 (USB로 연결하면 여기에 나타납니다)</li>';
  $('#amSendAll').textContent = `보관함 전체 보내기 (${state.library.length}곡)`;
  $('#amSendAll').disabled = !state.library.length;
  $('#amAuto').checked = !!state.settings.musicAutoAdd;
}
C.ios.onDevices((list) => {
  const before = state.ios.length;
  state.ios = list;
  renderIosList();
  if (list.length > before && state.initialized) {
    const d = list[list.length - 1];
    const major = iosMajor(d.iosVersion);
    toast(major && major < 5 ? `${d.name} 연결됨 · 구형 iOS ${d.iosVersion}` : `${d.name} 연결됨`);
  }
});
$('#amSendAll').onclick = async () => {
  const btn = $('#amSendAll');
  const res = $('#amResult');
  btn.disabled = true;
  res.className = 'am-result';
  res.textContent = 'Music 앱에 추가하는 중…';
  try {
    const r = await C.music.add();
    res.textContent =
      `‘${r.playlist}’ 플레이리스트에 ${r.added}곡 추가` +
      (r.skipped ? ` · ${r.skipped}곡은 이미 있음` : '') +
      (r.failed.length ? ` · ${r.failed.length}곡 실패` : '');
  } catch (e) {
    res.className = 'am-result err';
    res.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
};
$('#amAuto').onchange = async (e) => (state.settings = await C.settings.set({ musicAutoAdd: e.target.checked }));
C.music.onAdded((r) => r.added && toast(`Apple Music ‘${r.playlist}’에 추가됨`));
C.music.onError((m) => toast('Apple Music 추가 실패: ' + m));

/* ───────── Apple 레전드 광고 ───────── */
state.ads = [];
async function loadAds() {
  state.ads = await C.ads.list();
  renderAds();
}
function adFoot(a) {
  const j = a.job;
  if (j && (j.state === 'downloading' || j.state === 'converting')) {
    const label = j.state === 'downloading' ? '받는 중' : '아이팟용으로 변환 중';
    return `<span class="ad-bar"><i style="width:${Math.round((j.progress || 0) * 100)}%"></i></span><span class="st">${label}</span>`;
  }
  if (a.file) {
    return `<button class="pill dark" data-play="${h(a.id)}">▶ 보기</button><button class="pill dark" data-remove="${h(a.id)}">삭제</button><span class="st">아이팟 동기화 때 함께 들어갑니다</span>`;
  }
  const err = j?.state === 'error' ? `<span class="st err" title="${h(j.error || '')}">받기 실패 — 다시 시도</span>` : '';
  return `<button class="pill dark" data-get="${h(a.id)}">받기</button>${err}`;
}
function renderAds() {
  $('#adsGrid').innerHTML = state.ads
    .map(
      (a) => `<div class="ad-card ${a.file ? 'have' : ''}" data-id="${h(a.id)}">
        <div class="ad-screen" data-play="${a.file ? h(a.id) : ''}">
          <img src="${h(a.thumb)}" alt="" loading="lazy" />
          <span class="ad-year">${a.year}</span>
          ${a.file ? '<span class="ad-badge">받음</span><span class="ad-play"></span>' : ''}
        </div>
        <div class="ad-meta">
          <h3>${h(a.title)}</h3>
          <div class="prod">${h(a.product)}${a.by ? ' · ' + h(a.by) : ''}</div>
          <p>${h(a.desc)}</p>
        </div>
        <div class="ad-foot">${adFoot(a)}</div>
      </div>`
    )
    .join('');
  const left = state.ads.filter((a) => !a.file).length;
  $('#adsGetAll').textContent = left ? `모두 받기 (${left}편)` : '모두 받았습니다';
  $('#adsGetAll').disabled = !left;
}
async function getAd(id) {
  try {
    await C.ads.download(id);
    const a = state.ads.find((x) => x.id === id);
    toast(`받기 완료: ${a?.title || ''}`);
  } catch (e) {
    toast('광고 받기 실패: ' + e.message.split('\n').pop());
  }
  loadAds();
}
$('#adsGrid').addEventListener('click', async (e) => {
  const get = e.target.closest('[data-get]');
  const play = e.target.closest('[data-play]');
  const rm = e.target.closest('[data-remove]');
  if (get) return getAd(get.dataset.get);
  if (rm) {
    const a = state.ads.find((x) => x.id === rm.dataset.remove);
    if (a && confirm(`'${a.title}' 영상을 휴지통으로 옮길까요?`)) {
      await C.ads.remove(a.id);
      loadAds();
    }
    return;
  }
  if (play && play.dataset.play) {
    const a = state.ads.find((x) => x.id === play.dataset.play);
    if (a?.file) openVideo(a);
  }
});
$('#adsGetAll').onclick = async () => {
  for (const a of state.ads.filter((x) => !x.file)) await getAd(a.id);
};
$('#adsReveal').onclick = () => C.ads.reveal();
C.ads.onUpdate((u) => {
  const a = state.ads.find((x) => x.id === u.id);
  if (!a) return;
  a.job = u;
  const card = document.querySelector(`.ad-card[data-id="${CSS.escape(u.id)}"] .ad-foot`);
  if (card) card.innerHTML = adFoot(a);
});
C.ads.onChanged(() => state.view === 'ads' && loadAds());

// 영상 플레이어
function openVideo(a) {
  if (!audio.paused) audio.pause();
  $('#vpTitle').textContent = [a.title + (a.year ? ` (${a.year})` : ''), a.product].filter(Boolean).join(' — ');
  const v = $('#vpVideo');
  v.src = C.fileUrl(a.file);
  $('#vpBack').hidden = false;
  v.play().catch(() => {});
}
function closeVideo() {
  const v = $('#vpVideo');
  v.pause();
  v.removeAttribute('src');
  v.load();
  $('#vpBack').hidden = true;
}
$('#vpClose').onclick = closeVideo;
$('#vpBack').addEventListener('click', (e) => e.target.id === 'vpBack' && closeVideo());
document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('#vpBack').hidden && closeVideo());

/* ───────── YouTube 동영상 검색·받기 / 동영상 보관함 ───────── */
state.searchMode = 'music';
state.vresults = [];
state.vlib = [];
const fmtViews = (n) => (n >= 1e8 ? `${(n / 1e8).toFixed(1)}억회` : n >= 1e4 ? `${Math.round(n / 1e4)}만회` : n ? `${n}회` : '');

$('#searchMode').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.searchMode = b.dataset.mode;
  $$('#searchMode button').forEach((x) => x.classList.toggle('on', x === b));
  $('#searchInput').placeholder = state.searchMode === 'video' ? '동영상 검색 또는 링크' : 'iTube Store 검색 또는 링크';
  $('#searchTitle').textContent = state.searchMode === 'video' ? 'iTube Store 동영상' : 'iTube Store';
  $('#searchSub').textContent =
    state.searchMode === 'video'
      ? '라이브 클립, 뮤직비디오, 무엇이든. 받으면 아이팟에서 볼 수 있는 영상으로 바꿔 둡니다.'
      : '아티스트, 앨범, 곡 이름을 검색하거나 노래·앨범 링크를 붙여넣으세요.';
  $('#coverflow').hidden = true;
  $('#results').innerHTML = '';
  $('#searchInput').focus();
});

function vFoot(v) {
  const j = v.job;
  if (j && (j.state === 'downloading' || j.state === 'converting')) {
    return `<span class="ad-bar"><i style="width:${Math.round((j.progress || 0) * 100)}%"></i></span><span class="st">${j.state === 'downloading' ? '받는 중' : '변환 중'}</span>`;
  }
  if (v.file) return `<button class="pill" data-vplay="${h(v.videoId)}">▶ 보기</button><span class="st">받음</span>`;
  const err = j?.state === 'error' ? `<span class="st" style="color:#b0331f" title="${h(j.error || '')}">실패 — 다시 시도</span>` : '';
  return `<button class="buy" data-vget="${h(v.videoId)}">받기</button>${err}`;
}
function vCard(v) {
  return `<div class="vcard ${v.file ? 'have' : ''}" data-vid="${h(v.videoId)}">
    <div class="vthumb" ${v.file ? `data-vplay="${h(v.videoId)}"` : ''}><img src="${h(v.thumb)}" alt="" loading="lazy" />${
      v.duration ? `<span class="vdur">${fmtTime(v.duration)}</span>` : ''
    }${v.file ? '<span class="ad-play"></span>' : ''}</div>
    <h4 title="${h(v.title)}">${h(v.title)}</h4>
    <div class="vsub">${h([v.channel, fmtViews(v.views)].filter(Boolean).join(' · '))}</div>
    <div class="ad-foot">${vFoot(v)}</div>
  </div>`;
}

async function searchVideos(q) {
  show('search');
  $('#coverflow').hidden = true;
  $('#results').innerHTML = '';
  $('#searchSpin').hidden = false;
  try {
    state.vresults = await C.videos.search(q);
    $('#searchTitle').textContent = `“${q}” 동영상`;
    $('#searchSub').textContent = `${state.vresults.length}개 · 받으면 아이팟용 영상(640×480 이하)으로 변환합니다`;
    $('#results').innerHTML = state.vresults.length
      ? `<div class="vgrid" id="vResults">${state.vresults.map(vCard).join('')}</div>`
      : '<div class="paste-hint">결과가 없습니다.</div>';
  } catch (err) {
    $('#results').innerHTML = `<div class="paste-hint">검색 실패: ${h(err.message)}</div>`;
  } finally {
    $('#searchSpin').hidden = true;
  }
}

$('#results').addEventListener('click', async (e) => {
  const get = e.target.closest('[data-vget]');
  const play = e.target.closest('[data-vplay]');
  if (get) {
    const v = state.vresults.find((x) => x.videoId === get.dataset.vget);
    if (!v) return;
    try {
      await C.videos.download(v);
      toast(`영상 받기 완료: ${v.title}`);
    } catch (err) {
      toast('영상 받기 실패: ' + String(err.message).split('\n').pop());
    }
  } else if (play) {
    const v = state.vresults.find((x) => x.videoId === play.dataset.vplay);
    if (v?.file) openVideo({ title: v.title, year: '', product: v.channel, file: v.file });
  }
});

C.videos.onUpdate((u) => {
  if (!u.key.startsWith('yt:')) return;
  const id = u.key.slice(3);
  const v = state.vresults.find((x) => x.videoId === id);
  if (!v) return;
  v.job = u;
  if (u.state === 'done') v.file = u.file;
  const card = document.querySelector(`.vcard[data-vid="${CSS.escape(id)}"]`);
  if (card) card.outerHTML = vCard(v);
});
C.videos.onChanged(() => {
  refreshVideoCount();
  if (state.view === 'videos') loadVideoLibrary();
});
C.ads.onChanged(() => refreshVideoCount());

// 동영상 보관함
async function refreshVideoCount() {
  state.vlib = await C.videos.library();
  $('#cntVideos').textContent = state.vlib.length || '';
}
async function loadVideoLibrary() {
  await refreshVideoCount();
  // 원본 주소가 없는 광고 영상은 광고 목록에서 썸네일을 찾는다
  if (state.vlib.some((v) => !v.thumb)) {
    const ads = state.ads.length ? state.ads : (state.ads = await C.ads.list());
    state.vlib.forEach((v) => {
      if (v.thumb) return;
      const ad = ads.find((a) => a.file === v.file || a.title === v.title);
      if (ad) v.thumb = `https://i.ytimg.com/vi/${ad.videoId}/mqdefault.jpg`;
    });
  }
  $('#vidGrid').innerHTML = state.vlib.length
    ? state.vlib
        .map(
          (v, i) => `<div class="vcard have" data-i="${i}">
        <div class="vthumb ${v.thumb ? '' : 'noimg'}" data-lplay="${i}">${v.thumb ? `<img src="${h(v.thumb)}" alt="" loading="lazy" />` : ''}${
            v.duration ? `<span class="vdur">${fmtTime(v.duration)}</span>` : ''
          }<span class="ad-play"></span></div>
        <h4 title="${h(v.title)}">${h(v.title)}</h4>
        <div class="vsub">${h([v.folder, v.artist, v.year].filter(Boolean).join(' · '))} · ${fmtBytes(v.size)}</div>
        <div class="ad-foot"><button class="pill dark" data-lplay="${i}">▶ 보기</button><button class="pill dark" data-lrm="${i}">삭제</button></div>
      </div>`
        )
        .join('')
    : '<div class="vempty">아직 받은 영상이 없습니다. iTube Store 검색 화면에서 <b>동영상</b>으로 바꿔 찾아보거나, 엑스트라의 <b>Apple 광고</b>를 받아 보세요.</div>';
}
$('#vidGrid').addEventListener('click', async (e) => {
  const play = e.target.closest('[data-lplay]');
  const rm = e.target.closest('[data-lrm]');
  if (play) {
    const v = state.vlib[play.dataset.lplay];
    if (v) openVideo({ title: v.title, year: v.year, product: v.artist || v.folder, file: v.file });
  } else if (rm) {
    const v = state.vlib[rm.dataset.lrm];
    if (v && confirm(`'${v.title}' 영상을 휴지통으로 옮길까요?`)) {
      await C.videos.remove(v.file);
      loadVideoLibrary();
    }
  }
});
$('#vidReveal').onclick = () => C.ads.reveal();
document.querySelector('[data-goto-video]').onclick = () => {
  show('search');
  if (state.searchMode !== 'video') document.querySelector('#searchMode [data-mode=video]').click();
};

/* ───────── 도구 업데이트 (왼쪽 아래) ───────── */
let toolsState = null;
function ago(ts) {
  if (!ts) return '확인 전';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return '방금 확인';
  if (m < 60) return `${m}분 전 확인`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}시간 전 확인` : `${Math.round(h / 24)}일 전 확인`;
}
function renderTools(st) {
  toolsState = st;
  const shortVer = (v) => String(v || '').replace(/_\d+$/, '');
  $('#tpList').innerHTML = st.tools
    .map((t) => {
      const cls = t.source === 'missing' ? 'miss' : t.update ? 'upd' : '';
      // 2026.10.26 → 26.10.26 (좁은 칸에 맞게)
      const compact = (v) => shortVer(v).replace(/^20(\d\d)\./, '$1.');
      const txt = t.source === 'missing' ? '설치 안 됨' : t.update ? `↑ ${compact(t.latest)}` : compact(t.version);
      const tip = [t.version && `현재 ${shortVer(t.version)}`, t.latest && `새 버전 ${shortVer(t.latest)}`, t.note || t.path].filter(Boolean).join(' · ');
      const badge = t.update ? '<em class="ios-badge">1</em>' : '';
      return `<li class="${cls}" title="${h(tip)}"><span class="app-ic ic-${t.id.replace(/-/g, '')}">${badge}</span><b>${h(t.label === 'Chromaprint' ? 'fpcalc' : t.label)}</b><small>${h(txt)}</small></li>`;
    })
    .join('');
  const nUpd = st.tools.filter((t) => t.update).length;
  $('#tfBadge').hidden = !nUpd;
  $('#tfBadge').textContent = nUpd;
  $('#tpWhen').textContent = st.checking ? '확인 중…' : st.installing ? '설치 중…' : ago(st.lastCheck);
  const n = st.tools.filter((t) => t.update && t.installable).length;
  const btn = $('#tpBtn');
  btn.classList.toggle('go', n > 0 && !st.installing);
  if (st.installing) openToolFolder(true);
  btn.disabled = st.checking || st.installing;
  btn.textContent = st.installing ? '설치 중…' : st.checking ? '확인 중…' : n ? `업데이트 ${n}개 설치` : '업데이트 확인';
  const log = $('#tpLog');
  log.hidden = !(st.installing || st.error) || !st.log.length;
  log.textContent = st.error ? '오류: ' + st.error : st.log.slice(-3).join('\n');
}
function openToolFolder(on) {
  const sb = $('#sidebar');
  const open = on ?? !sb.classList.contains('tf-on');
  sb.classList.toggle('tf-on', open);
  $('#toolFolder').classList.toggle('open', open);
  $('#tfOpen').setAttribute('aria-hidden', String(!open));
}
$('#toolFolder').onclick = (e) => {
  e.stopPropagation();
  openToolFolder();
};
$('#tfDim').onclick = () => !toolsState?.installing && openToolFolder(false);
document.addEventListener('keydown', (e) => e.key === 'Escape' && !toolsState?.installing && openToolFolder(false));
$('#tpBtn').onclick = async () => {
  const n = toolsState?.tools.filter((t) => t.update && t.installable) || [];
  try {
    if (n.length) {
      const st = await C.tools.install();
      toast(st.error ? '업데이트 실패: ' + st.error : `${n.map((t) => t.label).join(', ')} 업데이트 완료`);
    } else {
      const st = await C.tools.check();
      const m = st.tools.filter((t) => t.update).length;
      toast(st.error ? '확인 실패: ' + st.error : m ? `새 버전 ${m}개가 있습니다` : '모든 도구가 최신입니다');
    }
  } catch (e) {
    toast(e.message);
  }
};
setInterval(() => toolsState && !toolsState.checking && ($('#tpWhen').textContent = ago(toolsState.lastCheck)), 60000);

/* ───────── 클릭 휠 게임 ───────── */
const gameUI = { info: null, path: '', device: null, selected: new Set(), busy: false, checking: false, request: 0 };
const gameSearch = $('#gamesSearch');
const gameDeviceSelect = $('#gamesDevice');
const gameAuth = $('#gamesAuthorized');
const gameRows = $('#gamesRows');
const gameAll = $('#gamesAll');
const gameProgress = $('#gamesProgress');
const gameMessage = (message) => { $('#gamesMessage').textContent = message; };

function visibleGames() {
  const query = gameSearch.value.trim().toLowerCase();
  return (gameUI.info?.catalog || []).filter((game) => `${game.title} ${game.genre}`.toLowerCase().includes(query));
}

function gameRowState(game) {
  if (game.videoOnly && gameUI.device?.support === 'common') return ['기종 제한', 'limited'];
  if (gameUI.device?.installed.includes(game.id)) return ['복사됨', 'installed'];
  return [game.videoOnly ? 'Video 전용' : '공통', ''];
}

function updateGameSelection() {
  const boxes = $$('input', gameRows).filter((box) => box.dataset.selectable === 'true');
  const picked = boxes.filter((box) => box.checked).length;
  gameAll.checked = picked > 0 && picked === boxes.length;
  gameAll.indeterminate = picked > 0 && picked < boxes.length;
  gameAll.disabled = gameUI.busy || !boxes.length;
  const games = (gameUI.info?.catalog || []).filter((game) => gameUI.selected.has(game.id));
  const bytes = games.reduce((sum, game) => sum + game.bytes, 0);
  $('#gamesSelection').textContent = games.length ? `${games.length}개 선택 · ${fmtBytes(bytes)}` : '선택한 게임 없음';
  $('#gamesSync').disabled = !games.length || !gameUI.info?.ready || !gameAuth.checked
    || !gameUI.device?.hasAuth || gameUI.busy || gameUI.checking;
}

function renderGames() {
  const { info, device, busy, checking, selected } = gameUI;
  $('#gamesLibraryCount').textContent = info ? String(info.catalog.length).padStart(2, '0') : '––';
  $('#gamesLibraryLabel').textContent = info?.ready ? 'PACK READY' : 'CLICK WHEEL';
  $('#gamesPackStatus').textContent = info?.ready ? '게임 팩을 사용할 수 있습니다.'
    : info ? `공식 보존 팩 v16 · ${(info.archiveBytes / 1e9).toFixed(1)} GB` : '보존 프로젝트의 게임 팩을 확인하고 있습니다.';
  $('#gamesDownload').disabled = $('#gamesImport').disabled = busy || !info;
  $('#gamesDownload').hidden = $('#gamesImport').hidden = !!info?.ready;
  gameDeviceSelect.disabled = busy || !gameUI.path;
  gameAuth.disabled = busy || checking || !device?.hasAuth;
  $('#gamesDeviceStatus').textContent = checking ? '아이팟의 게임 폴더를 확인 중…'
    : device?.hasAuth ? '인증 파일이 있습니다. 보존 프로젝트의 iTunes 동기화를 마쳤는지 확인하세요.'
    : device ? '이 아이팟을 보존 프로젝트의 iTunes에서 먼저 인증하세요.'
    : gameUI.path ? '게임 폴더를 확인할 수 없습니다.'
    : 'iPod video 5/5.5세대, classic 6~7세대, nano 3~5세대를 USB로 연결하세요.';

  for (const game of info?.catalog || []) {
    if (gameRowState(game)[1]) selected.delete(game.id);
  }
  const games = visibleGames();
  gameRows.innerHTML = games.map((game) => {
    const [label, status] = gameRowState(game);
    return `<tr class="${status}"><td><input type="checkbox" value="${game.id}" aria-label="${h(game.title)}" data-selectable="${!status}" ${selected.has(game.id) ? 'checked' : ''} ${busy || status ? 'disabled' : ''} /></td>
      <th scope="row"><span class="games-title">${h(game.title)}</span><small>${h(game.genre)}</small></th>
      <td>${fmtBytes(game.bytes)}</td><td><span class="games-tag">${label}</span></td></tr>`;
  }).join('');
  $('#gamesEmpty').hidden = !!games.length;
  $('#gamesEmpty').textContent = info ? '검색 결과가 없습니다.' : '게임 목록을 확인하고 있습니다.';
  updateGameSelection();
}

async function refreshGameDevice() {
  const request = ++gameUI.request;
  const devices = state.devices.filter((device) => device.gamesSupport);
  const old = gameUI.path;
  gameUI.path = (devices.find((device) => device.path === old)
    || devices.find((device) => device.path === state.device) || devices[0])?.path || '';
  gameDeviceSelect.innerHTML = devices.length
    ? devices.map((device) => `<option value="${h(device.path)}">${h(device.name)} · ${h(device.displayName)}</option>`).join('')
    : '<option value="">연결된 지원 기기 없음</option>';
  gameDeviceSelect.value = gameUI.path;
  if (old !== gameUI.path) {
    gameAuth.checked = false;
    gameUI.device = null;
  }
  gameUI.checking = !!gameUI.path;
  renderGames();
  const device = gameUI.path ? await C.games.device(gameUI.path).catch(() => null) : null;
  if (request !== gameUI.request) return;
  if (device?.mountKey !== gameUI.device?.mountKey || !device?.hasAuth) gameAuth.checked = false;
  gameUI.device = device;
  gameUI.checking = false;
  renderGames();
}

async function loadGames() {
  refreshGameDevice();
  try {
    gameUI.info = await C.games.info();
    renderGames();
  } catch (error) {
    gameMessage(error.message);
  }
}

gameSearch.oninput = renderGames;
gameRows.onchange = ({ target }) => {
  if (!target.matches('input')) return;
  if (target.checked) gameUI.selected.add(target.value);
  else gameUI.selected.delete(target.value);
  updateGameSelection();
};
gameAll.onchange = () => {
  for (const box of $$('input[data-selectable="true"]', gameRows)) {
    box.checked = gameAll.checked;
    if (box.checked) gameUI.selected.add(box.value);
    else gameUI.selected.delete(box.value);
  }
  updateGameSelection();
};
gameDeviceSelect.onchange = () => {
  gameAuth.checked = false;
  gameUI.device = null;
  gameUI.path = gameDeviceSelect.value;
  gameMessage('');
  refreshGameDevice();
};
gameAuth.onchange = updateGameSelection;

async function gameTask(task, message) {
  if (gameUI.busy) return;
  gameUI.busy = true;
  gameMessage(message);
  renderGames();
  try {
    await task();
  } catch (error) {
    const detail = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    gameMessage(/AbortError|operation was aborted/i.test(detail) ? '게임 팩 준비를 취소했습니다.' : detail);
  } finally {
    gameUI.busy = false;
    gameProgress.hidden = $('#gamesCancel').hidden = true;
    renderGames();
  }
}

function prepareGamePack(importLocal) {
  return gameTask(async () => {
    const info = await (importLocal ? C.games.importArchive() : C.games.download());
    if (info) gameUI.info = info;
    gameMessage(info ? '게임 팩 준비 완료' : '');
  }, importLocal ? '' : 'GitHub에서 다운로드를 시작합니다…');
}

$('#gamesDownload').onclick = () => prepareGamePack(false);
$('#gamesImport').onclick = () => prepareGamePack(true);
$('#gamesCancel').onclick = () => {
  $('#gamesCancel').disabled = true;
  C.games.cancel();
};
$('#gamesGuide').onclick = () => {
  $('#gamesAuthGuide').showModal();
  $('.games-guide-body').scrollTop = 0;
};
$('#gamesGuideUtm').onclick = () => C.games.utm();
$('#gamesGuideVm').onclick = () => C.games.release();
$('#gamesGuideSource').onclick = () => C.games.guide();
$('#gamesRelease').onclick = () => C.games.release();
$('#gamesSync').onclick = () => {
  const request = { path: gameUI.path, mountKey: gameUI.device?.mountKey, ids: [...gameUI.selected], authorized: gameAuth.checked };
  return gameTask(async () => {
    try {
      const { added, skipped } = await C.games.sync(request);
      gameUI.selected.clear();
      gameMessage(`${added}개 복사 완료${skipped ? ` · ${skipped}개 건너뜀` : ''}. 꺼낸 뒤 아이팟의 엑스트라 → 게임에서 여세요.`);
    } finally {
      await refreshGameDevice();
    }
  }, '아이팟을 확인 중…');
};

C.games.onProgress(({ phase, done, total, title }) => {
  gameProgress.hidden = false;
  $('#gamesCancel').hidden = phase === 'sync';
  if (done === 0) $('#gamesCancel').disabled = false;
  if (total) gameProgress.value = done / total;
  else gameProgress.removeAttribute('value');
  if (phase === 'extract') gameMessage('게임 팩 압축을 푸는 중…');
  else if (phase === 'sync') gameMessage(`${done + 1}/${total} · ${title} 복사 중…`);
  else gameMessage(`${phase === 'import' ? '파일 확인' : '다운로드'} 중 · ${Math.floor(100 * done / total)}%`);
});

/* ───────── 시작 ───────── */
(async () => {
  state.settings = await C.settings.get();
  state.masterVersion = state.settings.masterVersion;
  renderTools(await C.tools.state());
  refreshVideoCount();
  state.ios = await C.ios.devices();
  renderIosList();
  C.tools.onState(renderTools);
  state.jobs = new Map((await C.dl.list()).map((j) => [j.id, j]));
  state.devices = await C.ipod.devices();
  renderDeviceList();
  await loadLibrary();
  show(state.library.length ? 'songs' : 'search');
  renderSearch();
  updateLcd();
  state.initialized = true;
})();
