import sharp from "sharp";

export type Point = { x: number; y: number };
export type ScreenQuad = { topLeft: Point; topRight: Point; bottomRight: Point; bottomLeft: Point };
export class CompositeError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
export function validateQuad(value: ScreenQuad | undefined, width: number, height: number): Point[] {
  if (!value) throw new CompositeError("SCREEN_QUAD_REQUIRED", "请先输入并确认屏幕四角");
  const p = [value.topLeft, value.topRight, value.bottomRight, value.bottomLeft];
  if (p.some(a => !a || !Number.isFinite(a.x) || !Number.isFinite(a.y) || a.x < 0 || a.y < 0 || a.x >= width || a.y >= height))
    throw new CompositeError("SCREEN_QUAD_INVALID", "四角必须在背景图内，单位为像素");
  for (let i = 0; i < 4; i++) {
    const a = p[i], b = p[(i + 1) % 4], c = p[(i + 2) % 4];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 2 || (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) <= 1)
      throw new CompositeError("SCREEN_QUAD_INVALID", "请按左上、右上、右下、左下填写不交叉的凸四边形");
  }
  return p;
}

// Solve the inverse homography: background pixels -> normalized source UV.
// Only deterministic resampling/masking occurs; no model ever receives the UI.
function inverse(p: Point[]) {
  const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const a: number[][] = [];
  p.forEach(({ x, y }, i) => {
    const [u, v] = uv[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  });
  for (let k = 0; k < 8; k++) {
    let pivot = k;
    for (let r = k + 1; r < 8; r++) if (Math.abs(a[r][k]) > Math.abs(a[pivot][k])) pivot = r;
    [a[k], a[pivot]] = [a[pivot], a[k]];
    if (Math.abs(a[k][k]) < 1e-10) throw new CompositeError("SCREEN_QUAD_INVALID", "四角无法形成有效透视变换");
    const scale = a[k][k];
    for (let c = k; c <= 8; c++) a[k][c] /= scale;
    for (let r = 0; r < 8; r++) if (r !== k) {
      const factor = a[r][k];
      for (let c = k; c <= 8; c++) a[r][c] -= factor * a[k][c];
    }
  }
  return a.map(row => row[8]);
}
export async function perspectiveComposite(background: Buffer, source: Buffer, quad: ScreenQuad) {
  const bg = await sharp(background, { limitInputPixels: 16777216 }).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const src = await sharp(source, { limitInputPixels: 40000000 }).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = bg.info;
  const points = validateQuad(quad, width, height), h = inverse(points);
  const out = Buffer.from(bg.data);
  const minX = Math.floor(Math.min(...points.map(p => p.x))), maxX = Math.ceil(Math.max(...points.map(p => p.x)));
  const minY = Math.floor(Math.min(...points.map(p => p.y))), maxY = Math.ceil(Math.max(...points.map(p => p.y)));
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    if (points.some((a, i) => { const b = points[(i + 1) % 4]; return (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < -1e-7; })) continue;
    const d = h[6] * x + h[7] * y + 1;
    const u = (h[0] * x + h[1] * y + h[2]) / d, v = (h[3] * x + h[4] * y + h[5]) / d;
    const sx = Math.max(0, Math.min(src.info.width - 1, u * (src.info.width - 1)));
    const sy = Math.max(0, Math.min(src.info.height - 1, v * (src.info.height - 1)));
    const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(x0 + 1, src.info.width - 1), y1 = Math.min(y0 + 1, src.info.height - 1);
    for (let c = 0; c < 4; c++) {
      const sample = (xx: number, yy: number) => src.data[(yy * src.info.width + xx) * 4 + c];
      out[(y * width + x) * 4 + c] = Math.round((sample(x0, y0) * (1 - (sx - x0)) + sample(x1, y0) * (sx - x0)) * (1 - (sy - y0)) + (sample(x0, y1) * (1 - (sx - x0)) + sample(x1, y1) * (sx - x0)) * (sy - y0));
    }
  }
  return sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
