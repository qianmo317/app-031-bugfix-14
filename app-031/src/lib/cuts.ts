// 裁切步骤：修边刀、内部贯通刀的合并/排序，以及最关键的「按步骤模拟切割」验证
//
// 精度与单位约定（全应用唯一口径）：
// - 长度（位置/尺寸/锯路/修边/切割线坐标/贯通区间）：毫米（mm），展示与登记取整到 1mm
//   （内部坐标可带 0.1mm 级锯路半宽：如 1.6mm；写入 CutStep.at 时四舍五入到 0.1mm）。
// - 面积：平方毫米（mm²）整数；换算平方米时保留 2 位小数；利用率为比值，展示保留 1 位百分数。
// - 刀路必须保证：照着 steps 逐刀还原出的零件，与零件清单尺寸逐一精确匹配（容差 0.6mm，
//   对应推台锯定位精度），且所有料块面积 + 锯路吃掉面积 = 原板面积（守恒容差 1mm²）。
import type { CutStep, Placement, SheetResult, OffcutInfo } from '../types'
import { orderSegs, type Rect, type RawSeg, EPS, type PlacedRect } from './geometry'

/** 逐刀还原尺寸与目标的匹配容差（mm）：0.1mm 取整 + 推台锯定位误差余量。 */
export const SIZE_TOL = 0.6
/** 面积守恒容差（mm²）。 */
export const AREA_TOL = 1
/** 可用余料短边门槛（mm）。 */
export const OFFCUT_MIN_MM = 300
/** 反推刀路枚举上限（超出视为本摆法在预算内找不到刀路）。 */
const ENUM_BUDGET = 300
/** 反推刀路墙钟预算（ms）：规格要求微调增量校验 < 80ms，留足余量。 */
const TIME_BUDGET_MS = 200

export interface DSeg extends RawSeg {
  deps: DSeg[]
}

interface GSeg {
  id: number
  axis: 'v' | 'h'
  at: number
  lo: number
  hi: number
  depIds: Set<number>
  src: DSeg[]
}

function mergeDSegs(raw: DSeg[], kerf: number): GSeg[] {
  const groups: GSeg[] = []
  for (const s of raw) {
    let target: GSeg | undefined
    for (const g of groups) {
      if (g.axis === s.axis && Math.abs(g.at - s.at) < 0.02) {
        const gap = Math.max(g.lo, s.lo) - Math.min(g.hi, s.hi)
        if (gap <= kerf + 0.6) {
          target = g
          break
        }
      }
    }
    if (target) {
      target.lo = Math.min(target.lo, s.lo)
      target.hi = Math.max(target.hi, s.hi)
      target.src.push(s)
    } else {
      groups.push({
        id: groups.length,
        axis: s.axis,
        at: s.at,
        lo: s.lo,
        hi: s.hi,
        depIds: new Set(),
        src: [s]
      })
    }
  }
  const segToGroup = new Map<DSeg, number>()
  groups.forEach((g, i) => g.src.forEach((s) => segToGroup.set(s, i)))
  for (const g of groups) {
    for (const s of g.src) {
      for (const d of s.deps) {
        const gi = segToGroup.get(d)
        if (gi !== undefined && gi !== g.id) g.depIds.add(gi)
      }
    }
  }
  return groups
}

function buildInternalSteps(raw: DSeg[], kerf: number, boardIndex: number, startOrder: number): CutStep[] {
  const groups = mergeDSegs(raw, kerf)
  const ordered = orderSegs(
    groups.map((g) => ({ id: g.id, axis: g.axis, at: g.at, lo: g.lo, hi: g.hi, deps: g.depIds })),
    (s) => [...s.deps]
  )
  const byId = new Map(groups.map((g) => [g.id, g]))
  return ordered.map((s, i) => {
    const g = byId.get(s.id)!
    return {
      boardIndex,
      axis: g.axis,
      at: Math.round(g.at * 10) / 10,
      span: [Math.round(g.lo), Math.round(g.hi)],
      order: startOrder + i,
      kind: 'cut',
      label:
        g.axis === 'v'
          ? `沿 X = ${Math.round(g.at)}mm 竖切，贯通 ${Math.round(g.hi - g.lo)}mm`
          : `沿 Y = ${Math.round(g.at)}mm 横切，贯通 ${Math.round(g.hi - g.lo)}mm`
    }
  })
}

