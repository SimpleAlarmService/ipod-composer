// 가사 탐색: YouTube Music → LRCLIB(한국어 메타) → LRCLIB(영어 메타) → LRCLIB 검색
const ytm = require('./ytmusic');

const LRCLIB = 'https://lrclib.net/api';
const HEADERS = { 'user-agent': 'Composer/0.1 (Electron music tagger)' };

function parseLrc(lrc) {
  if (!lrc) return null;
  const out = [];
  for (const line of lrc.split(/\r?\n/)) {
    const tags = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!tags.length) continue;
    const text = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of tags) out.push({ t: Number(m[1]) * 60 + Number(m[2]), text });
  }
  return out.sort((a, b) => a.t - b.t);
}

function toLrc(synced) {
  return synced
    .map((l) => {
      const m = Math.floor(l.t / 60);
      const s = (l.t - m * 60).toFixed(2).padStart(5, '0');
      return `[${String(m).padStart(2, '0')}:${s}]${l.text}`;
    })
    .join('\n');
}

// "아이유(IU)" → ["아이유(IU)", "아이유", "IU"]
function nameVariants(s) {
  const out = new Set();
  if (!s) return [];
  const first = s.split(/,|&| x | feat\.?| ft\./i)[0].trim();
  out.add(first);
  const paren = first.match(/^(.*?)\s*[(（](.*?)[)）]\s*$/);
  if (paren) {
    out.add(paren[1].trim());
    paren[2].split('/').forEach((p) => out.add(p.trim()));
  }
  return [...out].filter(Boolean);
}

function stripTitle(t) {
  return (t || '')
    .replace(/\s*[(\[](feat|ft|prod|with)[^)\]]*[)\]]/gi, '')
    .replace(/\s*-\s*(remaster|live|from).*$/i, '')
    .trim();
}

