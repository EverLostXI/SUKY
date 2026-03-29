import { parseBuffer, pLimit } from '../vendor/deps.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.ogg', '.wav', '.aac']);
const METADATA_VERSION = 1;
const HEADER_SLICE_BYTES = 256 * 1024;
const SCAN_CONCURRENCY = 8;
const INTERNAL_DIR = '.suky';
const COVERS_DIR = 'covers';
const METADATA_FILE = 'metadata.json';

function createEmptyMetadata() {
  return {
    version: METADATA_VERSION,
    scannedAt: new Date().toISOString(),
    albums: {}
  };
}

export async function quickScanLibrary(rootHandle, { onProgress } = {}) {
  return scanLibrary(rootHandle, { onProgress, rebuild: false });
}

export async function rebuildLibrary(rootHandle, { onProgress } = {}) {
  return scanLibrary(rootHandle, { onProgress, rebuild: true });
}

async function scanLibrary(rootHandle, { onProgress, rebuild }) {
  await ensureInternalStorage(rootHandle);
  const rootEntries = await collectLibraryEntries(rootHandle);
  const metadata = rebuild
    ? await resetInternalStorage(rootHandle)
    : await loadStoredMetadata(rootHandle);

  const currentPaths = new Set(rootEntries.paths.keys());
  const knownPaths = new Set(getAllKnownPaths(metadata));

  const addedPaths = [...currentPaths].filter(path => !knownPaths.has(path));
  const deletedPaths = [...knownPaths].filter(path => !currentPaths.has(path));

  onProgress?.(0, addedPaths.length);

  applyDeletedTracks(metadata, deletedPaths);

  if (addedPaths.length) {
    await applyAddedTracks(rootHandle, metadata, rootEntries, addedPaths, onProgress);
  }

  await repairAlbumsWithMissingCover(rootHandle, metadata, rootEntries);

  metadata.version = METADATA_VERSION;
  metadata.scannedAt = new Date().toISOString();

  await persistMetadata(rootHandle, metadata);
  return metadata;
}

async function collectLibraryEntries(rootHandle) {
  const albums = new Map();
  const paths = new Map();

  for await (const [name, handle] of rootHandle.entries()) {
    if (handle.kind !== 'directory' || name === INTERNAL_DIR) continue;

    const files = [];
    for await (const [fileName, childHandle] of handle.entries()) {
      if (childHandle.kind !== 'file') continue;
      if (!isAudioFile(fileName)) continue;

      const entry = {
        albumDirName: name,
        fileName,
        relativePath: `${name}/${fileName}`,
        fileHandle: childHandle
      };
      files.push(entry);
      paths.set(entry.relativePath, entry);
    }

    files.sort((a, b) => compareFileNames(a.fileName, b.fileName));
    if (files.length) {
      albums.set(name, files);
    }
  }

  return { albums, paths };
}

function getAllKnownPaths(metadata) {
  return Object.values(metadata.albums || {}).flatMap(album =>
    Array.isArray(album?.tracks) ? album.tracks.map(track => track.path).filter(Boolean) : []
  );
}

function applyDeletedTracks(metadata, deletedPaths) {
  if (!deletedPaths.length) return;

  const dirtyAlbums = new Set();

  for (const path of deletedPaths) {
    const albumKey = getAlbumKeyFromPath(path);
    const album = metadata.albums?.[albumKey];
    if (!album?.tracks?.length) continue;

    const nextTracks = album.tracks.filter(track => track.path !== path);
    if (nextTracks.length === album.tracks.length) continue;

    if (!nextTracks.length) {
      delete metadata.albums[albumKey];
      continue;
    }

    album.tracks = nextTracks;
    dirtyAlbums.add(albumKey);
  }

  for (const albumKey of dirtyAlbums) {
    const album = metadata.albums[albumKey];
    if (album) recalculateAlbum(album);
  }
}

async function applyAddedTracks(rootHandle, metadata, rootEntries, addedPaths, onProgress) {
  const limit = pLimit(SCAN_CONCURRENCY);
  const addedByAlbum = new Map();
  let done = 0;

  const reportProgress = () => {
    done += 1;
    onProgress?.(done, addedPaths.length);
  };

  for (const path of addedPaths) {
    const entry = rootEntries.paths.get(path);
    if (!entry) continue;

    const list = addedByAlbum.get(entry.albumDirName) || [];
    list.push(entry);
    addedByAlbum.set(entry.albumDirName, list);
  }

  const tasks = [];
  for (const [albumDirName, entries] of addedByAlbum) {
    const existingAlbum = metadata.albums[albumDirName];
    if (existingAlbum) {
      tasks.push(
        addTracksToExistingAlbum(existingAlbum, entries, limit, reportProgress)
      );
    } else {
      tasks.push(
        buildNewAlbumEntry(rootHandle, albumDirName, entries, limit, reportProgress).then(album => {
          metadata.albums[albumDirName] = album;
        })
      );
    }
  }

  await Promise.all(tasks);
}

