// 手工微调：落点判定（零件交换 / 余料框移位）、槽位尺寸前置检查与落板重算。
// 同一张板的摆法、刀路、切后尺寸、余料位置/尺寸、利用率、已微调标记全部在此一次性
// 重算并写回同一个 SheetResult，保证排样结果页、裁切步骤页、余料登记与本机存档同源。
import type { Job, Placement, SheetResult } from '../types'
import { guillotineViolation } from './geometry'
import { offcutsFromLeaves, rebuildFromPlacementsChecked, simulate } from './cuts'

export interface DropPoint {
  instanceId: string
  xMm: number // 松手时零件左上角（mm，显示坐标，按整数毫米解释）
  yMm: number
}

/** 槽位能否容纳零件：零件不大于槽；缝隙为 0（严丝合缝）或 ≥ 锯路（下得了刀）。 */
export function slotFits(
  slotW: number,
  slotH: number,
  pw: number,
  ph: number,
  kerf: number
): boolean {
  const clean = (avail: number, size: number): boolean => {
    const gap = avail - size
    return gap >= -0.5 && (gap <= 0.5 || gap >= kerf - 0.5)
  }
  return clean(slotW, pw) && clean(slotH, ph)
}

/**
 * 落点前置判定：先说清落点在哪里（落零件上 = 交换 / 落余料框 = 移位 / 都不是），
 * 再做能当场判定的槽位尺寸检查：
 * - 交换两件：每件都要能装进对方让出的矩形。零件比槽小（留 0 或 ≥锯路 的余料）合法；
 *   零件比槽大一定放不下，报清是哪一件、槽与零件各是多大；
 * - 余料框移位：余料框是独立空框，零件就位尺寸大于框尺寸一定失败，当场说清；
 * - 两处都不在：不动布局，报清落点不在余料框/零件上。
 * 通过前置检查后，能否真正贯通下锯仍由 guillotine + 逐刀模拟在 commitAdjustment 判定。
 */
export function planDrop(
  sheet: SheetResult,
  drop: DropPoint,
  kerf: number
): { error: string } | { placements: Placement[] } {
  const TOL = 2 // mm，松手判定容差（显示坐标按毫米取整）
  const placements = sheet.placements.map((p) => ({ ...p }))
  const moved = placements.find((p) => p.instanceId === drop.instanceId)
  if (!moved) return { error: '未找到被拖动的零件' }

  const inRect = (rx: number, ry: number, rw: number, rh: number): boolean =>
    drop.xMm >= rx - TOL &&
    drop.yMm >= ry - TOL &&
    drop.xMm <= rx + rw + TOL &&
    drop.yMm <= ry + rh + TOL

  const target = sheet.placements.find(
    (p) => p.instanceId !== drop.instanceId && inRect(p.x, p.y, p.lenMm, p.widMm)
  )
  if (target) {
    const other = placements.find((p) => p.instanceId === target.instanceId)!
    // moved 进 other 的槽、other 进 moved 的槽：任一方向装不下都要说明
    const movedFits = slotFits(other.lenMm, other.widMm, moved.lenMm, moved.widMm, kerf)
    const otherFits = slotFits(moved.lenMm, moved.widMm, other.lenMm, other.widMm, kerf)
    if (!movedFits || !otherFits) {
      const parts: string[] = []
      if (!movedFits)
        parts.push(
          `${moved.code}（${Math.round(moved.lenMm)}×${Math.round(moved.widMm)}mm）装不进 ${other.code} 的槽位（${Math.round(other.lenMm)}×${Math.round(other.widMm)}mm）`
        )
      if (!otherFits)
        parts.push(
          `${other.code}（${Math.round(other.lenMm)}×${Math.round(other.widMm)}mm）装不进 ${moved.code} 的槽位（${Math.round(moved.lenMm)}×${Math.round(moved.widMm)}mm）`
        )
      return { error: `槽位尺寸不合，无法交换：${parts.join('；')}` }
    }
    const ax = moved.x
    const ay = moved.y
    moved.x = other.x
    moved.y = other.y
    other.x = ax
    other.y = ay
    return { placements }
  }

  const oc = sheet.offcuts.find((o) => inRect(o.x, o.y, o.wMm, o.hMm))
  if (oc) {
    if (!slotFits(oc.wMm, oc.hMm, moved.lenMm, moved.widMm, kerf)) {
      return {
        error: `余料框装不下：余料框 ${oc.wMm}×${oc.hMm}mm，零件 ${moved.code} 就位尺寸 ${Math.round(
          moved.lenMm
        )}×${Math.round(moved.widMm)}mm`
      }
    }
    moved.x = oc.x
    moved.y = oc.y
    return { placements }
  }

  return { error: '落点不在任何余料框内，也没有落在另一件零件上（无法交换）' }
}

/**
 * 落板：guillotine 合法性 → 枚举刀路并逐刀模拟验证 → 重算切后尺寸/余料/利用率。
 * 任一步失败都返回错误信息且不写回；成功才整体替换同一张板的数据。
 */
export function commitAdjustment(
  job: Job,
  sheet: SheetResult,
  placements: Placement[]
): string | null {
  const kerf = job.kerfMm
  const trim = job.trimMm
  const bounds = {
    x: trim,
    y: trim,
    w: sheet.wMm - 2 * trim,
    h: sheet.hMm - 2 * trim
  }
  const violation = guillotineViolation(
    placements.map((p) => ({ id: p.instanceId, x: p.x, y: p.y, w: p.lenMm, h: p.widMm })),
    bounds,
    kerf
  )
  if (violation) return violation

  // 枚举每个 guillotine 分解并逐刀模拟，只接受能精确还原全部零件的方案
  const rebuilt = rebuildFromPlacementsChecked(
    sheet.wMm,
    sheet.hMm,
    kerf,
    trim,
    sheet.index,
    placements
  )
  if (rebuilt.status === 'timeout')
    return '微调刀路校验超时（枚举方案过多，超过 300ms 预算）；该摆法是否可加工未确认，已撤销未写回'
  if (rebuilt.status === 'unsolvable')
    return '调整后找不到可执行的贯通刀路：枚举到的每种切法逐刀模拟都不能精确还原全部零件（照此下锯会多切/少切一刀），已撤销'

  // 再以最终刀路复算一次（面积守恒 + 叶块反算余料），不通过就拒绝写回
  const steps = rebuilt.value.steps
  const sim = simulate(sheet.wMm, sheet.hMm, kerf, steps, placements)
  if (!sim.ok) return `调整后的刀路模拟不通过：${sim.errors.join('；')}`

  const offcuts = offcutsFromLeaves(sim.leaves, placements, sheet.wMm, sheet.hMm)
  const usedArea = placements.reduce((a, p) => a + p.origLen * p.origWid, 0)

  // 整体替换同一张板的数据：摆法/刀路/尺寸/余料/利用率/标记同源刷新
  sheet.placements = placements.map((p) => ({ ...p, adjusted: true }))
  sheet.steps = steps
  sheet.offcuts = offcuts
  sheet.usedAreaMm2 = usedArea
  sheet.utilization = usedArea / sheet.boardAreaMm2
  sheet.adjusted = true
  return null
}