/** 四周修边刀序（先修长向后修短向；多张同规格板可叠切，故按规格去重统计工步）。 */
export function trimSteps(w: number, h: number, kerf: number, trim: number, boardIndex: number): CutStep[] {
  if (trim <= 0) return []
  const mk = (
    axis: 'v' | 'h',
    at: number,
    span: [number, number],
    order: number,
    edge: string
  ): CutStep => ({
    boardIndex,
    axis,
    at: Math.round(at * 10) / 10,
    span,
    order,
    kind: 'trim',
    label: `修边刀：${edge}修掉 ${trim}mm`
  })
  return [
    mk('h', trim - kerf / 2, [0, w], 0, '底边'),
    mk('v', trim - kerf / 2, [trim, h], 1, '左边'),
    mk('h', h - trim + kerf / 2, [trim, w], 2, '顶边'),
    mk('v', w - trim + kerf / 2, [trim, h - trim], 3, '右边')
  ]
}

/** 排样器路径：由带依赖关系的原始切割段生成最终步骤（修边在前）。 */
export function buildSteps(
  w: number,
  h: number,
  kerf: number,
  trim: number,
  boardIndex: number,
  raw: DSeg[]
): CutStep[] {
  // 修边刀总是排在最前（所有内部刀坐标都在修边后的可用区内）
  const trims = trimSteps(w, h, kerf, trim, boardIndex)
  const internal = buildInternalSteps(raw, kerf, boardIndex, trims.length)
  return [...trims, ...internal]
}

