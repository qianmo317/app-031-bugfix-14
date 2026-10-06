// 手工微调的落点预判：在真正重算刀路之前，先把「放不放得下」说清楚。
//
// 两种落点，两类不合，分别报错，不许再冒出看不懂的话：
// - 拖到另一件零件上 = 交换：要求两件在对方腾出来的槽位里都放得下（含朝向选择），
//   装不下时指明是哪一件、哪个方向差多少、是不是纹理不让转；
// - 拖到余料框里 = 移位：余料必须放得下拖动件；
// - 两者都不是（空地、板外、修边区）：落点不在余料框内。
import type { Placement, SheetResult } from '../types'
import { EPS } from './geometry'

/** 拖放手抖容差（mm）：指针落在目标框边 0.5mm 内算命中。 */
export const HIT_TOL = 0.5

/** 放得下的判据：严丝合缝（0）或余隙 ≥ 锯路；0 < 余隙 < 锯路 时下不了刀。 */
export function gapFits(avail: number, size: number, kerf: number): boolean {
  const gap = avail - size
  return gap >= -EPS && (gap <= EPS || gap >= kerf - EPS)
}

export interface OrientChoice {
  pw: number
  ph: number
  rotated: boolean
}

/** 该零件允许的就位朝向：竖纹/横纹只给规定朝向（rotated 恒 false）；无要求可转。 */
export function allowedOrients(p: Placement): OrientChoice[] {
  if (p.grain === 'length') return [{ pw: p.origLen, ph: p.origWid, rotated: false }]
  if (p.grain === 'width') return [{ pw: p.origWid, ph: p.origLen, rotated: false }]
  if (p.origLen === p.origWid) return [{ pw: p.origLen, ph: p.origWid, rotated: false }]
  return [
    { pw: p.origLen, ph: p.origWid, rotated: false },
    { pw: p.origWid, ph: p.origLen, rotated: true }
  ]
}

export type FitResult =
  | { fits: true; choice: OrientChoice }
  | {
      fits: false
      /** 朝向不允许时提示；两个方向都放不下时给出差得最少的方向与缺口。 */
      grainLocked: boolean
      overX: number
      overY: number
    }

/** 判定 p 能否放进 wMm×hMm 的槽位（坐标系不旋转，只选就位朝向）。 */
export function fitInto(p: Placement, wMm: number, hMm: number, kerf: number): FitResult {
  const choices = allowedOrients(p)
  let best: { overX: number; overY: number } | null = null
  for (const c of choices) {
    if (gapFits(wMm, c.pw, kerf) && gapFits(hMm, c.ph, kerf)) return { fits: true, choice: c }
    const overX = Math.max(0, c.pw - wMm)
    const overY = Math.max(0, c.ph - hMm)
    if (!best || overX + overY < best.overX + best.overY) best = { overX, overY }
  }
  const b = best ?? { overX: p.origLen, overY: p.origWid }
  return { fits: false, grainLocked: choices.length === 1, overX: b.overX, overY: b.overY }
}

function mmGap(v: number): string {
  return `超 ${Math.round(v)}mm`
}

export type DropPlan =
  | { kind: 'noop' }
  | {
      kind: 'swap'
      targetId: string
      movedChoice: OrientChoice
      targetChoice: OrientChoice
    }
  | { kind: 'move'; offcut: { x: number; y: number } }
  | { kind: 'reject'; message: string }

/**
 * 解析一次拖放：
 * @param sheet 当前板
 * @param placements 拖后候选摆法（调用方已按交换/移位初步改过坐标，仅用于读槽位尺寸）
 * @param movedId 被拖零件 instanceId
 * @param xMm/yMm 松手点（板坐标，mm）
 */
