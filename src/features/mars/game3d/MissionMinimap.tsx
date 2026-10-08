/**
 * 任务小地图（纲领第九节：右下角网格小地图 · UI/UX 重设计 P1 可缩放版）。
 *
 * 实时显示：已探明区 / 通行分档 / 规划路线 / 漫游车位置 / 目标点 / 起点，
 * 以及复盘阶段的上一轮（v1）幽灵轨迹，用于 v1/v2 对照。
 *
 * 交互：默认 96×96 缩略，点击放大到 160×160；规划/选择/行驶阶段自动放大，
 * 方便玩家看清路线与地形关系。
 *
 * 数据从 stage 命令式读取（grid / path / rover），用 snapshot 变化作为重绘触发，
 * 不把整张网格塞进 React 状态树。
 */
import { useEffect, useRef, useState } from 'react'
import type { MissionSnapshot, ScanCandidate } from './core/mission'
import type { MarsStage } from './stage'
import { sampleMinimap, sampleGlyphs, phaseShowsRiskGlyphs, glyphScaleVisible, GLYPH_CODE, worldToMini } from './render/minimap'
import { POI_COLOR } from './render/pois'
import { BASIN_SIZE } from './core/heightField'

const RES = 64
const SMALL_VIEW = 96 // 默认缩略尺寸（css 像素）
const LARGE_VIEW = 160 // 点击放大/规划阶段尺寸

/** 规划、路径选择、实测、复盘阶段自动放大地图，便于决策（缺口-6：report 也放大以显示字形）。 */
function phaseNeedsZoom(phase: MissionSnapshot['phase']): boolean {
  return phase === 'plan' || phase === 'drive' || phase === 'revise' || phase === 'report'
}