/** 枚举给定矩形集合/边界内所有 guillotine 切线分解（DFS，带预算）。 */
function* enumerateGuillotine(
  rects: PlacedRect[],
  bounds: Rect,
  kerf: number,
  budget: { left: number }
): Generator<{ segs: RawSeg[]; leftovers: Rect[] }> {
  if (budget.left <= 0) return
  budget.left--
  if (rects.length === 0) {
    yield { segs: [], leftovers: bounds.w >= 2 && bounds.h >= 2 ? [bounds] : [] }
    return
  }
  if (rects.length === 1) {
    const r = rects[0]
    const gxL = r.x - bounds.x
    const gxR = bounds.x + bounds.w - (r.x + r.w)
    const gyT = bounds.y + bounds.h - (r.y + r.h)
    const gyB = r.y - bounds.y
    const segs: RawSeg[] = []
    const leftovers: Rect[] = []
    // 左条、右条（贯通当前边界）
    if (gxL >= kerf - EPS) {
      segs.push({ axis: 'v', at: r.x - kerf / 2, lo: bounds.y, hi: bounds.y + bounds.h })
      leftovers.push({ x: bounds.x, y: bounds.y, w: gxL - kerf, h: bounds.h })
    }
    if (gxR >= kerf - EPS) {
      segs.push({ axis: 'v', at: r.x + r.w + kerf / 2, lo: bounds.y, hi: bounds.y + bounds.h })
      leftovers.push({ x: r.x + r.w + kerf, y: bounds.y, w: gxR - kerf, h: bounds.h })
    }
    const innerX = r.x
    const innerW = r.w
    // 下条、上条（在左右切完后的中条内）
    if (gyB >= kerf - EPS) {
      segs.push({ axis: 'h', at: r.y - kerf / 2, lo: innerX, hi: innerX + innerW })
      leftovers.push({ x: innerX, y: bounds.y, w: innerW, h: gyB - kerf })
    }
    if (gyT >= kerf - EPS) {
      segs.push({ axis: 'h', at: r.y + r.h + kerf / 2, lo: innerX, hi: innerX + innerW })
      leftovers.push({ x: innerX, y: r.y + r.h + kerf, w: innerW, h: gyT - kerf })
    }
    yield { segs, leftovers: leftovers.filter((l) => l.w >= 2 && l.h >= 2) }
    return
  }
  // 候选切线：另一方向上所有不切零件的边界位置
  const cuts: { axis: 'v' | 'h'; at: number }[] = []
  {
    const vs = new Set<number>()
    const hs = new Set<number>()
    for (const r of rects) collectCutPositions(r, vs, hs, kerf)
    for (const at of [...vs].sort((a, b) => a - b)) {
      const left = rects.filter((r) => r.x + r.w <= at + EPS)
      const right = rects.filter((r) => r.x >= at - EPS)
      if (left.length > 0 && right.length > 0 && left.length + right.length === rects.length)
        cuts.push({ axis: 'v', at })
    }
    for (const at of [...hs].sort((a, b) => a - b)) {
      const bottom = rects.filter((r) => r.y + r.h <= at + EPS)
      const top = rects.filter((r) => r.y >= at - EPS)
      if (bottom.length > 0 && top.length > 0 && bottom.length + top.length === rects.length)
        cuts.push({ axis: 'h', at })
    }
  }
  for (const cut of cuts) {
    let leftBound: Rect, rightBound: Rect
    if (cut.axis === 'v') {
      leftBound = { ...bounds, w: cut.at - kerf / 2 - bounds.x }
      rightBound = {
        ...bounds,
        x: cut.at + kerf / 2,
        w: bounds.x + bounds.w - (cut.at + kerf / 2)
      }
    } else {
      leftBound = { ...bounds, h: cut.at - kerf / 2 - bounds.y }
      rightBound = {
        ...bounds,
        y: cut.at + kerf / 2,
        h: bounds.y + bounds.h - (cut.at + kerf / 2)
      }
    }
    const ls = rects.filter((r) =>
      cut.axis === 'v' ? r.x + r.w <= cut.at + EPS : r.y + r.h <= cut.at + EPS
    )
    const rs = rects.filter((r) => (cut.axis === 'v' ? r.x >= cut.at - EPS : r.y >= cut.at - EPS))
    const seg: RawSeg =
      cut.axis === 'v'
        ? { axis: 'v', at: cut.at, lo: bounds.y, hi: bounds.y + bounds.h }
        : { axis: 'h', at: cut.at, lo: bounds.x, hi: bounds.x + bounds.w }
    for (const decL of enumerateGuillotine(ls, leftBound, kerf, budget)) {
      for (const decR of enumerateGuillotine(rs, rightBound, kerf, budget)) {
        yield {
          segs: [seg, ...decL.segs, ...decR.segs],
          leftovers: [...decL.leftovers, ...decR.leftovers]
        }
      }
    }
  }
}

function collectCutPositions(
  r: PlacedRect,
  vs: Set<number>,
  hs: Set<number>,
  kerf: number
): void {
  vs.add(r.x + r.w + kerf / 2)
  vs.add(r.x - kerf / 2)
  hs.add(r.y + r.h + kerf / 2)
  hs.add(r.y - kerf / 2)
}

/** 把 DFS 切线顺序转成步骤（保持父刀在前，并贪心合并相邻同线刀），失败信号由模拟器判定。 */
function stepsFromSegs(
  segs: RawSeg[],
  w: number,
  h: number,
  kerf: number,
  trim: number,
  boardIndex: number,
  doMerge = true
): CutStep[] {
  const merged: RawSeg[] = []
  for (const s of segs) {
    if (!doMerge) {
      merged.push({ ...s })
      continue
    }
    const g = merged.find((x) => x.axis === s.axis && Math.abs(x.at - s.at) < 0.02)
    if (g && Math.max(g.lo, s.lo) - Math.min(g.hi, s.hi) <= kerf + 0.6) {
      g.lo = Math.min(g.lo, s.lo)
      g.hi = Math.max(g.hi, s.hi)
    } else merged.push({ ...s })
  }
  const trims = trimSteps(w, h, kerf, trim, boardIndex)
  return [
    ...trims,
    ...merged.map((s, i) => ({
      boardIndex,
      axis: s.axis,
      at: Math.round(s.at * 10) / 10,
      span: [Math.round(s.lo), Math.round(s.hi)] as [number, number],
      order: trims.length + i,
      kind: 'cut' as const,
      label:
        s.axis === 'v'
          ? `沿 X = ${Math.round(s.at)}mm 竖切，贯通 ${Math.round(s.hi - s.lo)}mm`
          : `沿 Y = ${Math.round(s.at)}mm 横切，贯通 ${Math.round(s.hi - s.lo)}mm`
    }))
  ]
}