async function addTracksToExistingAlbum(album, entries, limit, reportProgress) {
  const parsedTracks = await Promise.all(
    entries.map(entry => limit(async () => {
      const track = await readTrackMetadata(entry);
      reportProgress();
      return track;
    }))
  );

  album.tracks.push(...parsedTracks);
  recalculateAlbum(album);
}

async function buildNewAlbumEntry(rootHandle, albumDirName, entries, limit, reportProgress) {
  const orderedEntries = [...entries].sort((a, b) => compareFileNames(a.fileName, b.fileName));
  const [firstEntry, ...remainingEntries] = orderedEntries;
  const albumId = await createAlbumId(albumDirName);

  const firstParsed = await limit(async () => {
    const parsed = await readTrackAndAlbumSeed(firstEntry);
    reportProgress();
    return parsed;
  });

  const remainingTracks = await Promise.all(
    remainingEntries.map(entry => limit(async () => {
      const track = await readTrackMetadata(entry);
      reportProgress();
      return track;
    }))
  );

  const albumTitle = normalizeText(firstParsed.albumTitle) || albumDirName;
  const tracks = [firstParsed.track, ...remainingTracks];
  const albumArtist =
    normalizeText(firstParsed.albumArtist) ||
    normalizeText(firstParsed.track.artist) ||
    'Unknown Artist';

  const coverFile = await persistAlbumCover(rootHandle, firstParsed.picture, albumId, firstEntry.albumDirName);
  const album = {
    id: albumId,
    title: albumTitle,
    artist: albumArtist,
    coverFile,
    total_duration: 0,
    tracks
  };

  recalculateAlbum(album);
  return album;
}

async function readTrackAndAlbumSeed(entry) {
  const file = await entry.fileHandle.getFile();
  const metadata = await parseAudioMetadata(file, { fullFile: true });
  const track = await buildTrackFromMetadata(file, entry, metadata);

  return {
    track,
    albumTitle: metadata.common?.album,
    albumArtist:
      metadata.common?.albumartist ||
      metadata.common?.artist ||
      track.artist,
    picture: metadata.common?.picture?.[0] || null
  };
}

async function readTrackMetadata(entry) {
  const file = await entry.fileHandle.getFile();
  const metadata = await parseAudioMetadata(file);
  return buildTrackFromMetadata(file, entry, metadata);
}

async function buildTrackFromMetadata(file, entry, metadata) {
  const inferred = inferTrackInfoFromFileName(entry.fileName);
  const durationSeconds = await resolveDurationSeconds(file, metadata.format?.duration);
  const trackNumber = normalizeTrackNumber(metadata.common?.track?.no) || inferred.track_number;
  const discNumber = normalizeTrackNumber(metadata.common?.disk?.no);

  return {
    path: entry.relativePath,
    track_number: trackNumber,
    disc_number: discNumber,
    title: normalizeText(metadata.common?.title) || inferred.title || stripExtension(entry.fileName),
    artist:
      normalizeText(metadata.common?.artist) ||
      normalizeText(metadata.common?.albumartist) ||
      inferred.artist ||
      'Unknown Artist',
    duration: millisecondsToSeconds(secondsToMilliseconds(durationSeconds)),
    start_time: 0
  };
}

async function parseAudioMetadata(file, { fullFile = false } = {}) {
  const fileInfo = {
    mimeType: file.type || getMimeTypeFromName(file.name),
    size: file.size,
    path: file.name
  };

  if (fullFile) {
    try {
      return await parseBuffer(new Uint8Array(await file.arrayBuffer()), fileInfo, { duration: true });
    } catch (error) {
      console.warn(`解析完整音频 metadata 失败: ${file.name}`, error);
      return {
        format: {},
        common: {}
      };
    }
  }

  const parseOptions = { duration: true };
  const headSliceBlob = file.slice(0, Math.min(file.size, HEADER_SLICE_BYTES), file.type);

  try {
    const metadata = await parseBuffer(
      new Uint8Array(await headSliceBlob.arrayBuffer()),
      {
        ...fileInfo,
        size: headSliceBlob.size
      },
      parseOptions
    );
    if (hasUsableMetadata(metadata)) return metadata;
  } catch (_) {
    // Fall back to the full file below.
  }

  try {
    return await parseBuffer(new Uint8Array(await file.arrayBuffer()), fileInfo, parseOptions);
  } catch (error) {
    console.warn(`解析音频 metadata 失败: ${file.name}`, error);
    return {
      format: {},
      common: {}
    };
  }
}

