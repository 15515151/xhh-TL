import fs from 'fs'
import path from 'path'

/** Extract an image buffer from the return shapes used by different Yunzai runtimes. */
export function extractRenderBuffer(result) {
  if (Buffer.isBuffer(result)) return result

  if (Buffer.isBuffer(result?.image)) return result.image
  if (Buffer.isBuffer(result?.buffer)) return result.buffer

  const value = result?.file ?? result
  if (Buffer.isBuffer(value)) return value
  if (typeof value !== 'string') return null

  if (value.startsWith('base64://')) return Buffer.from(value.slice(9), 'base64')
  if (value.startsWith('data:image')) {
    const comma = value.indexOf(',')
    if (comma >= 0) return Buffer.from(value.slice(comma + 1), 'base64')
  }
  if (value.length > 256 && /^[A-Za-z0-9+/=\r\n]+$/.test(value)) {
    try {
      return Buffer.from(value, 'base64')
    } catch (_) {}
  }

  const file = value.replace(/^file:\/\//, '')
  for (const candidate of [file, path.resolve(file), path.resolve(process.cwd(), file)]) {
    try {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate)
    } catch (_) {}
  }
  return null
}

/** sharp 是主仓库自带的，缺了也要能出图——那就原样发渲染器给的图 */
let sharpMod
async function getSharp() {
  if (sharpMod !== undefined) return sharpMod
  try {
    sharpMod = (await import('sharp')).default
  } catch (err) {
    logger?.debug?.(`[xhh-TL][出图] sharp 不可用，图片不再二次压缩：${err.message}`)
    sharpMod = null
  }
  return sharpMod
}

/**
 * 把图片四角切成圆角、圆角外透明（出图模板的卡片要「透出群背景」时用）。
 *
 * 为什么不用 CSS + 渲染器：Yunzai 的渲染器截图不支持 omitBackground，
 * body 透明也会被截成白底或黑底；把 body 填成卡片同色又会「吃掉」底部圆角
 * （圆角外跟卡片一个颜色，看起来就是直角）。所以出图后在插件侧用 sharp 裁。
 *
 * 半径按图片宽度等比换算（模板按 620rem 宽设计，圆角 34rem）。
 * sharp 缺失或出错就原样返回，不影响出图。
 *
 * ⚠️ 输出格式必须跟 renderTpl 的 webpQuality 对齐，默认也出 webp。
 * 这里若图省事写 .png()，会把上游 toWebp 刚压好的图**重新膨胀回无损**：
 * 实测同尺寸卡片 webp 6.7KB → png 45KB（12 倍），群里发图又慢又费流量。
 *
 * @param {number} quality webp 质量；传 false 则出 png（上游没压过时才用）
 */
export async function roundCorners(buffer, { radius = 34, baseWidth = 620, quality = 82 } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return buffer
  const sharp = await getSharp()
  if (!sharp) return buffer
  try {
    const img = sharp(buffer)
    const meta = await img.metadata()
    const w = meta.width || 0
    const h = meta.height || 0
    if (!w || !h) return buffer
    const r = Math.max(0, Math.round((radius / baseWidth) * w))
    if (r <= 0) return buffer
    // 用 alpha 通道做遮罩：白底 + 黑色圆角矩形，取 alpha 与原图相乘
    const mask = Buffer.from(
      `<svg width="${w}" height="${h}"><rect x="0" y="0" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/></svg>`,
    )
    const cut = img.ensureAlpha().composite([{ input: mask, blend: 'dest-in' }])
    // 上游是 webp，这里也出 webp；只有上游明确没压过（quality === false）才出 png
    return quality === false
      ? await cut.png().toBuffer()
      : await cut.webp({ quality }).toBuffer()
  } catch (err) {
    logger?.debug?.(`[xhh-TL][出图] 圆角裁切失败，用原图：${err.message}`)
    return buffer
  }
}

/**
 * 把渲染器出的无损 png 压成 webp。
 *
 * 让渲染器直接出 jpeg 的话用的是 Chromium 内置编码器，同画质比 webp 大不少；
 * png 是无损的，所以这一步二次编码不会累积失真。实测同一张抽卡记录图
 * scale 更高的 webp 反而比原来的 jpeg 更小（webp q82 视觉上相当于 jpeg q90+）。
 * 压不动（sharp 缺失、或者传进来的本来就不是 png）就原样返回，不影响出图。
 */
export async function toWebp(buffer, quality = 82) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return buffer
  const sharp = await getSharp()
  if (!sharp) return buffer
  try {
    return await sharp(buffer).webp({ quality }).toBuffer()
  } catch (err) {
    logger?.debug?.(`[xhh-TL][出图] webp 压缩失败，用原图：${err.message}`)
    return buffer
  }
}