/** 余料归类：修边废料（贴原板外沿）、锯路零头（短边 ≤2.5mm）、内部余料/碎料。 */
export function classifyLeftovers(
  leaves: Rect[],
  w: number,
  h: number,
  trim: number
): { leftovers: Rect[]; trimScrap: Rect[]; slivers: Rect[] } {
  const leftovers: Rect[] = []
  const trimScrap: Rect[] = []
  const slivers: Rect[] = []
  for (const lf of leaves) {
    if (Math.min(lf.w, lf.h) <= 2.5) {
      slivers.push(lf)
      continue
    }
    const touchesOuter =
      lf.x <= EPS || lf.y <= EPS || lf.x + lf.w >= w - EPS || lf.y + lf.h >= h - EPS
    if (trim > 0 && touchesOuter) {
      trimScrap.push(lf)
    } else {
      leftovers.push(lf)
    }
  }
  return { leftovers, trimScrap, slivers }
}

/** 把模拟剩余料块转成余料登记信息（短边 ≥300mm 才标记为可用）。 */
export function offcutsFromLeaves(leaves: Rect[]): OffcutInfo[] {
  return leaves
    .map((lf) => {
      const wMm = Math.max(0, Math.round(lf.w))
      const hMm = Math.max(0, Math.round(lf.h))
      return {
        x: Math.round(lf.x),
        y: Math.round(lf.y),
        wMm,
        hMm,
        areaMm2: Math.round(lf.w * lf.h),
        usable: wMm >= OFFCUT_MIN_MM && hMm >= OFFCUT_MIN_MM
      }
    })
    .sort((a, c) => c.areaMm2 - a.areaMm2)
}

/**
 * 手工微调反推刀路（唯一安全策略：逐个方案模拟）。
 *
 * 枚举所有 guillotine 分解，对每个方案都照着刀路一刀一刀模拟，
 * 直到找出第一个能把每块零件按清单尺寸精确还原、且面积守恒的方案才收。
 * 取舍：不取「枚举到的第一个方案」——首方案可能多切/少切一刀（合并后贯通区间
 * 越过零件，或某刀在局部料块上并不贯通），照它下锯会切错尺寸；逐个模拟多花
 * 校验时间（预算 ENUM_BUDGET 个方案 / TIME_BUDGET_MS），保住的是刀路可用。
 */
