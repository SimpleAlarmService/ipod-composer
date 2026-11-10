// Apple 레전드 광고: 목록, 받기, 아이팟용 영상 변환
// 받은 영상은 ~/Movies/iPod Composer/Apple 광고/ 에 H.264 Baseline + AAC (.m4v)로 저장한다.
// 아이팟 비디오·클래식·나노 3세대 이상이 재생할 수 있는 규격: 640x480 이하, Baseline 3.0, 30fps, AAC-LC.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// 목록은 ads_catalog.json (아티팩트 'Apple 레전드 광고 아카이브'와 같은 데이터). videoId가 사라지면 query로 다시 찾는다
const CATALOG = require('./ads_catalog.json').slice().sort((x, y) => x.year - y.year);

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
