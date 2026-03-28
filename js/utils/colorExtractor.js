/**
 * colorExtractor.js — 从专辑封面提取主题色 + 动态背景渲染
 */

/**
 * 从 img 元素提取 Top-N 主色
 * @param {HTMLImageElement} img
 * @param {number} count
 * @returns {{ r, g, b, a: number }[]}
 */
export function extractColors(img, count = 3) {
  const canvas = document.createElement('canvas');
  const SIZE = 64; // 缩小采样，提升性能
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, SIZE, SIZE);

  const data = ctx.getImageData(0, 0, SIZE, SIZE).data;

  // 简单 K-Means（3次迭代） —— 适合小样本
  // 1. 采样像素
  const pixels = [];
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 128) continue; // 跳过透明像素
    pixels.push([data[i], data[i + 1], data[i + 2]]);
  }
  if (pixels.length === 0) return defaultColors(count);

  // 2. 初始化中心（均匀采样）
  let centers = [];
  for (let i = 0; i < count; i++) {
    centers.push(pixels[Math.floor((i / count) * pixels.length)]);
  }

  // 3. 迭代
  for (let iter = 0; iter < 6; iter++) {
    const sums = Array.from({ length: count }, () => [0, 0, 0, 0]); // [r,g,b,cnt]
    for (const p of pixels) {
      let minDist = Infinity, minIdx = 0;
      for (let c = 0; c < count; c++) {
        const d = colorDist(p, centers[c]);
        if (d < minDist) { minDist = d; minIdx = c; }
      }
      sums[minIdx][0] += p[0];
      sums[minIdx][1] += p[1];
      sums[minIdx][2] += p[2];
      sums[minIdx][3]++;
    }
    centers = sums.map((s, i) =>
      s[3] > 0
        ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]]
        : centers[i]
    );
  }

  return centers.map(c => ({
    r: Math.round(c[0]),
    g: Math.round(c[1]),
    b: Math.round(c[2]),
  }));
}

function colorDist([r1, g1, b1], [r2, g2, b2]) {
  return (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
}

function defaultColors(count) {
  return [
    { r: 30, g: 30, b: 50 },
    { r: 60, g: 40, b: 80 },
    { r: 20, g: 50, b: 70 },
  ].slice(0, count);
}

// ── 动态背景渲染 ──────────────────────────────────────────

let _animId = null;
let _blobs = [];

/**
 * 在 canvas 上渲染液化动态背景
 * @param {HTMLCanvasElement} canvas
 * @param {{ r, g, b }[]} colors  3 个主题色
 */
export function startDynamicBackground(canvas, colors) {
  stopDynamicBackground();

  const ctx = canvas.getContext('2d');
  const resize = () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  };
  resize();
  window.addEventListener('resize', resize);

  const [c0_raw, c1_raw, c2_raw] = colors.length >= 3 ? colors : defaultColors(3);

  // 降低灰度（即增加饱和度），让主题色更鲜艳饱满
  const c0 = boostSaturation(c0_raw, 1.3);
  const c1 = boostSaturation(c1_raw, 1.4);
  const c2 = boostSaturation(c2_raw, 1.4);

  // 创建几个随机 blob
  _blobs = [
    makeBlob(canvas.width * 0.2, canvas.height * 0.3, 0.35, c1, 0.0),
    makeBlob(canvas.width * 0.8, canvas.height * 0.6, 0.3,  c2, 1.2),
    makeBlob(canvas.width * 0.5, canvas.height * 0.8, 0.4,  c1, 2.4),
    makeBlob(canvas.width * 0.1, canvas.height * 0.7, 0.25, c2, 0.8),
    makeBlob(canvas.width * 0.9, canvas.height * 0.2, 0.3,  c1, 3.1),
  ];

  let t = 0;
  const bgColor = `rgb(${darken(c0, 0.4).r},${darken(c0, 0.4).g},${darken(c0, 0.4).b})`;

  const draw = () => {
    t += 0.005;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Blobs
    for (const b of _blobs) {
      const x = b.baseX + Math.sin(t * b.freqX + b.phase) * b.ampX;
      const y = b.baseY + Math.cos(t * b.freqY + b.phase) * b.ampY;
      const r = b.radius * (1 + Math.sin(t * 0.7 + b.phase) * 0.1);

      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0,   `rgba(${b.color.r},${b.color.g},${b.color.b},0.55)`);
      grad.addColorStop(0.5, `rgba(${b.color.r},${b.color.g},${b.color.b},0.2)`);
      grad.addColorStop(1,   `rgba(${b.color.r},${b.color.g},${b.color.b},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * (0.8 + Math.sin(t + b.phase) * 0.2), t * 0.1 + b.phase, 0, Math.PI * 2);
      ctx.fill();
    }

    _animId = requestAnimationFrame(draw);
  };
  draw();

  return () => {
    window.removeEventListener('resize', resize);
    stopDynamicBackground();
  };
}

export function stopDynamicBackground() {
  if (_animId) { cancelAnimationFrame(_animId); _animId = null; }
}

function makeBlob(bx, by, radiusFraction, color, phase) {
  const size = Math.max(window.innerWidth, window.innerHeight);
  return {
    baseX: bx, baseY: by,
    radius: size * radiusFraction,
    ampX: size * 0.12,
    ampY: size * 0.1,
    freqX: 0.4 + Math.random() * 0.3,
    freqY: 0.3 + Math.random() * 0.3,
    phase,
    color,
  };
}

function darken(c, factor) {
  return { r: Math.round(c.r * factor), g: Math.round(c.g * factor), b: Math.round(c.b * factor) };
}

// 提高饱和度（降低灰度）
function boostSaturation(c, boost) {
  const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  return {
    r: Math.min(255, Math.max(0, Math.round(lum + (c.r - lum) * boost))),
    g: Math.min(255, Math.max(0, Math.round(lum + (c.g - lum) * boost))),
    b: Math.min(255, Math.max(0, Math.round(lum + (c.b - lum) * boost)))
  };
}