export function rebuildFromPlacements(
  w: number,
  h: number,
  kerf: number,
  trim: number,
  boardIndex: number,
  placements: Placement[]
):
  | { ok: true; steps: CutStep[]; sim: SimResult }
  | { ok: false; reason: string } {
  const rects: PlacedRect[] = placements.map((p) => ({
    id: p.instanceId,
    x: p.x,
    y: p.y,
    w: p.lenMm,
    h: p.widMm
  }))
  const bounds: Rect = { x: trim, y: trim, w: w - 2 * trim, h: h - 2 * trim }
  const budget = { left: ENUM_BUDGET }
  const t0 = performance.now()
  let enumerated = 0
  let firstErr = ''
  for (const dec of enumerateGuillotine(rects, bounds, kerf, budget)) {
    enumerated++
    // 先用「不合并」的逐段刀路：递归分解的每一段都在各自子料块上完整贯通，
    // 合法分解在这一版必然能被逐刀还原。
    const rawSteps = stepsFromSegs(dec.segs, w, h, kerf, trim, boardIndex, false)
    const simRaw = simulate(w, h, kerf, rawSteps, placements, trim)
    if (simRaw.ok) {
      // 再试「同线合并」版以减少工步；合并后贯通区间可能越过别的料块（多切），
      // 只有合并版同样逐刀还原才采用，否则宁可不合并（多几刀也不能切错）。
      const mergedSteps = stepsFromSegs(dec.segs, w, h, kerf, trim, boardIndex, true)
      const simMerged = simulate(w, h, kerf, mergedSteps, placements, trim)
      if (simMerged.ok) return { ok: true, steps: mergedSteps, sim: simMerged }
      return { ok: true, steps: rawSteps, sim: simRaw }
    }
    if (!firstErr) firstErr = simRaw.errors[0] ?? '刀路无法逐刀还原零件'
    if (performance.now() - t0 > TIME_BUDGET_MS) break
  }
  if (enumerated === 0) {
    return { ok: false, reason: '调整后的摆法不存在贯通（推台锯可加工）分解' }
  }
  if (budget.left <= 0 || performance.now() - t0 > TIME_BUDGET_MS) {
    return {
      ok: false,
      reason: `候选刀路过多，在预算内（${ENUM_BUDGET} 个方案 / ${TIME_BUDGET_MS}ms）没找到能逐刀还原的刀路`
    }
  }
  return { ok: false, reason: firstErr || '枚举到的刀路都无法把每块零件精确还原' }
}

export interface SimResult {
  ok: boolean
  errors: string[]
  leaves: Rect[]
  /** 模拟结束后未归属零件的内部料块（余料/碎料）。 */
  leftovers: Rect[]
  /** 锯路吃掉的面积（mm²，按实际劈开的料块计）。 */
  kerfAreaMm2: number
}

/**
 * 逐刀模拟：维护当前矩形集合，每步按锯路居中劈开相交矩形，最后核对：
 * 1) 每个零件都能在最终料块中找到一块尺寸/位置精确匹配的（容差 SIZE_TOL）；
 * 2) 每一刀在它相交的每个料块上必须真正贯通（贯通区间覆盖料块全长），
 *    覆盖不到就说明照此刀路会多切/少切，直接判错；
 * 3) 面积守恒：Σ料块面积 + Σ锯路吃掉面积 = 原板面积（容差 AREA_TOL）。
 */