async function repairAlbumsWithMissingCover(rootHandle, metadata, rootEntries) {
  const limit = pLimit(4);
  const tasks = [];

  for (const [albumDirName, album] of Object.entries(metadata.albums || {})) {
    if (album?.coverFile) continue;

    const entries = rootEntries.albums.get(albumDirName);
    const firstEntry = entries?.[0];
    if (!firstEntry) continue;

    tasks.push(limit(async () => {
      const seed = await readTrackAndAlbumSeed(firstEntry);
      const coverFile = await persistAlbumCover(rootHandle, seed.picture, album.id, albumDirName);

      if (coverFile) {
        album.coverFile = coverFile;
      }

      if (!normalizeText(album.title)) {
        album.title = normalizeText(seed.albumTitle) || albumDirName;
      }

      if (!normalizeText(album.artist) || album.artist === 'Unknown Artist') {
        album.artist =
          normalizeText(seed.albumArtist) ||
          normalizeText(seed.track.artist) ||
          album.artist ||
          'Unknown Artist';
      }
    }));
  }

  await Promise.all(tasks);
}

async function ensureInternalStorage(rootHandle) {
  const sukyDir = await rootHandle.getDirectoryHandle(INTERNAL_DIR, { create: true });
  await sukyDir.getDirectoryHandle(COVERS_DIR, { create: true });
}

function hasUsableMetadata(metadata) {
  if (!metadata) return false;
  if (Number.isFinite(metadata.format?.duration) && metadata.format.duration > 0) return true;
  if (metadata.common?.title || metadata.common?.artist || metadata.common?.album) return true;
  return false;
}

