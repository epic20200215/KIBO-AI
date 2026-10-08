/**
 * 固定斜俯视工作相机。
 *
 * `AGENTS.md`「3D 任务舞台准入条件」第 2 条：相机为固定斜俯视或受限轨道，**不开放自由飞行**。
 * 这既是纲领约束也是教学需要——学生要读的是路线全局，不是风景。
 *
 * 因此这里只提供：
 * - 固定的俯仰角（不可改），保证任何时刻的空间读图方式一致；
 * - 受限的方位角微调（±30°），仅用于解决地形自遮挡；
 * - 弹簧阻尼跟随，速度带来的轻微 FOV 变化，冲击时的短促震动；
 * - 一段 ≤1.2 秒的克制入场环绕。
 *
 * `prefers-reduced-motion` 下：震动、FOV 变化、入场环绕全部关闭，跟随改为硬跟随。
 */
import { MathUtils, PerspectiveCamera, Vector3 } from 'three'

/**
 * 第三人称跟随相机（统一 3D 任务标准，见 AGENTS.md「3D 任务舞台准入条件」#2 修订）。
 *
 * 相机焦点始终锁定火星车（由 stage 每帧写入），火星车居中；只允许受限轨道微调
 * 与有限缩放——玩家无法把视角拉远到一眼看完全部场景。全局读图交给右下角小地图。
 */
/** 固定俯仰角（弧度）。约 17°，参考图是贴地低角度 vista：压低机位让台地/天空更辽阔，
 *  配合 BASE_DISTANCE=33 让 R-7 仍占画面核心，但地平线下移、Mars 感更强。 */
export const ELEVATION = 0.30 // 2026-09-02 用户拍板：默认回低角度第三人称跟车（不要 60° 顶视）。2026-09-02 09:30 试过 π/3 被否定
/** 基准方位角（弧度）。让主光成为侧逆光，地形起伏投出长影。 */
export const BASE_AZIMUTH = -0.57 // heading=1 保持相机在新朝向后
/** 方位角可调范围（弧度），约 ±30°。右键拖拽（orbit）模式解锁全周，但仍不平移。 */
const AZIMUTH_LIMIT = 0.52
/**
 * 基准视距（米）。第三人称跟车，R-7 必须占据画面核心但不遮挡前方路径。
 * 用户反馈"默认视角太高、火星车太小"，第一轮由 50m 收到 28m；第二轮参考图是贴地 vista，
 * 距离微调回 33m 并配合更低的 ELEVATION，让 R-7 仍占画面核心、但地平线下移、台地/天空更辽阔。
 */
export const BASE_DISTANCE = 33
/**
 * 玩家可用视距范围（米）。DCR-004 拍板值 [26,120]：上限 120m 仍远小于 1200m 盆地对角线，
 * 玩家无法一眼看完全部场景；下限 26m 允许观察车体细节且不易穿模。
 */
export const DISTANCE_RANGE: [number, number] = [26, 120]
/**
 * 评审/截图机位可用视距范围（米）。DCR-004 拍板值 [12,620]，宽于玩家范围，
 * 允许 `overview` 等机位拉远到 620m 做全局截帧；普通玩家路径（滚轮 `nudgeDistance`）
 * 只受 `DISTANCE_RANGE` 钳制。
 */
const DISTANCE_RANGE_QA: [number, number] = [12, 620]
/** 地图平移（WASD）速度，单位 米/秒。受限斜俯视下只平移焦点，不自由飞行。 */
const PAN_SPEED = 64

/**
 * 入场全景浏览的一站。
 * 镜头沿这些站点依次飞行：先俯瞰全场，最后降回到第三人称跟车机位。
 */
export type FlyoverStop = {
  /** 该地点在地面的世界坐标（y 由 stage 按地形高度补）。 */
  x: number
  z: number
  /** 面向玩家展示的地点名，用于 UI 字幕。 */
  label: string
  /** 该站的视距（米）。地点越大越远，最后一站回到跟车视距。 */
  distance: number
  /** 该站的方位角（弧度）。逐站微调，避免镜头朝向一成不变。 */
  azimuth: number
  /** 该站的俯仰角（弧度）。浏览段抬高俯瞰，最后一站落到跟车俯仰。 */
  elevation: number
  /** 从上一站飞到这一站用时（秒）。 */
  travel: number
  /** 抵达后停留多久（秒），让玩家看清这是什么地方。 */
  hold: number
}