export function planDrop(
  sheet: SheetResult,
  movedId: string,
  xMm: number,
  yMm: number,
  kerf: number
): DropPlan {
  const moved = sheet.placements.find((p) => p.instanceId === movedId)
  if (!moved) return { kind: 'reject', message: '找不到被拖动的零件' }

  const target = sheet.placements.find(
    (p) =>
      p.instanceId !== movedId &&
      xMm >= p.x - HIT_TOL &&
      yMm >= p.y - HIT_TOL &&
      xMm <= p.x + p.lenMm + HIT_TOL &&
      yMm <= p.y + p.widMm + HIT_TOL
  )
  const oc = sheet.offcuts.find(
    (o) =>
      xMm >= o.x - HIT_TOL &&
      yMm >= o.y - HIT_TOL &&
      xMm <= o.x + o.wMm + HIT_TOL &&
      yMm <= o.y + o.hMm + HIT_TOL
  )

  if (target) {
    // 交换：moved 进 target 腾出的槽（target 的就位尺寸），反之亦然
    const fitMoved = fitInto(moved, target.lenMm, target.widMm, kerf)
    if (!fitMoved.fits) {
      const why =
        fitMoved.grainLocked && (fitMoved.overX > EPS || fitMoved.overY > EPS)
          ? `槽位不合：${moved.code} 有纹理要求不能旋转，换到 ${target.code} 的位置，${directionText(fitMoved.overX, fitMoved.overY)}`
          : `槽位不合：${moved.code} 放不进 ${target.code} 腾出的位置，${directionText(fitMoved.overX, fitMoved.overY)}`
      return { kind: 'reject', message: why }
    }
    const fitTarget = fitInto(target, moved.lenMm, moved.widMm, kerf)
    if (!fitTarget.fits) {
      const why =
        fitTarget.grainLocked && (fitTarget.overX > EPS || fitTarget.overY > EPS)
          ? `槽位不合：${target.code} 有纹理要求不能旋转，换到 ${moved.code} 的位置，${directionText(fitTarget.overX, fitTarget.overY)}`
          : `槽位不合：${target.code} 放不进 ${moved.code} 腾出的位置，${directionText(fitTarget.overX, fitTarget.overY)}`
      return { kind: 'reject', message: why }
    }
    // 拖回原位（目标就在自己原来的位置上）算无效操作
    if (
      Math.abs(target.x - moved.x) <= EPS &&
      Math.abs(target.y - moved.y) <= EPS
    ) {
      return { kind: 'noop' }
    }
    return {
      kind: 'swap',
      targetId: target.instanceId,
      movedChoice: fitMoved.choice,
      targetChoice: fitTarget.choice
    }
  }

  if (oc) {
    const fit = fitInto(moved, oc.wMm, oc.hMm, kerf)
    if (!fit.fits) {
      return {
        kind: 'reject',
        message: `余料装不下：${moved.code}（${moved.origLen}×${moved.origWid}mm）` +
          `放不进 ${Math.round(oc.wMm)}×${Math.round(oc.hMm)}mm 的余料框，` +
          directionText(fit.overX, fit.overY) +
          (fit.grainLocked ? '（该件有纹理要求，不能旋转）' : '')
      }
    }
    if (Math.round(oc.x) === Math.round(moved.x) && Math.round(oc.y) === Math.round(moved.y)) {
      return { kind: 'noop' }
    }
    return { kind: 'move', offcut: { x: oc.x, y: oc.y } }
  }

  // 既不在零件上，也不在任何余料框内（空地 / 板边修边区 / 板外）
  const outOfBoard =
    xMm < 0 || yMm < 0 || xMm > sheet.wMm + HIT_TOL || yMm > sheet.hMm + HIT_TOL
  return {
    kind: 'reject',
    message: outOfBoard
      ? '落点不在板材内：只能拖到虚线余料框里，或拖到另一件零件上交换'
      : '落点不在余料框内：空地下不了贯通刀，请拖到虚线标注的余料矩形里，或拖到另一件零件上交换'
  }
}

function directionText(overX: number, overY: number): string {
  const parts: string[] = []
  if (overX > EPS) parts.push(`长度方向${mmGap(overX)}`)
  if (overY > EPS) parts.push(`宽度方向${mmGap(overY)}`)
  return parts.length > 0 ? parts.join('、') : '槽位没有能下锯的间隙（净距小于锯路）'
}

/** 按交换方案写回两件的就位朝向（无纹理件旋转时同步 lenMm/widMm 与 rotated）。 */
export function applySwapOrientations(
  placements: Placement[],
  movedId: string,
  plan: Extract<DropPlan, { kind: 'swap' }>
): void {
  const moved = placements.find((p) => p.instanceId === movedId)!
  const other = placements.find((p) => p.instanceId === plan.targetId)!
  moved.lenMm = plan.movedChoice.pw
  moved.widMm = plan.movedChoice.ph
  moved.rotated = plan.movedChoice.rotated
  other.lenMm = plan.targetChoice.pw
  other.widMm = plan.targetChoice.ph
  other.rotated = plan.targetChoice.rotated
}