async function resolveDurationSeconds(file, parsedDuration) {
  if (Number.isFinite(parsedDuration) && parsedDuration > 0) {
    return parsedDuration;
  }

  const objectUrl = URL.createObjectURL(file);

  try {
    const duration = await new Promise((resolve, reject) => {
      const audio = document.createElement('audio');
      audio.preload = 'metadata';

      audio.onloadedmetadata = () => {
        const value = audio.duration;
        audio.src = '';
        if (Number.isFinite(value) && value > 0) {
          resolve(value);
          return;
        }
        reject(new Error('音频时长不可用'));
      };

      audio.onerror = () => {
        audio.src = '';
        reject(new Error(`读取音频时长失败: ${file.name}`));
      };

      audio.src = objectUrl;
    });

    return duration;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function recalculateAlbum(album) {
  album.tracks.sort(compareTracks);

  let totalMs = 0;
  for (const track of album.tracks) {
    track.start_time = millisecondsToSeconds(totalMs);
    const durationMs = secondsToMilliseconds(track.duration || 0);
    track.duration = millisecondsToSeconds(durationMs);
    totalMs += durationMs;
  }

  album.total_duration = millisecondsToSeconds(totalMs);
}

function compareTracks(a, b) {
  const aDisc = normalizeTrackNumber(a.disc_number);
  const bDisc = normalizeTrackNumber(b.disc_number);
  const aTrack = normalizeTrackNumber(a.track_number);
  const bTrack = normalizeTrackNumber(b.track_number);

  const discCmp = compareSortableNumbers(aDisc, bDisc);
  if (discCmp !== 0) return discCmp;

  const trackCmp = compareSortableNumbers(aTrack, bTrack);
  if (trackCmp !== 0) return trackCmp;

  return (a.path || '').localeCompare(b.path || '', 'zh-Hans-CN', {
    numeric: true,
    sensitivity: 'base'
  });
}

function compareSortableNumbers(a, b) {
  const aMissing = !a;
  const bMissing = !b;

  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  return a - b;
}

function normalizeTrackNumber(value) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function inferTrackInfoFromFileName(fileName) {
  const baseName = stripExtension(fileName).trim();
  const match = baseName.match(/^(\d{1,3})\s*-\s*(.+?)\s*-\s*(.+)$/);

  if (!match) {
    return {
      track_number: 0,
      artist: '',
      title: ''
    };
  }

  return {
    track_number: normalizeTrackNumber(match[1]),
    artist: normalizeText(match[2]),
    title: normalizeText(match[3])
  };
}

function isAudioFile(fileName) {
  const ext = getExtension(fileName);
  return AUDIO_EXTENSIONS.has(ext);
}

function getExtension(fileName) {
  const index = fileName.lastIndexOf('.');
  if (index < 0) return '';
  return fileName.slice(index).toLowerCase();
}

function getMimeTypeFromName(fileName) {
  const ext = getExtension(fileName);
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.flac') return 'audio/flac';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.aac') return 'audio/aac';
  return '';
}

function stripExtension(fileName) {
  const index = fileName.lastIndexOf('.');
  return index >= 0 ? fileName.slice(0, index) : fileName;
}

function compareFileNames(a, b) {
  return a.localeCompare(b, 'zh-Hans-CN', {
    numeric: true,
    sensitivity: 'base'
  });
}

function secondsToMilliseconds(value) {
  return Math.max(0, Math.round((Number(value) || 0) * 1000));
}

function millisecondsToSeconds(value) {
  return Number((Math.max(0, value) / 1000).toFixed(3));
}

async function createAlbumId(albumDirName) {
  const bytes = new TextEncoder().encode(albumDirName);
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(digest)]
    .slice(0, 4)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function getAlbumKeyFromPath(path) {
  const slashIndex = path.indexOf('/');
  return slashIndex >= 0 ? path.slice(0, slashIndex) : path;
}

async function loadStoredMetadata(rootHandle) {
  try {
    const sukyDir = await rootHandle.getDirectoryHandle(INTERNAL_DIR);
    const fileHandle = await sukyDir.getFileHandle(METADATA_FILE);
    const file = await fileHandle.getFile();
    const text = await file.text();
    const parsed = JSON.parse(text);

    if (!parsed || typeof parsed !== 'object' || parsed.version !== METADATA_VERSION || typeof parsed.albums !== 'object') {
      return createEmptyMetadata();
    }

    for (const album of Object.values(parsed.albums)) {
      if (!Array.isArray(album?.tracks)) {
        album.tracks = [];
      }
      album.id = String(album.id || '');
      album.title = normalizeText(album.title) || '';
      album.artist = normalizeText(album.artist) || 'Unknown Artist';
      album.coverFile = typeof album.coverFile === 'string' ? album.coverFile : '';
      album.total_duration = Number(album.total_duration) || 0;
      album.tracks = album.tracks.map(track => ({
        path: track.path,
        track_number: normalizeTrackNumber(track.track_number),
        disc_number: normalizeTrackNumber(track.disc_number),
        title: normalizeText(track.title) || stripExtension(track.path?.split('/').pop() || ''),
        artist: normalizeText(track.artist) || 'Unknown Artist',
        duration: millisecondsToSeconds(secondsToMilliseconds(track.duration)),
        start_time: millisecondsToSeconds(secondsToMilliseconds(track.start_time))
      }));
      recalculateAlbum(album);
    }

    return parsed;
  } catch (error) {
    if (error?.name !== 'NotFoundError') {
      console.warn('读取 .suky/metadata.json 失败，改为空库重建。', error);
    }
    return createEmptyMetadata();
  }
}

async function persistMetadata(rootHandle, metadata) {
  const sukyDir = await rootHandle.getDirectoryHandle(INTERNAL_DIR, { create: true });
  const fileHandle = await sukyDir.getFileHandle(METADATA_FILE, { create: true });
  const writable = await fileHandle.createWritable();

  try {
    await writable.write(JSON.stringify(metadata, null, 2));
  } finally {
    await writable.close();
  }
}

async function resetInternalStorage(rootHandle) {
  const sukyDir = await rootHandle.getDirectoryHandle(INTERNAL_DIR, { create: true });
  const coversDir = await sukyDir.getDirectoryHandle(COVERS_DIR, { create: true });

  for await (const [name, handle] of coversDir.entries()) {
    await coversDir.removeEntry(name, { recursive: handle.kind === 'directory' });
  }

  try {
    await sukyDir.removeEntry(METADATA_FILE);
  } catch (error) {
    if (error?.name !== 'NotFoundError') throw error;
  }

  return createEmptyMetadata();
}

async function persistAlbumCover(rootHandle, picture, albumId, albumDirName) {
  if (!picture?.data) return '';

  const mime = String(picture.format || picture.type || '').toLowerCase();
  const isPng = mime.includes('png');
  const extension = isPng ? '.png' : '.jpg';
  const fileName = `${albumId}${extension}`;

  try {
    const sukyDir = await rootHandle.getDirectoryHandle(INTERNAL_DIR, { create: true });
    const coversDir = await sukyDir.getDirectoryHandle(COVERS_DIR, { create: true });
    const fileHandle = await coversDir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();

    try {
      const bytes = toUint8Array(picture.data);
      if (!bytes) return '';
      await writable.write(new Blob([bytes], { type: isPng ? 'image/png' : 'image/jpeg' }));
    } finally {
      await writable.close();
    }

    return fileName;
  } catch (error) {
    console.warn(`写入专辑封面失败: ${albumDirName}`, error);
    return '';
  }
}

function toUint8Array(value) {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return new Uint8Array(value);
  if (Array.isArray(value.data)) return new Uint8Array(value.data);
  return null;
}