export type CameraRig = {
  camera: PerspectiveCamera
  /** 暂停 rig 自动更新，供 QA 截图直接定位相机 */
  paused: boolean
  /** 设置关注点（通常是探测车位置） */
  setFocus: (x: number, y: number, z: number) => void
  /**
   * 播放入场全景浏览：镜头依次飞过 stops，最后停在最后一站。
   * 播放期间焦点由站点驱动，跟车弹簧暂停；播完自动交还给跟车逻辑。
   * reduced-motion 下直接跳过（返回 false），由调用方立刻进入常规视角。
   */
  playFlyover: (stops: FlyoverStop[], yAt: (x: number, z: number) => number) => boolean
  /** 是否正在播放入场全景浏览。 */
  isFlyoverPlaying: () => boolean
  /** 当前所在站点序号（0 起），未播放时为 -1。 */
  flyoverStopIndex: () => number
  /** 跳过入场浏览：立刻落到最后一站并交还控制权。 */
  skipFlyover: () => void
  /** 受限方位角微调，输入为增量弧度 */
  nudgeAzimuth: (delta: number) => void
  /** 视距调整（推近/拉远） */
  nudgeDistance: (delta: number) => void
  /** 绝对设置方位角（仍受 ±30° 限制），供固定机位截图使用 */
  setAzimuth: (value: number) => void
  /** 绝对设置视距，供固定机位截图使用 */
  setDistance: (value: number) => void
  /** 复位到第三人称跟随默认机位（跟车视角）。 */
  resetView: () => void
  /** 俯仰角微调（右键拖拽上行/下行）。orbit 模式下解锁更大范围。 */
  nudgeElevation: (delta: number) => void
  /** 绝对设置俯仰角（弧度）。 */
  setElevation: (value: number) => void
  /**
   * 受限地图平移（WASD 移动镜头）：u 为屏幕右(+)/左(-)，v 为屏幕前/上(+)/后(-)。
   * 方向随当前方位角旋转，只平移焦点（不自由飞行），并钳制在盆地范围内。
   */
  panScreen: (u: number, v: number, dt: number) => void
  /**
   * 自由轨道模式（RPG 操控）：解锁方位角到全周、俯仰到更大范围。
   * 关闭时回落到受限工作视角（±30° 方位、固定俯仰），符合教学读图需要。
   */
  setOrbitMode: (on: boolean) => void
  /** 让弹簧立即收敛到目标，消除截图时的入场瞬态 */
  snapToFocus: () => void
  /** 冲击震动，amount 约 0..1 */
  addShake: (amount: number) => void
  /** 速度用于 FOV 轻微变化，单位 米/秒 */
  setSpeed: (speed: number) => void
  /** 启动入场环绕（≤1.2 秒） */
  playIntro: () => void
  setReducedMotion: (on: boolean) => void
  setHeading: (h: number) => void
  update: (dt: number) => void
  setAspect: (aspect: number) => void
  dispose: () => void
}