// ---------- 벅스 (비공식 웹 API) ----------
const BUGS_HEADERS = { 'user-agent': 'Mozilla/5.0', referer: 'https://music.bugs.co.kr/' };
const normTitle = (s) =>
  (s || '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]|（.*?）/g, '')
    .replace(/[\s\-_.,'"!?·’]/g, '');
const mmss = (s) => (s || '').split(':').map(Number).reduce((a, b) => a * 60 + b, 0);

async function bugsLyrics(meta, candidates) {
  const tried = new Set();
  for (const c of candidates.slice(0, 4)) {
    const q = `${c.artist} ${c.title}`;
    if (tried.has(q)) continue;
    tried.add(q);
    const url = `https://m.bugs.co.kr/api/getSearchList?type=track&page=1&size=10&query=${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: BUGS_HEADERS });
    if (!r.ok) continue;
    const list = (await r.json()).list || [];
    const want = normTitle(c.title);
    const hit = list.find((t) => {
      const tt = normTitle(t.track_title);
      const titleOk = tt === want || (want.length > 3 && (tt.includes(want) || want.includes(tt)));
      const durOk = !meta.duration || !t.len || Math.abs(mmss(t.len) - meta.duration) <= 5;
      return titleOk && durOk;
    });
    if (!hit) continue;
    const match = `${hit.artists?.map((a) => a.artist_nm).join(', ')} - ${hit.track_title}`;
    const timed = await fetch(`https://music.bugs.co.kr/player/lyrics/T/${hit.track_id}`, { headers: BUGS_HEADERS })
      .then((x) => x.json())
      .catch(() => null);
    if (timed?.lyrics) {
      const synced = timed.lyrics
        .split('＃')
        .map((p) => {
          const i = p.indexOf('|');
          return i > 0 ? { t: Number(p.slice(0, i)), text: p.slice(i + 1).trim() } : null;
        })
        .filter((l) => l && isFinite(l.t));
      if (synced.length >= 4) return { plain: synced.map((l) => l.text).join('\n'), synced, source: '벅스', match };
    }
    const plain = await fetch(`https://music.bugs.co.kr/player/lyrics/N/${hit.track_id}`, { headers: BUGS_HEADERS })
      .then((x) => x.json())
      .catch(() => null);
    if (plain?.lyrics?.trim()) return { plain: plain.lyrics.trim(), synced: null, source: '벅스', match };
  }
  return null;
}

async function lrclibGet({ title, artist, album, duration }) {
  const q = new URLSearchParams({ track_name: title, artist_name: artist });
  if (album) q.set('album_name', album);
  if (duration) q.set('duration', String(Math.round(duration)));
  const r = await fetch(`${LRCLIB}/get?${q}`, { headers: HEADERS });
  if (!r.ok) return null;
  return r.json();
}

async function lrclibSearch({ title, artist }) {
  const q = new URLSearchParams({ track_name: title, artist_name: artist });
  const r = await fetch(`${LRCLIB}/search?${q}`, { headers: HEADERS });
  if (!r.ok) return [];
  return r.json();
}

function fromLrclib(rec, label) {
  if (!rec || rec.instrumental) return rec?.instrumental ? { plain: '', synced: null, instrumental: true, source: 'LRCLIB' } : null;
  const synced = parseLrc(rec.syncedLyrics);
  const plain = rec.plainLyrics || (synced ? synced.map((l) => l.text).join('\n') : '');
  if (!plain) return null;
  return { plain, synced: synced?.length ? synced : null, source: `LRCLIB${label ? ' · ' + label : ''}` };
}

/**
 * meta: { videoId, title, artist, album, duration, lyricsBrowseId? }
 */
async function findLyrics(meta, log = () => {}) {
  if (/\binst(rumental)?\b|\(inst\)|MR$/i.test(meta.title)) {
    return { plain: '', synced: null, instrumental: true, source: '연주곡' };
  }

  // 1) YouTube Music 자체 가사
  try {
    let lyId = meta.lyricsBrowseId;
    if (!lyId && meta.videoId) lyId = (await ytm.getWatchInfo(meta.videoId)).lyricsBrowseId;
    const y = await ytm.getYtmLyrics(lyId);
    if (y?.plain) {
      log('YouTube Music 가사 찾음');
      return y;
    }
  } catch (_) {}

  // 2) LRCLIB — 원어/영어 메타 조합으로 정확 매칭
  const candidates = [];
  const addCand = (title, artist, album) => {
    for (const a of nameVariants(artist)) candidates.push({ title: stripTitle(title), artist: a, album });
  };
  addCand(meta.title, meta.artist, meta.album);
  try {
    if (meta.videoId) {
      const en = await ytm.getWatchInfo(meta.videoId, { hl: 'en', gl: 'US' });
      if (en.title && (en.title !== meta.title || en.artist !== meta.artist)) addCand(en.title, en.artist, en.album);
    }
  } catch (_) {}

  let plainOnly = null; // 일반 가사만 찾은 경우 싱크 가사를 더 찾아본다
  const seen = new Set();
  for (const c of candidates) {
    const key = c.title + '|' + c.artist;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const rec = await lrclibGet({ ...c, duration: meta.duration });
      const l = fromLrclib(rec);
      if (l?.synced || l?.instrumental) {
        log(`LRCLIB 싱크 가사 찾음 (${c.artist} - ${c.title})`);
        return l;
      }
      if (l && !plainOnly) plainOnly = l;
    } catch (_) {}
  }

  // 3) 벅스 — 국내 곡·신곡에 강하고 싱크 가사를 준다
  try {
    const b = await bugsLyrics(meta, candidates);
    if (b?.synced) {
      log(`벅스 싱크 가사 찾음 (${b.match})`);
      return b;
    }
    if (b && !plainOnly) plainOnly = b;
  } catch (_) {}

  // 4) LRCLIB 검색 — 길이 차이 5초 이내 중 싱크 가사 우선
  for (const c of candidates) {
    try {
      const list = await lrclibSearch(c);
      const ok = list
        .filter((r) => !meta.duration || Math.abs((r.duration || 0) - meta.duration) <= 5)
        .sort((a, b) => Number(!!b.syncedLyrics) - Number(!!a.syncedLyrics));
      const l = fromLrclib(ok[0], '검색');
      if (l?.synced) {
        log(`LRCLIB 검색으로 싱크 가사 찾음 (${ok[0].artistName} - ${ok[0].trackName})`);
        return l;
      }
      if (l && !plainOnly) plainOnly = l;
    } catch (_) {}
  }

  // 4) syncedlyrics(Python, MIT) — Musixmatch·NetEase·Megalobiz·Genius
  if (extraProvider) {
    for (const c of candidates.slice(0, 2)) {
      try {
        const r = await extraProvider({ title: c.title, artist: c.artist });
        const synced = cleanCredits(parseLrc(r?.lrc));
        if (synced?.length >= 4 && plausible(synced, meta.duration)) {
          log(`syncedlyrics 싱크 가사 찾음 (${c.artist} - ${c.title})`);
          return { plain: synced.map((l) => l.text).join('\n'), synced, source: 'syncedlyrics' };
        }
      } catch (_) {}
    }
  }
  if (plainOnly) log(`일반 가사 사용 (${plainOnly.source})`);
  return plainOnly;
}

// NetEase 등의 '作词 : ...' 크레딧 줄 제거
function cleanCredits(lines) {
  if (!lines) return null;
  return lines.filter((l) => !/^\s*(作词|作曲|编曲|制作人|词|曲|Lyricist|Composer|Arranger)\s*[:：]/i.test(l.text));
}

// 마지막 가사 시각이 곡 길이를 크게 넘으면 다른 곡으로 본다
function plausible(lines, duration) {
  if (!duration) return true;
  const last = lines[lines.length - 1].t;
  return last <= duration + 10 && last >= duration * 0.4;
}

let extraProvider = null;
function setExtraProvider(fn) {
  extraProvider = fn;
}

module.exports = { findLyrics, parseLrc, toLrc, setExtraProvider };
