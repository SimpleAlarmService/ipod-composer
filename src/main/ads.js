// Apple 레전드 광고: 목록, 받기, 아이팟용 영상 변환
// 받은 영상은 ~/Movies/iPod Composer/Apple 광고/ 에 H.264 Baseline + AAC (.m4v)로 저장한다.
// 아이팟 비디오·클래식·나노 3세대 이상이 재생할 수 있는 규격: 640x480 이하, Baseline 3.0, 30fps, AAC-LC.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// videoId가 사라졌을 때를 대비해 검색어도 함께 둔다
const CATALOG = [
  { id: '1984', year: 1984, title: '1984', product: 'Macintosh', by: 'Ridley Scott 감독',
    desc: '회색 군중과 스크린 속 독재자, 그리고 해머를 던지는 한 명의 달리기 선수. 슈퍼볼 중계에 단 한 번 방영되고 광고의 역사를 바꿨습니다.',
    videoId: 'VtvjbmoDx-I', query: 'Apple 1984 Macintosh commercial' },
  { id: 'think-different', year: 1997, title: "Here's to the Crazy Ones", product: 'Think Different',
    desc: '아인슈타인, 간디, 피카소. 세상을 바꾼 "미친 사람들"에게 바치는 헌사. 돌아온 스티브 잡스가 Apple의 정체성을 다시 세운 캠페인입니다.',
    videoId: '5sMBhDv4sik', query: "Apple Think Different Here's to the crazy ones" },
  { id: 'first-ipod', year: 2001, title: '첫 번째 iPod 광고', product: 'iPod', by: 'Propellerheads - Take California',
    desc: '방 안에서 음악에 맞춰 춤추는 한 사람. "주머니 속 1,000곡"이 처음 세상에 나온 순간입니다.',
    videoId: 'mo-2aDs8160', query: 'first iPod commercial 2001 Take California' },
  { id: 'silhouette-hey-mama', year: 2003, title: 'Silhouette — Hey Mama', product: 'iPod', by: 'The Black Eyed Peas',
    desc: '형광색 배경, 검은 실루엣, 그리고 하얀 이어폰 줄. 지금도 아이팟 하면 떠오르는 그 장면입니다.',
    videoId: 'nZpavpd5Msw', query: 'iPod silhouette ad Hey Mama Black Eyed Peas' },
  { id: 'vertigo', year: 2004, title: 'iPod + U2 — Vertigo', product: 'iPod U2 Special Edition', by: 'U2',
    desc: '"Uno, dos, tres, catorce!" 실루엣 광고에 밴드가 직접 등장한, 가장 시끄럽고 신나는 30초.',
    videoId: 'vflb4nBhb9M', query: 'U2 iPod ad Vertigo' },
  { id: 'get-a-mac', year: 2006, title: "Get a Mac — \"Hello, I'm a Mac\"", product: 'Mac',
    desc: '하얀 배경 위의 두 사람. 캐주얼한 Mac과 정장 차림의 PC가 주고받는 대화로 4년 동안 이어진 시리즈의 시작입니다.',
    videoId: '48jlm6QSU4k', query: "Get a Mac Better Hello I'm a Mac" },
  { id: 'iphone-hello', year: 2007, title: 'Hello', product: 'iPhone',
    desc: '영화 속 배우들이 차례로 전화를 받으며 "Hello"라고 말합니다. 2007년 아카데미 시상식에서 첫 iPhone을 알린 몽타주입니다.',
    videoId: 'mmiWTKZzBLY', query: 'Apple Hello iPhone commercial Oscars 2007' },
  { id: 'nano-1234', year: 2007, title: '1234', product: 'iPod nano', by: 'Feist',
    desc: '알록달록한 나노들이 노래에 맞춰 춤추듯 지나갑니다. 무명에 가깝던 노래를 차트에 올려놓은 광고입니다.',
    videoId: 'sijSh4tMPVg', query: 'Feist 1234 iPod nano commercial' },
  { id: 'macbook-air', year: 2008, title: 'Envelope', product: 'MacBook Air',
    desc: '서류 봉투에서 노트북을 꺼내는 손. 설명 한 줄 없이 "가장 얇다"는 걸 보여 준 짧은 광고입니다.',
    videoId: '3Ywa_EynjC8', query: 'MacBook Air envelope commercial 2008' },
  { id: 'welcome-home', year: 2018, title: 'Welcome Home', product: 'HomePod', by: 'Spike Jonze 감독 · FKA twigs',
    desc: '지친 하루 끝, 음악이 흐르자 좁은 방이 늘어나고 벽이 춤추기 시작합니다. 4분짜리 단편 영화 같은 광고입니다.',
    videoId: 'Xwc22EK8qE0', query: 'Apple HomePod Welcome Home Spike Jonze' },
];

const safe = (s) => String(s).replace(/[\/\\:*?"<>|]/g, '_').trim();

// 받기·변환은 videos.js(Videos)가 맡는다. 여기서는 광고 목록과 파일 위치만 관리한다.
class Ads extends EventEmitter {
  constructor(videos) {
    super();
    this.videos = videos;
    videos.on('update', (u) => {
      if (!u.key.startsWith('ad:')) return;
      this.emit('update', { id: u.key.slice(3), state: u.state, progress: u.progress, error: u.error });
    });
  }

  fileFor(ad) {
    return path.join(this.videos.getDir(), 'Apple 광고', `${ad.year} - ${safe(ad.title)}.m4v`);
  }

  list() {
    return CATALOG.map((ad) => {
      const file = this.fileFor(ad);
      return {
        ...ad,
        thumb: `https://i.ytimg.com/vi/${ad.videoId}/hqdefault.jpg`,
        file: fs.existsSync(file) ? file : null,
        job: this.videos.jobInfo(`ad:${ad.id}`),
      };
    });
  }

  async download(id) {
    const ad = CATALOG.find((a) => a.id === id);
    if (!ad) throw new Error('알 수 없는 광고');
    const out = await this.videos.download({
      key: `ad:${ad.id}`,
      url: `https://www.youtube.com/watch?v=${ad.videoId}`,
      fallbackUrl: `ytsearch1:${ad.query}`, // 영상이 내려갔으면 검색어로 다시 찾는다
      out: this.fileFor(ad),
      tags: {
        title: ad.title,
        artist: 'Apple',
        album: 'Apple 레전드 광고',
        date: String(ad.year),
        comment: `${ad.product}${ad.by ? ' · ' + ad.by : ''} — https://www.youtube.com/watch?v=${ad.videoId}`,
      },
    });
    this.emit('done', out);
    return out;
  }
}

module.exports = { Ads, CATALOG };
