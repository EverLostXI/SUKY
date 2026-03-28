/**
 * audioEngine.js — Web Audio API 无缝播放引擎
 *
 * 核心策略（Gapless）：
 *   - 使用 AudioContext 的精确时间线调度多个 BufferSourceNode
 *   - 当前曲目播放时，提前 decode 下一首并 schedule 到精确结束时刻
 *   - seek 操作：清除全部 source，从新位置重新调度
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.gainNode = null;

    this.albumData = null;
    this.currentTrackIndex = -1;

    // 已调度的 source 列表 [{source, trackIndex, startCtxTime, trackOffset}]
    this._scheduled = [];

    // 暂停时保存的专辑时间
    this._pausedAt = 0;
    this.isPlaying = false;

    // 已解码的 buffer 缓存
    this._buffers = {};

    // 回调
    this.onTimeUpdate = null;   // (albumTime, trackIndex) => void
    this.onTrackChange = null;  // (trackIndex) => void
    this.onEnded = null;        // () => void

    this._rafId = null;
    this._trackEndTimer = null;
    this._playSeq = 0;
  }

  /** 懒初始化 AudioContext（必须在用户手势后调用） */
  _ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.gainNode = this.ctx.createGain();
      this.gainNode.connect(this.ctx.destination);
    }
  }

  /** 加载专辑数据（不自动开始播放） */
  loadAlbum(albumData) {
    this._stop();
    this.albumData = albumData;
    this.currentTrackIndex = -1;
    this._pausedAt = 0;
    this._buffers = {};
  }

  /** fetch + decode 某首曲目的 buffer（带缓存） */
  async _fetchBuffer(trackIndex) {
    const url = this.albumData.tracks[trackIndex].file_url;
    if (this._buffers[url]) return this._buffers[url];
    const res = await fetch(url);
    const ab = await res.arrayBuffer();
    const buf = await this.ctx.decodeAudioData(ab);
    this._buffers[url] = buf;
    return buf;
  }

  /**
   * 从指定专辑时间开始播放
   * @param {number} albumTime
   */
  async seekAndPlay(albumTime) {
    const seq = ++this._playSeq;
    this._ensureCtx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (this._playSeq !== seq) return;

    this._stop();
    this.isPlaying = true;

    const tracks = this.albumData.tracks;
    // 找到目标曲目
    let ti = tracks.length - 1;
    for (let i = 0; i < tracks.length; i++) {
      const end = tracks[i].start_time + tracks[i].duration;
      if (albumTime < end || i === tracks.length - 1) { ti = i; break; }
    }
    const offset = albumTime - tracks[ti].start_time;

    await this._scheduleFrom(ti, offset, this.ctx.currentTime, seq);
    if (this._playSeq !== seq) return;
    this._startRAF();
  }

  /** 从 trackIndex + trackOffset 开始，向后链式调度 */
  async _scheduleFrom(trackIndex, trackOffset, ctxStartTime, seq) {
    const tracks = this.albumData.tracks;
    let when = ctxStartTime;
    let ti = trackIndex;
    let offset = trackOffset;

    // 调度当前曲目 + 预加载下一首（只提前调度 2 首以控制内存）
    const MAX_AHEAD = 2;
    for (let i = 0; i < MAX_AHEAD && ti < tracks.length; i++) {
      const buf = await this._fetchBuffer(ti);
      if (seq !== undefined && this._playSeq !== seq) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gainNode);

      const playDuration = buf.duration - offset;
      src.start(when, offset);

      const entry = { source: src, trackIndex: ti, startCtxTime: when, trackOffset: offset };
      this._scheduled.push(entry);

      // 当这首结束时，调度再下一首
      const tiCapture = ti;
      const whenCapture = when + playDuration;
      src.addEventListener('ended', () => this._onSourceEnded(tiCapture, whenCapture));

      when += playDuration;
      ti++;
      offset = 0;
    }

    // 更新当前曲目索引
    this.currentTrackIndex = trackIndex;
    this.onTrackChange?.(trackIndex);
  }

  /** 某首 source 播放结束时的回调 */
  async _onSourceEnded(endedTrackIndex, nextStartCtxTime) {
    if (!this.isPlaying) return;

    const nextTrackIndex = endedTrackIndex + 1;
    const tracks = this.albumData.tracks;

    if (nextTrackIndex >= tracks.length) {
      // 专辑结束
      this.isPlaying = false;
      this._pausedAt = this.albumData.total_duration;
      this._stopRAF();
      this.onEnded?.();
      return;
    }

    // 检查是否已经调度过这首
    const alreadyScheduled = this._scheduled.some(e => e.trackIndex === nextTrackIndex);
    if (alreadyScheduled) {
      // 更新 currentTrackIndex
      this.currentTrackIndex = nextTrackIndex;
      this.onTrackChange?.(nextTrackIndex);
      // 尝试预加载 +1
      const lookAhead = nextTrackIndex + 1;
      if (lookAhead < tracks.length) {
        const alreadyNext = this._scheduled.some(e => e.trackIndex === lookAhead);
        if (!alreadyNext) {
          // 调度 +1
          const prevEntry = this._scheduled.find(e => e.trackIndex === nextTrackIndex);
          if (prevEntry) {
            const buf = prevEntry.source.buffer;
            const startNext = prevEntry.startCtxTime + buf.duration - prevEntry.trackOffset;
            await this._scheduleOneMore(lookAhead, startNext);
          }
        }
      }
    }
  }

  async _scheduleOneMore(trackIndex, ctxWhen) {
    if (trackIndex >= this.albumData.tracks.length) return;
    const buf = await this._fetchBuffer(trackIndex);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gainNode);
    src.start(ctxWhen, 0);
    const entry = { source: src, trackIndex, startCtxTime: ctxWhen, trackOffset: 0 };
    this._scheduled.push(entry);
    src.addEventListener('ended', () => this._onSourceEnded(trackIndex, ctxWhen + buf.duration));
  }

  /** 停止所有已调度的 source */
  _stop() {
    this._scheduled.forEach(({ source }) => {
      try {
        source.onended = null;
        source.stop();
        source.disconnect();
      } catch (_) {}
    });
    this._scheduled = [];
    this._stopRAF();
  }

  /** 暂停 */
  pause() {
    ++this._playSeq;
    if (!this.isPlaying) return;
    this._pausedAt = this._getCurrentAlbumTime();
    this.isPlaying = false;
    this._stop();
  }

  /** 继续播放 */
  async resume() {
    if (this.isPlaying) return;
    await this.seekAndPlay(this._pausedAt);
  }

  /** 跳到下一首 */
  async nextTrack() {
    if (!this.albumData) return;
    const next = this.currentTrackIndex + 1;
    if (next >= this.albumData.tracks.length) return;
    const albumTime = this.albumData.tracks[next].start_time;
    await this.seekAndPlay(albumTime);
  }

  /** 跳到上一首（3秒内返回上一首，否则本首重头） */
  async prevTrack() {
    if (!this.albumData) return;
    const trackTime = this._getCurrentAlbumTime() - this.albumData.tracks[this.currentTrackIndex].start_time;
    if (trackTime > 3 || this.currentTrackIndex === 0) {
      await this.seekAndPlay(this.albumData.tracks[this.currentTrackIndex].start_time);
    } else {
      const prev = this.currentTrackIndex - 1;
      await this.seekAndPlay(this.albumData.tracks[prev].start_time);
    }
  }

  setVolume(v) {
    if (this.gainNode) this.gainNode.gain.value = Math.max(0, Math.min(1, v));
  }

  /** 计算当前专辑时间 */
  _getCurrentAlbumTime() {
    if (!this.albumData || this.currentTrackIndex < 0) return 0;
    if (!this.isPlaying) return this._pausedAt;

    // 找到当前正在播放的 source
    const now = this.ctx.currentTime;
    // 从已调度的 source 中找出正在播放的那个（startCtxTime <= now）
    let entry = null;
    for (let i = this._scheduled.length - 1; i >= 0; i--) {
      if (this._scheduled[i].startCtxTime <= now) {
        entry = this._scheduled[i];
        break;
      }
    }
    if (!entry) return this._pausedAt;

    const track = this.albumData.tracks[entry.trackIndex];
    const elapsed = now - entry.startCtxTime + entry.trackOffset;
    return Math.min(track.start_time + elapsed, this.albumData.total_duration);
  }

  /** requestAnimationFrame 时间更新循环 */
  _startRAF() {
    const tick = () => {
      if (!this.isPlaying) return;
      const t = this._getCurrentAlbumTime();
      // 同步 currentTrackIndex
      const tracks = this.albumData.tracks;
      for (let i = tracks.length - 1; i >= 0; i--) {
        if (t >= tracks[i].start_time) {
          if (this.currentTrackIndex !== i) {
            this.currentTrackIndex = i;
            this.onTrackChange?.(i);
          }
          break;
        }
      }
      this.onTimeUpdate?.(t, this.currentTrackIndex);
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _stopRAF() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /** 当前是否有专辑加载 */
  get hasAlbum() { return !!this.albumData; }

  get currentAlbumTime() { return this._getCurrentAlbumTime(); }
}

export const audioEngine = new AudioEngine();
