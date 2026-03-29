/**
 * dataLoader.js — 两级 JSON 数据加载
 */

/**
 * 加载专辑总列表
 * @returns {Promise<Array>}
 */
export async function loadAlbumsList() {
  const res = await fetch('/virtual-data/data/albums.json');
  if (!res.ok) throw new Error(`无法加载 albums.json: ${res.status}`);
  return res.json();
}

/**
 * 加载单张专辑详情
 * @param {string} detailUrl
 * @returns {Promise<Object>}
 */
export async function loadAlbumDetail(detailUrl) {
  const normalizedUrl = detailUrl.startsWith('./data/')
    ? detailUrl.replace('./data/', '/virtual-data/data/')
    : detailUrl;
  const res = await fetch(normalizedUrl);
  if (!res.ok) throw new Error(`无法加载专辑详情: ${res.status}`);
  return res.json();
}
