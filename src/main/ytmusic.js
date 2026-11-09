// 사제 YouTube Music InnerTube 클라이언트 (비로그인)
// 2026-11 기준: 비로그인 세션에서는 '노래' 필터가 없고 자체 가사가 막혀 있으므로
// 앨범 검색 → 앨범 browse(트랙리스트) 경로를 주력으로 쓴다.

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const BASE = 'https://music.youtube.com';
const FILTER = {
  albums: 'EgWKAQIYAWoQEBAQBRAKEAkQFRAEEA4QEQ==',
  videos: 'EgWKAQIQAWoQEBAQBRAKEAkQFRAEEA4QEQ==',
  artists: 'EgWKAQIgAWoQEBAQBRAKEAkQFRAEEA4QEQ==',
};

let session = null; // { visitorData, version, at }

async function getSession() {
  if (session && Date.now() - session.at < 60 * 60 * 1000) return session;
  let visitorData = '';
  let version = '1.20261104.00.00';
  try {
    const html = await (
      await fetch(BASE + '/', { headers: { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9' }, signal: AbortSignal.timeout(8000) })
    ).text();
    const vd = html.match(/"VISITOR_DATA":"([^"]+)"/);
    const ver = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
    if (vd) visitorData = decodeURIComponent(vd[1]);
    if (ver) version = ver[1];
  } catch (_) {
    /* 오프라인이면 기본값으로 시도 */
  }
  session = { visitorData, version, at: Date.now() };
  return session;
}

async function call(endpoint, body, { hl = 'ko', gl = 'KR' } = {}) {
  const s = await getSession();
  const res = await fetch(`${BASE}/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: {
      'content-type': 'application/json',
      origin: BASE,
      referer: BASE + '/',
      'user-agent': UA,
      ...(s.visitorData ? { 'x-goog-visitor-id': s.visitorData } : {}),
      'x-youtube-client-name': '67',
      'x-youtube-client-version': s.version,
    },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB_REMIX', clientVersion: s.version, hl, gl, visitorData: s.visitorData } },
      ...body,
    }),
  });
  if (!res.ok) throw new Error(`YouTube Music ${endpoint} 요청 실패 (${res.status})`);
  return res.json();
}

// ---------- 파싱 유틸 ----------
const runsText = (t) => (t?.runs || []).map((r) => r.text).join('') || t?.simpleText || '';
const flex = (item, i) => item.flexColumns?.[i]?.musicResponsiveListItemFlexColumnRenderer?.text;
const fixed = (item, i) => item.fixedColumns?.[i]?.musicResponsiveListItemFixedColumnRenderer?.text;
const bid = (r) => r?.navigationEndpoint?.browseEndpoint?.browseId;
const pageType = (r) =>
  r?.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig
    ?.pageType;

function bestThumb(thumbs) {
  if (!thumbs?.length) return null;
  const t = thumbs[thumbs.length - 1].url;
  return t;
}

// googleusercontent 썸네일을 원하는 크기로 키운다
function hiResCover(url, size = 1200) {
  if (!url) return null;
  if (/googleusercontent\.com|ggpht\.com/.test(url)) {
    return url.replace(/=w\d+-h\d+[^&]*$/, `=w${size}-h${size}-l90-rj`).replace(/=s\d+[^&]*$/, `=s${size}`);
  }
  // i.ytimg.com 동영상 썸네일은 maxresdefault 시도
  const m = url.match(/i\.ytimg\.com\/vi\/([^/]+)\//);
  if (m) return `https://i.ytimg.com/vi/${m[1]}/maxresdefault.jpg`;
  return url;
}

function parseDuration(str) {
  if (!str) return 0;
  return str
    .split(':')
    .map(Number)
    .reduce((a, b) => a * 60 + b, 0);
}

function shelfItems(searchJson) {
  const tabs = searchJson?.contents?.tabbedSearchResultsRenderer?.tabs || [];
  const sec = tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
  return sec
    .flatMap((x) => (x.musicShelfRenderer || x.itemSectionRenderer)?.contents || [])
    .map((w) => w.musicResponsiveListItemRenderer)
    .filter(Boolean);
}

function parseAlbumItem(it) {
  const id = it.navigationEndpoint?.browseEndpoint?.browseId;
  if (!id || !id.startsWith('MPRE')) return null;
  const sub = flex(it, 1)?.runs || [];
  const artists = sub.filter((r) => pageType(r) === 'MUSIC_PAGE_TYPE_ARTIST' || bid(r)?.startsWith('UC'));
  const yearRun = sub.find((r) => /^\d{4}/.test(r.text));
  return {
    kind: 'album',
    browseId: id,
    title: runsText(flex(it, 0)),
    type: sub[0]?.text || '앨범',
    artist: artists.map((r) => r.text).join(', ') || sub[2]?.text || '',
    artistIds: artists.map(bid).filter(Boolean),
    year: yearRun ? yearRun.text.match(/\d{4}/)[0] : '',
    thumb: bestThumb(it.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails),
  };
}

function parseVideoItem(it) {
  const we = it.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint
    ?.watchEndpoint;
  const videoId = we?.videoId || it.playlistItemData?.videoId;
  if (!videoId) return null;
  const type = we?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType || '';
  if (type.includes('PODCAST')) return null;
  const sub = flex(it, 1)?.runs || [];
  const artists = sub.filter((r) => bid(r)?.startsWith('UC'));
  const durRun = [...sub].reverse().find((r) => /^\d+:\d{2}/.test(r.text));
  return {
    kind: 'track',
    videoId,
    videoType: type,
    title: runsText(flex(it, 0)),
    artist: artists.map((r) => r.text).join(', ') || sub[0]?.text || '',
    album: '',
    duration: parseDuration(durRun?.text),
    thumb: bestThumb(it.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails),
  };
}

// ---------- 공개 API ----------
async function searchAlbums(query) {
  const j = await call('search', { query, params: FILTER.albums });
  return shelfItems(j).map(parseAlbumItem).filter(Boolean);
}

async function searchVideos(query) {
  const j = await call('search', { query, params: FILTER.videos });
  return shelfItems(j).map(parseVideoItem).filter(Boolean);
}

async function getAlbum(browseId) {
  const j = await call('browse', { browseId });
  const two = j.contents?.twoColumnBrowseResultsRenderer;
  const header = two?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.musicResponsiveHeaderRenderer;
  const shelf = two?.secondaryContents?.sectionListRenderer?.contents?.find((c) => c.musicShelfRenderer)
    ?.musicShelfRenderer;
  const albumTitle = runsText(header?.title);
  const albumArtist = (header?.straplineTextOne?.runs || [])
    .filter((r) => r.text.trim() && r.text.trim() !== '•' && r.text.trim() !== '&' && r.text.trim() !== ',')
    .map((r) => r.text)
    .join(', ');
  const albumArtistIds = (header?.straplineTextOne?.runs || []).map(bid).filter((x) => x?.startsWith('UC'));
  const subRuns = header?.subtitle?.runs || [];
  const year = (subRuns.find((r) => /\d{4}/.test(r.text))?.text.match(/\d{4}/) || [''])[0];
  const thumb = bestThumb(header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails);
  const items = (shelf?.contents || []).map((w) => w.musicResponsiveListItemRenderer).filter(Boolean);
  const tracks = items
    .map((r, i) => {
      const videoId = r.playlistItemData?.videoId;
      if (!videoId) return null;
      const artistRuns = (flex(r, 1)?.runs || []).filter((x) => x.text.trim() && x.text.trim() !== '•');
      return {
        kind: 'track',
        videoId,
        videoType: 'MUSIC_VIDEO_TYPE_ATV',
        title: runsText(flex(r, 0)),
        artist: artistRuns.map((x) => x.text).join('') || albumArtist,
        albumArtist,
        album: albumTitle,
        albumBrowseId: browseId,
        trackNo: Number(runsText(r.index)) || i + 1,
        year,
        duration: parseDuration(runsText(fixed(r, 0))),
        thumb,
      };
    })
    .filter(Boolean);
  tracks.forEach((t) => (t.trackCount = tracks.length));
  return {
    kind: 'album',
    browseId,
    title: albumTitle,
    artist: albumArtist,
    artistIds: albumArtistIds,
    type: subRuns[0]?.text || '앨범',
    year,
    thumb,
    cover: hiResCover(thumb),
    tracks,
  };
}

// 영상/노래 ID로 메타데이터와 가사 탭 ID를 가져온다
async function getWatchInfo(videoId, opts) {
  const j = await call('next', { videoId, isAudioOnly: true, enablePersistentPlaylistPanel: true }, opts);
  const tabs =
    j.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs || [];
  const panel = tabs[0]?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer?.contents || [];
  const first = panel
    .map((p) => p.playlistPanelVideoRenderer || p.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer)
    .find((p) => p?.videoId === videoId) || panel[0]?.playlistPanelVideoRenderer;
  const lyricsTab = tabs.find((t) => t.tabRenderer?.endpoint?.browseEndpoint?.browseId?.startsWith('MPLY'));
  const by = first?.longBylineText?.runs || [];
  const artists = by.filter((r) => pageType(r) === 'MUSIC_PAGE_TYPE_ARTIST').map((r) => r.text);
  const albumRun = by.find((r) => pageType(r) === 'MUSIC_PAGE_TYPE_ALBUM');
  const yearRun = by.find((r) => /^\d{4}/.test(r.text.trim()));
  return {
    videoId,
    title: runsText(first?.title),
    artist: artists.join(', '),
    album: albumRun?.text || '',
    albumBrowseId: bid(albumRun) || null,
    year: yearRun ? yearRun.text.match(/\d{4}/)[0] : '',
    duration: parseDuration(runsText(first?.lengthText)),
    thumb: bestThumb(first?.thumbnail?.thumbnails),
    videoType:
      first?.navigationEndpoint?.watchEndpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig
        ?.musicVideoType || '',
    lyricsBrowseId: lyricsTab?.tabRenderer?.endpoint?.browseEndpoint?.browseId || null,
  };
}

// YouTube Music 자체 가사 (로그인 없이 막혀 있으면 null)
async function getYtmLyrics(lyricsBrowseId) {
  if (!lyricsBrowseId) return null;
  const j = await call('browse', { browseId: lyricsBrowseId });
  const sec = j.contents?.sectionListRenderer?.contents || [];
  for (const c of sec) {
    const d = c.musicDescriptionShelfRenderer;
    if (d) {
      const text = runsText(d.description);
      if (text) return { plain: text, synced: null, source: runsText(d.footer) || 'YouTube Music' };
    }
  }
  // 싱크 가사(timedLyricsModel) 형태
  const timed = JSON.stringify(j).match(/"timedLyricsData":(\[.*?\])\s*,\s*"/);
  if (timed) {
    try {
      const arr = JSON.parse(timed[1]);
      const synced = arr.map((l) => ({ t: Number(l.cueRange?.startTimeMilliseconds || 0) / 1000, text: l.lyricLine }));
      return { plain: synced.map((l) => l.text).join('\n'), synced, source: 'YouTube Music' };
    } catch (_) {}
  }
  return null;
}

// ---------- 검색 순위 ----------
const nrm = (s) => (s || '').toLowerCase().replace(/[\s()[\]\-_.,'"!?·’:&/]/g, '');
// 노래방·연주·커버·자동 업로드 계열 앨범은 원곡보다 아래로
const JUNK = /karaoke|カラオケ|歌っちゃ王|노래방|piano|피아노|lullaby|자장가|music box|오르골|instrumental|inst\.|cover|커버|mr\b|kpopstream|8d audio|nightcore|sped up|slowed/i;

function scoreTrack(t, tokens, qn) {
  const title = nrm(t.title);
  const rest = nrm(`${t.artist} ${t.album} ${t.albumArtist || ''}`);
  const total = tokens.reduce((n, k) => n + k.length, 0) || 1;
  let inTitle = 0;
  let inRest = 0;
  for (const k of tokens) {
    if (title.includes(k)) inTitle += k.length;
    else if (rest.includes(k)) inRest += k.length;
  }
  let score = (inTitle / total) * 2 + inRest / total;
  // 검색어에 곡 제목이 통째로 있음 — 'for lovers who hesitate(주저하는 연인들을 위해)'처럼 괄호 안 제목도 인정
  const variants = [t.title, ...[...String(t.title).matchAll(/[(（\[]([^)）\]]+)[)）\]]/g)].map((m) => m[1]), String(t.title).replace(/[(（\[].*$/, '')]
    .map(nrm)
    .filter((v) => v.length >= 2);
  if (variants.some((v) => qn.includes(v))) score += 3;
  t._rel = inTitle + inRest > 0 || variants.some((v) => qn.includes(v));
  if (title === qn) score += 1;
  if (JUNK.test(`${t.album} ${t.albumArtist || ''} ${t.artist}`)) score -= 2.5;
  if (/\(inst\.?\)|instrumental|\bmr\b|sped up|remix/i.test(t.title) && !/inst|mr|remix|sped/i.test(qn)) score -= 1;
  return score;
}

function scoreAlbum(a, tokens) {
  const hay = nrm(`${a.title} ${a.artist}`);
  let s = tokens.filter((k) => hay.includes(k)).length;
  if (JUNK.test(`${a.title} ${a.artist}`)) s -= 2;
  return s;
}

// '월간 시청자 4.16억명' / '1.2M monthly audience' → 숫자
function parseCount(txt) {
  const m = String(txt || '').match(/([\d.,]+)\s*(억|만|천|[KMB])?/i);
  if (!m) return 0;
  const n = parseFloat(m[1].replace(/,/g, ''));
  const mul = { 억: 1e8, 만: 1e4, 천: 1e3, k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return n * mul;
}

// 필터 없는 검색 맨 위의 '대표 아티스트' (원곡자를 가장 잘 가리킨다)
async function topArtist(query) {
  const j = await call('search', { query });
  const aliasesOf = (name) => [name, ...(name.match(/^(.*?)\s*[(（](.*?)[)）]/)?.slice(1) || [])].map(nrm).filter(Boolean);
  // 1) 맨 위 카드가 아티스트면 그것이 가장 정확하다 ('exo' → 엑소, '투어스' → TWS)
  const sec = j?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
  const card = sec.find((x) => x.musicCardShelfRenderer)?.musicCardShelfRenderer;
  const cr = card?.title?.runs?.[0];
  if (cr && pageType(cr) === 'MUSIC_PAGE_TYPE_ARTIST') {
    const sub = runsText(card.subtitle);
    return { name: cr.text, browseId: bid(cr), listeners: parseCount(sub.split('•').pop()), aliases: aliasesOf(cr.text) };
  }
  // 2) 아니면 결과 목록의 첫 아티스트
  for (const it of shelfItems(j)) {
    const id = it.navigationEndpoint?.browseEndpoint?.browseId || '';
    if (!id.startsWith('UC')) continue;
    const sub = runsText(flex(it, 1));
    if (!/아티스트|artist/i.test(sub)) continue;
    const listeners = parseCount(sub.split('•').pop());
    const name = runsText(flex(it, 0));
    // '아일릿 (ILLIT)' → ['아일릿', 'ILLIT']
    return { name, browseId: id, listeners, aliases: aliasesOf(name) };
  }
  return null;
}

// 검색: 대표 아티스트 + 앨범 + 앨범 트랙 중 질의와 맞는 곡
async function search(query, { retried = false } = {}) {
  const errors = [];
  const [albums0, artist] = await Promise.all([
    searchAlbums(query).catch((e) => (errors.push(e), [])),
    topArtist(query).catch(() => null),
  ]);
  // 세션 만료·일시 오류: 세션을 새로 받아 한 번 더
  if (!albums0.length && !retried) {
    session = null;
    return search(query, { retried: true });
  }
  if (!albums0.length && errors.length) throw errors[0];

  const tokens = query.split(/\s+/).map(nrm).filter(Boolean);
  const qn = nrm(query);
  const main = artist && artist.listeners >= 1e5 ? artist : null;
  const isMain = (name, ids) => {
    if (!main) return false;
    if (ids?.length) return ids.includes(main.browseId);
    const n = nrm(String(name || '').split(/,| 및 | & /)[0]);
    return main.aliases.includes(n);
  };

  // 원곡자 이름을 붙여 앨범을 한 번 더 찾는다 (커버·노래방에 묻히는 원곡 앨범 확보)
  let albums = albums0;
  if (main) {
    const restQ = tokens.filter((k) => !main.aliases.some((a) => a.includes(k) || k.includes(a))).join(' ');
    const extra = await searchAlbums(`${main.name} ${restQ || query}`).catch(() => []);
    const seenA = new Set(albums.map((a) => a.browseId));
    albums = [...albums, ...extra.filter((a) => !seenA.has(a.browseId))];
  }

  // 아티스트 비중: 결과 앨범 중 같은 아티스트가 몇 장인지
  const firstArtist = (s) => nrm(String(s || '').split(/,| 및 | & /)[0]);
  const authority = new Map();
  albums.forEach((a) => {
    if (JUNK.test(`${a.title} ${a.artist}`)) return;
    const k = firstArtist(a.artist);
    authority.set(k, (authority.get(k) || 0) + 1);
  });

  // 펼칠 앨범: 원곡자 앨범 중 검색어와 맞는 것 3개 + YouTube 상위 4개 + 검색어와 맞는 앨범 2개
  const pick = [];
  const add = (a) => a && !pick.includes(a) && pick.push(a);
  albums
    .filter((a) => isMain(a.artist, a.artistIds))
    .map((a, i) => ({ a, i, s: scoreAlbum(a, tokens) }))
    .sort((x, y) => y.s - x.s || x.i - y.i)
    .slice(0, 5)
    .forEach((x) => add(x.a));
  albums0.slice(0, 4).forEach(add);
  albums
    .map((a, i) => ({ a, i, s: scoreAlbum(a, tokens) }))
    .filter((x) => x.s > 0 && !pick.includes(x.a))
    .sort((x, y) => y.s - x.s || x.i - y.i)
    .slice(0, 2)
    .forEach((x) => add(x.a));

  const rankOf = new Map(albums0.map((a, i) => [a.browseId, i]));
  const top = await Promise.all(pick.map((a) => getAlbum(a.browseId).catch(() => null)));
  const tracks = [];
  const seen = new Set();
  for (const al of top.filter(Boolean)) {
    const rank = rankOf.get(al.browseId) ?? 10;
    const auth = Math.min(3, authority.get(firstArtist(al.artist)) || 0);
    for (const t of al.tracks) {
      if (seen.has(t.videoId)) continue;
      seen.add(t.videoId);
      t.score =
        scoreTrack(t, tokens, qn) +
        auth * 0.4 +
        Math.max(0, 4 - rank) * 0.15 +
        (t._rel && isMain(al.artist, al.artistIds) ? 3 : 0); // 관련 있는 곡일 때만 원곡자 가산
      tracks.push(t);
    }
  }
  tracks.sort((a, b) => b.score - a.score);
  // 앨범 목록도 원곡자 앨범을 앞으로
  const albumsOut = [
    ...albums.filter((a) => isMain(a.artist, a.artistIds)),
    ...albums.filter((a) => !isMain(a.artist, a.artistIds)),
  ].slice(0, 24);
  tracks.forEach((t) => delete t._rel);
  return { albums: albumsOut, tracks: tracks.slice(0, 40), videos: [], artist: main };
}

function parseVideoId(input) {
  const s = String(input).trim();
  const m =
    s.match(/[?&]v=([\w-]{11})/) || s.match(/youtu\.be\/([\w-]{11})/) || s.match(/\/shorts\/([\w-]{11})/) ||
    s.match(/^([\w-]{11})$/);
  return m ? m[1] : null;
}

function parseAlbumId(input) {
  const s = String(input).trim();
  const m = s.match(/browse\/(MPRE[\w-]+)/);
  if (m) return { browseId: m[1] };
  const pl = s.match(/[?&]list=(OLAK5uy_[\w-]+)/);
  if (pl) return { playlistId: pl[1] };
  return null;
}

// OLAK5uy_ 재생목록 → 앨범 browseId
async function albumIdFromPlaylist(playlistId) {
  const j = await call('browse', { browseId: 'VL' + playlistId });
  const m = JSON.stringify(j).match(/"(MPREb_[\w-]+)"/);
  return m ? m[1] : null;
}

module.exports = {
  search,
  searchAlbums,
  searchVideos,
  getAlbum,
  getWatchInfo,
  getYtmLyrics,
  hiResCover,
  parseVideoId,
  parseAlbumId,
  albumIdFromPlaylist,
};