export function simulate(
  w: number,
  h: number,
  kerf: number,
  steps: CutStep[],
  placements: Placement[],
  trim = 0
): SimResult {
  const errors: string[] = []
  let leaves: Rect[] = [{ x: 0, y: 0, w, h }]
  let kerfArea = 0
  for (const st of steps) {
    const next: Rect[] = []
    for (const leaf of leaves) {
      const alongStart = st.axis === 'v' ? leaf.y : leaf.x
      const alongSize = st.axis === 'v' ? leaf.h : leaf.w
      const intersects =
        st.span[1] > alongStart + EPS && st.span[0] < alongStart + alongSize - EPS
      const across = st.axis === 'v' ? leaf.x : leaf.y
      const acrossSize = st.axis === 'v' ? leaf.w : leaf.h
      const canSplit =
        intersects && st.at > across + EPS && st.at < across + acrossSize - EPS
      if (!canSplit) {
        next.push(leaf)
        continue
      }
      // 贯通校验：锯开料块时，贯通区间必须覆盖该料块沿刀方向的全长；
      // 只盖住一截却按整宽劈开，等于多切了一刀，照做必错。
      if (
        st.span[0] > alongStart + SIZE_TOL ||
        st.span[1] < alongStart + alongSize - SIZE_TOL
      ) {
        errors.push(
          `第 ${st.order + 1} 刀（${st.axis === 'v' ? '竖切' : '横切'} ${Math.round(st.at)}mm）` +
            `在 ${Math.round(leaf.w)}×${Math.round(leaf.h)} 料块上没有贯通，照此下锯会多切`
        )
        next.push(leaf)
        continue
      }
      if (st.axis === 'v') {
        const wl = st.at - kerf / 2 - leaf.x
        const wr = leaf.x + leaf.w - (st.at + kerf / 2)
        if (wl >= -EPS && wr >= -EPS) {
          next.push({ x: leaf.x, y: leaf.y, w: wl, h: leaf.h })
          next.push({ x: st.at + kerf / 2, y: leaf.y, w: wr, h: leaf.h })
          kerfArea += kerf * leaf.h
        } else {
          next.push(leaf)
        }
      } else {
        const hb = st.at - kerf / 2 - leaf.y
        const ht = leaf.y + leaf.h - (st.at + kerf / 2)
        if (hb >= -EPS && ht >= -EPS) {
          next.push({ x: leaf.x, y: leaf.y, w: leaf.w, h: hb })
          next.push({ x: leaf.x, y: st.at + kerf / 2, w: leaf.w, h: ht })
          kerfArea += kerf * leaf.w
        } else {
          next.push(leaf)
        }
      }
    }
    leaves = next
  }

  const leavesArea = leaves.reduce((a, lf) => a + lf.w * lf.h, 0)
  if (Math.abs(leavesArea + kerfArea - w * h) > AREA_TOL) {
    errors.push(
      `面积不守恒：料块 ${Math.round(leavesArea)}mm² + 锯路 ${Math.round(kerfArea)}mm² ` +
        `≠ 原板 ${w * h}mm²（差 ${Math.round(leavesArea + kerfArea - w * h)}mm²），有漏切或多切`
    )
  }

  const usedLeaves = new Set<Rect>()
  for (const p of placements) {
    const match = leaves.find((lf) => {
      if (usedLeaves.has(lf)) return false
      return (
        Math.abs(lf.x - p.x) <= SIZE_TOL &&
        Math.abs(lf.y - p.y) <= SIZE_TOL &&
        Math.abs(lf.x + lf.w - (p.x + p.lenMm)) <= SIZE_TOL &&
        Math.abs(lf.y + lf.h - (p.y + p.widMm)) <= SIZE_TOL
      )
    })
    if (!match) {
      errors.push(`零件 ${p.code} 在切割模拟结果中找不到对应尺寸的矩形（切出来的尺寸对不上）`)
    } else {
      usedLeaves.add(match)
    }
  }

  const freeLeaves = leaves.filter((lf) => !usedLeaves.has(lf))
  const { leftovers } = classifyLeftovers(freeLeaves, w, h, trim)
  for (const lf of leftovers) {
    // 所有切线都源自零件边缘（+锯路），非零件叶只要不与任何零件重叠，
    // 就是余料/碎料（可能被贯通刀进一步切碎，但不影响加工正确性）
    const hitsPart = placements.some(
      (p) =>
        lf.x < p.x + p.lenMm - EPS &&
        p.x < lf.x + lf.w - EPS &&
        lf.y < p.y + p.widMm - EPS &&
        p.y < lf.y + lf.h - EPS
    )
    if (hitsPart) {
      errors.push(`模拟出现切入零件区域的矩形 ${Math.round(lf.w)}×${Math.round(lf.h)}`)
    }
  }
  return { ok: errors.length === 0, errors, leaves, leftovers, kerfAreaMm2: kerfArea }
}

/** 车间实际锯切工步数：修边刀同规格板只算一次（叠切），内部刀按板计。 */
export function countSawOps(sheets: SheetResult[]): number {
  const trimKeys = new Set<string>()
  let internal = 0
  for (const s of sheets) {
    for (const st of s.steps) {
      if (st.kind === 'trim') {
        trimKeys.add(`${s.wMm}x${s.hMm}-${st.axis}@${st.at}`)
      } else {
        internal++
      }
    }
  }
  return trimKeys.size + internal
}
