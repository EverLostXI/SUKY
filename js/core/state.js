/**
 * state.js — 全局状态管理（轻量 pub/sub）
 */
const state = {
  view: 'main',          // 'main' | 'playback'
  albums: [],            // albums.json 列表
  currentAlbum: null,    // 当前加载的专辑详情
  isPlaying: false,
  currentTrackIndex: 0,
  currentAlbumTime: 0,   // 在整张专辑上的当前秒数
  coverFlowIndex: 0,     // cover flow 中心专辑的索引
  volume: 0.8,
  transitioning: false,    // 是否正在进行界面切换动画

  _subs: {},

  /** 设置值并通知订阅者 */
  set(key, value) {
    const old = this[key];
    if (old === value) return;
    this[key] = value;
    (this._subs[key] || []).forEach(fn => fn(value, old));
  },

  /** 订阅某个 key 的变化，返回取消订阅函数 */
  on(key, fn) {
    if (!this._subs[key]) this._subs[key] = [];
    this._subs[key].push(fn);
    return () => {
      this._subs[key] = this._subs[key].filter(f => f !== fn);
    };
  },
};

export default state;