export function createCameraRig(aspect = 16 / 9): CameraRig {
  const camera = new PerspectiveCamera(46, aspect, 0.5, 3000)

  const focus = new Vector3(0, 0, 0)
  const smoothFocus = new Vector3(0, 0, 0)
  const focusVel = new Vector3(0, 0, 0)
  const desiredPos = new Vector3()
  const shakeOffset = new Vector3()

  let azimuth = BASE_AZIMUTH
  let elevation = ELEVATION
  let distance = BASE_DISTANCE
  let orbitMode = false
  let shake = 0
  let speed = 0
  let smoothSpeed = 0
  let reducedMotion = false
  let introTime = -1
  let followHeading = 0
  let firstUpdate = true

  /**
   * 入场全景浏览状态。
   * `phase='travel'` 表示正在从 from 飞往 stops[i]；`phase='hold'` 表示已抵达、正在停留。
   * 播完后置 null，焦点交还给跟车弹簧；此时 smoothFocus 已被写成最后一站的焦点，
   * 所以交还瞬间不会有一次跳变。
   */
  type FlyState = {
    stops: FlyoverStop[]
    i: number
    phase: 'travel' | 'hold'
    t: number
    from: { x: number; y: number; z: number; distance: number; azimuth: number; elevation: number }
    /** 已解析好的站点焦点（含地形高度），避免在 update 里反复回调 yAt。 */
    pts: Array<{ x: number; y: number; z: number }>
    /** 累计推进时间（秒）。 */
    total: number
    /** 额定总时长 ×2 的兜底上限：极低帧机器上的最后一道保险。 */
    budget: number
  }
  let fly: FlyState | null = null
  /** 当前帧运镜想要的 FOV：飞行时略微拉开制造速度感，停站时收回。 */
  let flyFov = 46
  /** 确定性的震动波形：不使用随机数，用两个不同频率的正弦叠加 */
  let shakeClock = 0
  let paused = false

  const setFocus = (x: number, y: number, z: number) => {
    focus.set(x, y, z)
  }

  /** 五次平滑（首尾一阶、二阶导均为 0），飞行与落地都不会有速度突变。 */
  const smootherStep = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

  /** 入场浏览期间直接接管相机：算好当前焦点与球坐标偏移后返回 true。 */
  const updateFlyover = (step: number): boolean => {
    if (!fly) return false
    const f = fly
    const stop = f.stops[f.i]
    const to = f.pts[f.i]

    f.t += step
    f.total += step

    // 兜底：极低帧机器上（例如 <2fps 的老设备）运镜会被拖成几十秒的折磨。
    // 超过额定时长两倍就直接收尾——宁可少看两站，也不能把玩家按在椅子上等。
    if (f.total > f.budget) {
      finishFlyover()
      return true
    }

    // 默认 1（已抵达）；travel 阶段会按进度覆盖为 0..1。
    let k = 1
    if (f.phase === 'travel') {
      k = stop.travel > 0 ? Math.min(1, f.t / stop.travel) : 1
      if (k >= 1) {
        f.phase = 'hold'
        f.t = 0
      }
    }
    if (f.phase === 'hold') {
      k = 1
      if (f.t >= stop.hold) {
        // 抵达下一站；最后一站走完就收尾交还控制权。
        f.i += 1
        f.t = 0
        if (f.i >= f.stops.length) {
          finishFlyover()
          return true
        }
        f.phase = 'travel'
        const prev = f.stops[f.i - 1]
        const prevPt = f.pts[f.i - 1]
        f.from = {
          x: prevPt.x,
          y: prevPt.y,
          z: prevPt.z,
          distance: prev.distance,
          azimuth: prev.azimuth,
          elevation: prev.elevation,
        }
        // 关键：本帧必须停在"上一站"（新航段的起点）。若直接跳到新站点，
        // 画面会先闪一下目的地再弹回起点，看上去像镜头在抽搐。
        smoothFocus.set(f.from.x, f.from.y, f.from.z)
        focus.set(f.from.x, f.from.y, f.from.z)
        distance = f.from.distance
        azimuth = f.from.azimuth
        elevation = f.from.elevation
        // 本帧剩余时间不重复推进，下一帧再开始飞行。
        return true
      }
    }

    const e = smootherStep(Math.min(1, Math.max(0, k)))
    const cx = f.from.x + (to.x - f.from.x) * e
    const cy = f.from.y + (to.y - f.from.y) * e
    const cz = f.from.z + (to.z - f.from.z) * e
    const cd = f.from.distance + (stop.distance - f.from.distance) * e
    const ca = f.from.azimuth + (stop.azimuth - f.from.azimuth) * e
    const ce = f.from.elevation + (stop.elevation - f.from.elevation) * e

    smoothFocus.set(cx, cy, cz)
    focus.set(cx, cy, cz)
    distance = cd
    azimuth = ca
    elevation = ce
    // 速度感：飞行中把 FOV 拉开约 3°，停站时收回，比恒定 FOV 更有"在赶路"的观感。
    flyFov = f.phase === 'travel' ? 49 : 46
    return true
  }

  /** 收尾：把内部状态对齐到最后一站，后续帧无缝回到跟车弹簧。 */
  const finishFlyover = () => {
    if (!fly) return
    const last = fly.stops[fly.stops.length - 1]
    const lastPt = fly.pts[fly.stops.length - 1]
    smoothFocus.set(lastPt.x, lastPt.y, lastPt.z)
    focus.set(lastPt.x, lastPt.y, lastPt.z)
    focusVel.set(0, 0, 0)
    distance = last.distance
    azimuth = last.azimuth
    elevation = last.elevation
    fly = null
    introTime = -1
    firstUpdate = false
  }

  const update = (dt: number) => {
    if (paused) return

    const step = Math.min(dt, 1 / 20)

    if (firstUpdate) {
      smoothFocus.copy(focus)
      firstUpdate = false
    }

    // 入场全景浏览：完全接管焦点与球坐标，跟车弹簧本帧不参与。
    // 运镜单独把步长上限放宽到 1/4 秒：跟车弹簧的 1/20 上限是为了防止卡顿后过冲，
    // 但运镜是按时间插值的脚本动画，没有过冲问题；收紧只会让它越拖越长
    // （10fps 下按 1/20 推进会慢 2 倍，5fps 下慢 4 倍），把 9 秒变成半分钟的折磨。
    if (updateFlyover(Math.min(dt, 1 / 4))) {
      const cosE = Math.cos(elevation)
      const sinE = Math.sin(elevation)
      desiredPos.set(
        smoothFocus.x + distance * cosE * Math.sin(azimuth),
        smoothFocus.y + distance * sinE,
        smoothFocus.z + distance * cosE * Math.cos(azimuth),
      )
      camera.position.copy(desiredPos)
      camera.lookAt(smoothFocus)
      const targetFov = reducedMotion ? 46 : flyFov
      if (Math.abs(camera.fov - targetFov) > 0.01) {
        camera.fov += (targetFov - camera.fov) * Math.min(1, step * 6)
        camera.updateProjectionMatrix()
      }
      return
    }

    if (reducedMotion) {
      smoothFocus.copy(focus)
      focusVel.set(0, 0, 0)
      shake = 0
      introTime = -1
    } else {
      // 临界阻尼弹簧：无过冲，跟随手感稳定
      const omega = 7.5
      const ax = (focus.x - smoothFocus.x) * omega * omega - focusVel.x * 2 * omega
      const ay = (focus.y - smoothFocus.y) * omega * omega - focusVel.y * 2 * omega
      const az = (focus.z - smoothFocus.z) * omega * omega - focusVel.z * 2 * omega
      focusVel.x += ax * step
      focusVel.y += ay * step
      focusVel.z += az * step
      smoothFocus.x += focusVel.x * step
      smoothFocus.y += focusVel.y * step
      smoothFocus.z += focusVel.z * step
    }

    smoothSpeed += (speed - smoothSpeed) * Math.min(1, step * 3)

    let effectiveAzimuth = azimuth
    if (introTime >= 0 && !reducedMotion) {
      introTime += step
      const t = Math.min(1, introTime / 1.2)
      // easeOutCubic，从偏离 26° 回到目标方位
      const ease = 1 - Math.pow(1 - t, 3)
      effectiveAzimuth = azimuth + (1 - ease) * 0.46
      if (t >= 1) introTime = -1
    }

    const cosE = Math.cos(elevation)
    const sinE = Math.sin(elevation)
    // 镜头绝对世界方向（用户右键 orbit 控制），resetView 时才按当前 heading 算车尾。
    // flyover 期间 updateFlyover 提前 return 不走这里。
    const followAzimuth = effectiveAzimuth
    desiredPos.set(
      smoothFocus.x + distance * cosE * Math.sin(followAzimuth),
      smoothFocus.y + distance * sinE,
      smoothFocus.z + distance * cosE * Math.cos(followAzimuth),
    )

    if (shake > 0.0001 && !reducedMotion) {
      shakeClock += step
      shake = Math.max(0, shake - step * 3.4)
      const amp = shake * shake * 0.85
      shakeOffset.set(
        Math.sin(shakeClock * 47.3) * amp,
        Math.sin(shakeClock * 61.7) * amp * 0.7,
        Math.cos(shakeClock * 53.1) * amp,
      )
      desiredPos.add(shakeOffset)
    }

    camera.position.copy(desiredPos)
    camera.lookAt(smoothFocus)

    const targetFov = reducedMotion ? 46 : 46 + MathUtils.clamp(smoothSpeed * 0.34, 0, 4.5)
    if (Math.abs(camera.fov - targetFov) > 0.01) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, step * 4)
      camera.updateProjectionMatrix()
    }
  }

  return {
    camera,
    get paused() { return paused },
    set paused(v) { paused = v },
    setFocus,
    setHeading: (h: number) => { followHeading = h },
    playFlyover: (stops, yAt) => {
      // reduced-motion 下不做运镜：直接判定为"未播放"，调用方会立刻进入常规跟车视角。
      if (reducedMotion || !stops || stops.length === 0) return false
      const pts = stops.map((s) => ({ x: s.x, y: yAt(s.x, s.z), z: s.z }))
      const first = stops[0]
      const firstPt = pts[0]
      // 起手就落在第一站，避免第一帧从上一帧机位"弹"过去。
      smoothFocus.set(firstPt.x, firstPt.y, firstPt.z)
      focus.set(firstPt.x, firstPt.y, firstPt.z)
      focusVel.set(0, 0, 0)
      distance = first.distance
      azimuth = first.azimuth
      elevation = first.elevation
      const nominal = stops.reduce((sum, s) => sum + s.travel + s.hold, 0)
      flyFov = 46
      fly = {
        stops,
        i: 0,
        phase: 'hold',
        t: 0,
        from: {
          x: firstPt.x,
          y: firstPt.y,
          z: firstPt.z,
          distance: first.distance,
          azimuth: first.azimuth,
          elevation: first.elevation,
        },
        pts,
        total: 0,
        budget: nominal * 2 + 3,
      }
      introTime = -1
      firstUpdate = false
      return true
    },
    isFlyoverPlaying: () => fly !== null,
    flyoverStopIndex: () => (fly ? fly.i : -1),
    skipFlyover: () => {
      if (fly) finishFlyover()
    },
    nudgeAzimuth: (delta) => {
      // 右键拖拽自由旋转：方位角不钳制，允许无限圈转动。
      // 相机位置由 sin/cos(azimuth) 计算，方位角超出 ±π 在数学上完全等价，不会卡死。
      // （setAzimuth/resetView 等绝对设定入口仍可把机位收回到跟车朝向。）
      azimuth += delta
    },
    nudgeDistance: (delta) => {
      distance = MathUtils.clamp(distance + delta, DISTANCE_RANGE[0], DISTANCE_RANGE[1])
    },
    setAzimuth: (value) => {
      const hi = orbitMode ? Math.PI : BASE_AZIMUTH + AZIMUTH_LIMIT
      const lo = orbitMode ? -Math.PI : BASE_AZIMUTH - AZIMUTH_LIMIT
      azimuth = MathUtils.clamp(value, lo, hi)
    },
    setDistance: (value) => {
      distance = MathUtils.clamp(value, DISTANCE_RANGE_QA[0], DISTANCE_RANGE_QA[1])
    },
    /** 复位到第三人称跟随默认机位（跟车视角）。由 stage 的 `setFollow(true)` 调用。 */
    resetView: () => {
      // 复位即放弃浏览：QA 截帧与玩家重进跟车视角都不该被运镜打断。
      fly = null
      azimuth = followHeading - Math.PI /2
      elevation = ELEVATION
      distance = BASE_DISTANCE
      orbitMode = false
    },
    nudgeElevation: (delta) => {
      const hi = orbitMode ? 1.35 : ELEVATION + 0.18
      const lo = orbitMode ? 0.12 : ELEVATION - 0.18
      elevation = MathUtils.clamp(elevation + delta, lo, hi)
    },
    setElevation: (value) => {
      const hi = orbitMode ? 1.35 : ELEVATION + 0.18
      const lo = orbitMode ? 0.12 : ELEVATION - 0.18
      elevation = MathUtils.clamp(value, lo, hi)
    },
    panScreen: (u, v, dt) => {
      const s = PAN_SPEED * dt
      // 屏幕深处方向（W 前进 = 沿 -fwd）与屏幕右方向（D = 沿 +right）
      const fx = Math.sin(azimuth)
      const fz = Math.cos(azimuth)
      const rx = Math.cos(azimuth)
      const rz = -Math.sin(azimuth)
      focus.x = MathUtils.clamp(focus.x + (rx * u - fx * v) * s, -588, 588)
      focus.z = MathUtils.clamp(focus.z + (rz * u - fz * v) * s, -588, 588)
    },
    setOrbitMode: (on) => {
      orbitMode = on
      if (!on) {
        azimuth = followHeading - Math.PI /2
        elevation = ELEVATION
      }
    },
    snapToFocus: () => {
      fly = null
      smoothFocus.copy(focus)
      focusVel.set(0, 0, 0)
      shake = 0
      introTime = -1
      firstUpdate = false
    },
    addShake: (amount) => {
      shake = Math.min(1, shake + amount)
    },
    setSpeed: (v) => {
      speed = v
    },
    playIntro: () => {
      introTime = reducedMotion ? -1 : 0
    },
    setReducedMotion: (on) => {
      reducedMotion = on
    },
    update,
    setAspect: (a) => {
      camera.aspect = a
      camera.updateProjectionMatrix()
    },
    dispose: () => {
      // PerspectiveCamera 无需释放资源，保留接口以统一生命周期管理
    },
  }
}
