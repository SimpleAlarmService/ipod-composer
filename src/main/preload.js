const { contextBridge, ipcRenderer } = require('electron');
const { pathToFileURL } = require('url');

const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch) => (cb) => {
  const h = (_e, d) => cb(d);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('composer', {
  deps: inv('deps'),
  settings: { get: inv('settings:get'), set: inv('settings:set'), pickDir: inv('settings:pickDir') },
  ytm: { search: inv('ytm:search'), album: inv('ytm:album'), resolve: inv('ytm:resolve') },
  dl: {
    enqueue: inv('dl:enqueue'),
    cancel: inv('dl:cancel'),
    list: inv('dl:list'),
    clear: inv('dl:clear'),
    onUpdate: on('dl:update'),
    onCleared: on('dl:cleared'),
  },
  library: {
    list: inv('library:list'),
    cover: inv('library:cover'),
    lyrics: inv('library:lyrics'),
    reveal: inv('library:reveal'),
    trash: inv('library:trash'),
    fixLyrics: inv('library:fixLyrics'),
    remaster: inv('library:remaster'),
    onFixProgress: on('library:fixProgress'),
    onChanged: on('library:changed'),
  },
  ios: { devices: inv('ios:devices'), onDevices: on('ios:devices') },
  music: { add: inv('music:add'), onAdded: on('music:added'), onError: on('music:error') },
  ipod: {
    devices: inv('ipod:devices'),
    scan: inv('ipod:scan'),
    library: inv('ipod:library'),
    plan: inv('ipod:plan'),
    sync: inv('ipod:sync'),
    cancel: inv('ipod:cancel'),
    eject: inv('ipod:eject'),
    models: inv('ipod:models'),
    createVirtual: inv('ipod:createVirtual'),
    removeVirtual: inv('ipod:removeVirtual'),
    onDevices: on('ipod:devices'),
    onProgress: on('ipod:progress'),
    onState: on('ipod:state'),
    onError: on('ipod:error'),
  },
  tools: { state: inv('tools:state'), check: inv('tools:check'), install: inv('tools:install'), onState: on('tools:state') },
  backendStatus: inv('backend:status'),
  openExternal: inv('open:external'),
  fileUrl: (p) => pathToFileURL(p).href,
  platform: process.platform,
});
