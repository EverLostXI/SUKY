const VIRTUAL_PREFIX = '/virtual-data/';
const ALBUMS_LIST_PATH = '/virtual-data/data/albums.json';
const ALBUM_DETAILS_PREFIX = '/virtual-data/data/albums/';
const INTERNAL_DIR = '.suky';

let rootHandle = null;
let metadataState = createEmptyMetadata();
let pendingResolvers = [];

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', event => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'root-handle' && data.handle) {
    rootHandle = data.handle;
    metadataState = normalizeMetadata(data.metadata);
    flushPendingResolvers();
    return;
  }

  if (data.type === 'clear-root-handle') {
    rootHandle = null;
    metadataState = createEmptyMetadata();
  }
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const decodedPath = decodePathname(url.pathname);

  if (!decodedPath.startsWith(VIRTUAL_PREFIX)) return;

  event.respondWith(handleVirtualRequest(decodedPath));
});

async function handleVirtualRequest(pathname) {
  await ensureRootHandle();

  if (pathname === ALBUMS_LIST_PATH) {
    return jsonResponse(buildAlbumsList());
  }

  if (pathname.startsWith(ALBUM_DETAILS_PREFIX) && pathname.endsWith('.json')) {
    const albumId = pathname.slice(ALBUM_DETAILS_PREFIX.length, -'.json'.length);
    const detail = buildAlbumDetail(albumId);
    if (!detail) {
      return new Response('Album not found', { status: 404 });
    }
    return jsonResponse(detail);
  }

  if (pathname.startsWith('/virtual-data/music/')) {
    const musicRelativePath = pathname.slice('/virtual-data/music/'.length);
    return serveFileAtPath(rootHandle, musicRelativePath);
  }

  if (pathname.startsWith('/virtual-data/covers/')) {
    const relativePath = `${INTERNAL_DIR}/${pathname.slice('/virtual-data/'.length)}`;
    return serveFileAtPath(rootHandle, relativePath);
  }

  return new Response('Not found', { status: 404 });
}

async function ensureRootHandle() {
  if (rootHandle) return;

  await broadcastNeedRootHandle();

  await new Promise(resolve => {
    pendingResolvers.push(resolve);
  });
}

function flushPendingResolvers() {
  const resolvers = pendingResolvers;
  pendingResolvers = [];
  for (const resolve of resolvers) {
    resolve();
  }
}

async function broadcastNeedRootHandle() {
  const clients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true
  });

  for (const client of clients) {
    client.postMessage({ type: 'need-root-handle' });
  }
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: {
      'Content-Type': 'application/json'
    }
  });
}

function buildAlbumsList() {
  return getSortedAlbums().map(album => ({
    id: album.id,
    title: album.title,
    artist: album.artist,
    cover_url: album.coverFile ? `/virtual-data/covers/${album.coverFile}` : '',
    detail_url: `/virtual-data/data/albums/${album.id}.json`
  }));
}

function buildAlbumDetail(albumId) {
  const album = getSortedAlbums().find(item => item.id === albumId);
  if (!album) return null;

  return {
    id: album.id,
    title: album.title,
    artist: album.artist,
    cover_url: album.coverFile ? `/virtual-data/covers/${album.coverFile}` : '',
    total_duration: album.total_duration,
    tracks: (album.tracks || []).map(track => ({
      track_number: track.track_number,
      disc_number: track.disc_number,
      title: track.title,
      artist: track.artist,
      file_url: `/virtual-data/music/${track.path}`,
      duration: track.duration,
      start_time: track.start_time
    }))
  };
}

function getSortedAlbums() {
  return Object.values(metadataState.albums || {}).sort((a, b) => {
    const titleCmp = String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN', {
      numeric: true,
      sensitivity: 'base'
    });
    if (titleCmp !== 0) return titleCmp;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

async function serveFileAtPath(baseDirHandle, relativePath) {
  if (!baseDirHandle) {
    return new Response('Root handle unavailable', { status: 503 });
  }

  const parts = relativePath.split('/').filter(Boolean);
  if (!parts.length) {
    return new Response('Invalid path', { status: 400 });
  }

  try {
    let directory = baseDirHandle;
    for (let index = 0; index < parts.length - 1; index += 1) {
      directory = await directory.getDirectoryHandle(parts[index]);
    }

    const fileName = parts[parts.length - 1];
    const fileHandle = await directory.getFileHandle(fileName);
    const file = await fileHandle.getFile();

    return new Response(file.stream(), {
      headers: {
        'Content-Type': guessMimeType(fileName)
      }
    });
  } catch (error) {
    if (error?.name === 'NotFoundError') {
      return new Response('Not found', { status: 404 });
    }
    console.error('虚拟文件读取失败', relativePath, error);
    return new Response('Internal error', { status: 500 });
  }
}

function guessMimeType(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.flac')) return 'audio/flac';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.aac')) return 'audio/aac';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

function createEmptyMetadata() {
  return {
    version: 1,
    scannedAt: new Date().toISOString(),
    albums: {}
  };
}

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || typeof metadata.albums !== 'object') {
    return createEmptyMetadata();
  }

  return metadata;
}

function decodePathname(pathname) {
  return pathname
    .split('/')
    .map(segment => {
      try {
        return decodeURIComponent(segment);
      } catch (_) {
        return segment;
      }
    })
    .join('/');
}
