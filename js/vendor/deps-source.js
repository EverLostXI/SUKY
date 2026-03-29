import { Buffer } from 'buffer';

if (!globalThis.Buffer) {
  globalThis.Buffer = Buffer;
}

export { parseBlob, parseBuffer } from 'music-metadata-browser';
export { default as pLimit } from 'p-limit';
