// 点击热区：按 cdi3 里的部件名，实时统计当前帧每个部件的包围盒，
// 再按模型自身锚点（脖子下缘 / 胸衣下缘 / 前裙上缘 +45% 裙高 / 前裙下缘 / 鞋口）
// 切成头 / 胸 / 腰 / 裙 / 腿 / 脚六段。
// 思路来自参考项目 -live2d--main/src/stage/regions/zones.js，只保留我们需要的部分。

const HEAD = ['头', '脸', '脸底', '五官', '脖子', '耳朵', '发饰', '女仆发饰', '前发', '眉毛', '眼眶', '眼球', '眼白', '嘴', '鼻子']
const CHEST = ['胸衣', '胸', '领子', '肩膀花边']
const WAIST = ['腰部衣服']
const SKIRT_FRONT = ['短裙', '短裙后']
const SKIRT_ALL = [...SKIRT_FRONT, '长裙', '长裙后', '长裙蝴蝶结', '身后蝴蝶结']
const LEGS = ['腿', '左腿', '右腿']
const TAIL = ['尾巴', '狗尾草']

const matches = (name, keys) => keys.some((k) => name.includes(k))

const groupOf = (name) => {
  if (matches(name, TAIL)) return 'tail'
  if (matches(name, HEAD)) return 'head'
  if (matches(name, CHEST)) return 'chest'
  if (matches(name, WAIST)) return 'waist'
  if (matches(name, SKIRT_ALL)) return 'skirt'
  if (matches(name, LEGS)) return 'legs'
  return 'body'
}

// cdi3 只提供 Id → 显示名的映射（如 Part97 → 短裙）
export async function loadPartNames(url) {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`cdi3.json HTTP ${resp.status}`)
  const json = await resp.json()
  return new Map((json.Parts || []).map((p) => [p.Id, p.Name || p.Id]))
}

const emptyBox = () => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })

const mergeBox = (a, b) => ({
  minX: Math.min(a.minX, b.minX),
  minY: Math.min(a.minY, b.minY),
  maxX: Math.max(a.maxX, b.maxX),
  maxY: Math.max(a.maxY, b.maxY),
})

const validBox = (b) => !!b && Number.isFinite(b.minX) && Number.isFinite(b.minY)

/**
 * 扫一遍当前帧的 drawable，返回六个可点击分段（模型画布坐标）。
 * 每次点击重算，换装后裙子/鞋子长度变化也能跟着更新。
 */
export function buildHitBands({ core, internalModel, names }) {
  if (!core || !internalModel || !names?.size) return []
  const count = core.getDrawableCount()
  const boxByName = new Map()

  for (let i = 0; i < count; i++) {
    let parent = -1
    try { parent = core.getDrawableParentPartIndex(i) } catch { parent = -1 }
    if (parent < 0) continue
    let name = ''
    try { name = names.get(core.getPartId(parent).getString().s) || '' } catch { name = '' }
    if (!name) continue
    let opacity = 0
    try { opacity = core.getDrawableOpacity(i) } catch { opacity = 0 }
    if (!(opacity > 0.05)) continue
    let vtx
    try { vtx = internalModel.getDrawableVertices(i) } catch { continue }
    if (!vtx || vtx.length < 6) continue

    const b = boxByName.get(name) || emptyBox()
    for (let t = 0; t < vtx.length; t += 2) {
      const x = vtx[t]
      const y = vtx[t + 1]
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      if (x < b.minX) b.minX = x
      if (x > b.maxX) b.maxX = x
      if (y < b.minY) b.minY = y
      if (y > b.maxY) b.maxY = y
    }
    boxByName.set(name, b)
  }

  const byNames = (keys) => {
    let out = null
    for (const [name, b] of boxByName) {
      if (!matches(name, keys) || !validBox(b)) continue
      out = out ? mergeBox(out, b) : b
    }
    return out
  }
  const byGroup = (group) => {
    let out = null
    for (const [name, b] of boxByName) {
      if (groupOf(name) !== group || !validBox(b)) continue
      out = out ? mergeBox(out, b) : b
    }
    return out
  }
  const byBody = () => {
    let out = null
    for (const [name, b] of boxByName) {
      if (matches(name, TAIL) || !validBox(b)) continue
      out = out ? mergeBox(out, b) : b
    }
    return out
  }

  const body = byBody()
  if (!validBox(body)) return []
  const head = byGroup('head') || body
  const chest = byGroup('chest')
  const waist = byGroup('waist')
  const skirtFront = byNames(SKIRT_FRONT) || byNames(['长裙', '长裙后']) || body
  const legs = byGroup('legs') || body

  const neckY = Math.max(head.maxY, body.minY)
  const chestY = Math.max(validBox(chest) ? chest.maxY : neckY, neckY + 1)
  const waistY = skirtFront.minY + (skirtFront.maxY - skirtFront.minY) * 0.45
  const skirtBottom = skirtFront.maxY
  const footY = legs.maxY - (legs.maxY - body.minY) * 0.105

  const band = (name, z, y0, y1, box) => {
    const src = validBox(box) ? box : body
    return {
      name,
      z,
      y0: Math.round(y0),
      y1: Math.round(y1),
      x0: Math.round(src.minX),
      x1: Math.round(src.maxX),
    }
  }

  const bands = [
    band('head', 7, body.minY, neckY, head),
    band('chest', 6, neckY, chestY, chest || body),
    band('waist', 5, chestY, waistY, waist || body),
    band('skirt', 4, waistY, skirtBottom, skirtFront),
    band('legs', 3, skirtBottom, footY, legs),
    band('feet', 3, footY, legs.maxY, legs),
  ].filter((b) => b.y1 - b.y0 > 8 && b.x1 - b.x0 > 8)

  bands.sort((a, b) => b.z - a.z)
  return bands
}

/** 模型画布坐标 → 命中的分段名；没命中返回 null */
export function hitBand(bands, x, y) {
  for (const b of bands) {
    if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return b.name
  }
  return null
}