/** 在小地图画布上画一个风险字形（形状 + 颜色双重编码，色觉障碍可读）。 */
function drawGlyph(ctx: CanvasRenderingContext2D, code: number, cx: number, cy: number, s: number) {
  const r = s * 0.4
  ctx.save()
  if (code === GLYPH_CODE.blocked) {
    // ✕ 交叉线
    ctx.strokeStyle = '#fff0ec'
    ctx.lineWidth = Math.max(1.2, s * 0.22)
    ctx.beginPath()
    ctx.moveTo(cx - r, cy - r)
    ctx.lineTo(cx + r, cy + r)
    ctx.moveTo(cx + r, cy - r)
    ctx.lineTo(cx - r, cy + r)
    ctx.stroke()
  } else if (code === GLYPH_CODE.caution) {
    // ▴ 三角
    ctx.fillStyle = '#ffd9a0'
    ctx.beginPath()
    ctx.moveTo(cx, cy - r)
    ctx.lineTo(cx + r, cy + r)
    ctx.lineTo(cx - r, cy + r)
    ctx.closePath()
    ctx.fill()
  } else if (code === GLYPH_CODE.rock) {
    // ◯ 圆环
    ctx.strokeStyle = '#cfe0f5'
    ctx.lineWidth = Math.max(1.2, s * 0.2)
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()
  } else if (code === GLYPH_CODE.soft) {
    // • 实心点
    ctx.fillStyle = '#ffe6b0'
    ctx.beginPath()
    ctx.arc(cx, cy, r * 0.78, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

export type MissionMinimapProps = {
  stage: MarsStage | null
  snapshot: MissionSnapshot
  /** 侦察阶段候选扫描点，在地图上以淡青色标记提示目标方向。 */
  candidates?: ScanCandidate[]
}

export function MissionMinimap({ stage, snapshot, candidates = [] }: MissionMinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [zoomed, setZoomed] = useState(false)

  // 规划/实测/复盘阶段自动放大；其余阶段保持用户手动选择（默认小）。
  useEffect(() => {
    setZoomed(phaseNeedsZoom(snapshot.phase))
  }, [snapshot.phase])

  const view = zoomed ? LARGE_VIEW : SMALL_VIEW

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !stage) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const scale = view / RES

    // 缺口-6：DPR 清晰渲染——绘制缓冲区按设备像素比放大，再整体缩放，避免字形/线条被抗锯齿糊掉。
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
    if (canvas.width !== view * dpr) canvas.width = view * dpr
    if (canvas.height !== view * dpr) canvas.height = view * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // --- 底图：降采样网格 ---
    const bmp = sampleMinimap(stage.mission.grid, RES)
    // 先把位图画到离屏，再放大到画布（保留像素块的"网格感"）
    const off = document.createElement('canvas')
    off.width = RES
    off.height = RES
    const octx = off.getContext('2d')
    if (!octx) return
    const img = octx.createImageData(RES, RES)
    img.data.set(bmp)
    octx.putImageData(img, 0, 0)
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, view, view)
    ctx.drawImage(off, 0, 0, RES, RES, 0, 0, view, view)

    // --- 逐格风险字形（A2）：缺口-6 门控——仅当每格像素 ≥ MIN_GLYPH_SCALE 才画，
    // 否则亚像素字形糊成噪点；小缩略图靠颜色分档即可。 ---
    const showGlyphs = phaseShowsRiskGlyphs(snapshot.phase) && glyphScaleVisible(scale)
    if (showGlyphs) {
      const glyphs = sampleGlyphs(stage.mission.grid, RES)
      for (let my = 0; my < RES; my += 1) {
        for (let mx = 0; mx < RES; mx += 1) {
          const code = glyphs[my * RES + mx]
          if (code === GLYPH_CODE.none || code === GLYPH_CODE.unknown) continue
          const cx = mx * scale + scale / 2
          const cy = my * scale + scale / 2
          drawGlyph(ctx, code, cx, cy, scale)
        }
      }
    }

    const toPx = (x: number, z: number) => {
      const { mx, my } = worldToMini(x, z, RES)
      return { px: mx * scale, py: my * scale }
    }

    // --- 缺口-7：盲区指挥命令揭示区高亮。明确"这是你刚指挥探明的一片"，与常规扫描揭示区分开。 ---
    for (const br of snapshot.blindReveals) {
      const { px, py } = toPx(br.x, br.z)
      const rPx = (br.radius / BASIN_SIZE) * RES * scale
      // 淡青填充：标记被指挥揭示的范围
      ctx.fillStyle = 'rgba(120, 224, 208, 0.18)'
      ctx.beginPath()
      ctx.arc(px, py, rPx, 0, Math.PI * 2)
      ctx.fill()
      // 虚线高亮环：边界描边，强化"已揭示 vs 仍未知"的区分
      ctx.strokeStyle = 'rgba(120, 224, 208, 0.95)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 3])
      ctx.beginPath()
      ctx.arc(px, py, rPx, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
      // 圆心标记：你下达指挥命令的那个点
      ctx.fillStyle = '#7af0e0'
      ctx.beginPath()
      ctx.arc(px, py, 2.2, 0, Math.PI * 2)
      ctx.fill()
    }

    // --- 上一轮（v1）幽灵轨迹：复盘/记录阶段才画 ---
    const runs = snapshot.runs
    if (runs.length > 0 && (snapshot.phase === 'revise' || snapshot.phase === 'report')) {
      const trace = runs[runs.length - 1].trace
      if (trace.length > 1) {
        ctx.strokeStyle = 'rgba(150, 170, 210, 0.55)'
        ctx.lineWidth = 2
        ctx.setLineDash([4, 3])
        ctx.beginPath()
        trace.forEach((p, k) => {
          const { px, py } = toPx(p.x, p.z)
          if (k === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        })
        ctx.stroke()
        ctx.setLineDash([])
      }
    }

    // --- 当前规划路线（v2）：实线 ---
    const path = stage.mission.path()
    if (path.length > 1) {
      ctx.strokeStyle = 'rgba(120, 224, 208, 0.95)'
      ctx.lineWidth = 2.5
      ctx.lineJoin = 'round'
      ctx.beginPath()
      path.forEach((c, k) => {
        const { px, py } = toPx(c.x, c.z)
        if (k === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      })
      ctx.stroke()
    }

    const dot = (x: number, z: number, color: string, r: number) => {
      const { px, py } = toPx(x, z)
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(px, py, r, 0, Math.PI * 2)
      ctx.fill()
    }

    // 起点（浅蓝）/ 目标（金黄方块）
    dot(stage.field.start.x, stage.field.start.z, '#7fd0ff', 3)
    {
      const { px, py } = toPx(stage.field.goal.x, stage.field.goal.z)
      ctx.fillStyle = '#ffd24a'
      ctx.fillRect(px - 3.5, py - 3.5, 7, 7)
      ctx.strokeStyle = '#7a5a10'
      ctx.lineWidth = 1
      ctx.strokeRect(px - 3.5, py - 3.5, 7, 7)
    }

    // POI 信标：按类型配色，玩家进入交互半径的那个画一圈高亮环
    for (const p of snapshot.pois) {
      const color = POI_COLOR[p.kind] ?? '#ffffff'
      const active = snapshot.nearbyPoi?.id === p.id
      dot(p.x, p.z, color, active ? 4 : 2.6)
      if (active) {
        const { px, py } = toPx(p.x, p.z)
        ctx.strokeStyle = color
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(px, py, 7, 0, Math.PI * 2)
        ctx.stroke()
      }
    }

    // 侦察阶段候选扫描点：只在 scan 阶段显示，淡青色小圈提示目标方向
    if (snapshot.phase === 'scan') {
      for (const c of candidates) {
        dot(c.x, c.z, '#aee6ff', 2.2)
      }
    }

    // 漫游车当前位置：逻辑位 = 手动模式取车体、实测取路径位、其余取停靠位（与 stage 渲染一致）
    const rover = stage.mission.roverPosition()
    // 车体外圈 + 朝向线
    const { px, py } = toPx(rover.x, rover.z)
    ctx.fillStyle = '#ff6b4a'
    ctx.beginPath()
    ctx.arc(px, py, 4, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#2a1810'
    ctx.lineWidth = 1.5
    ctx.stroke()
    if (snapshot.manual) {
      const heading = stage.mission.manualPose().heading
      // 世界前向量 = (cos h, -sin h)，x→mx、z→my 一一对应，直接作为屏幕增量
      const hx = Math.cos(heading)
      const hy = -Math.sin(heading)
      ctx.strokeStyle = '#ffd24a'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(px, py)
      ctx.lineTo(px + hx * 9, py + hy * 9)
      ctx.stroke()
    }
  }, [stage, snapshot, view])

  return (
    <button
      type="button"
      className={`mars-minimap${zoomed ? ' is-zoomed' : ''}`}
      aria-label={zoomed ? '放大小地图，点击缩小' : '缩小小地图，点击放大'}
      title={zoomed ? '点击缩小地图' : '点击放大地图'}
      onClick={() => setZoomed((z) => !z)}
    >
      <canvas
        ref={canvasRef}
        width={view}
        height={view}
        style={{ width: view, height: view }}
        className="mars-minimap__canvas"
        aria-hidden="true"
      />
      <div className="mars-minimap__legend">
        <span><i className="is-rover" />火星车</span>
        <span><i className="is-goal" />目标</span>
        <span><i className="is-route" />路线</span>
      </div>
      {phaseShowsRiskGlyphs(snapshot.phase) && (
        <div className="mars-minimap__legend mars-minimap__legend--risk">
          <span>✕禁行</span>
          <span>◯岩石</span>
          <span>•软沙</span>
          <span>△谨慎</span>
        </div>
      )}
    </button>
  )
}
