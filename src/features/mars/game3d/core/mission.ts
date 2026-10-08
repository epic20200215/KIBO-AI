/**
 * 火星任务的状态机与决策中枢。
 *
 * 这一层刻意不依赖 three：它就是"任务本身"。
 * 渲染只是它的一种呈现方式，测试可以在 node 下把整条闭环跑完。
 *
 * 闭环（对应纲领第三节"完整体验流程"）
 * ------------------------------------
 *   scan   多次扫描 → 决定"先看哪里"
 *   rules  设定坡度阈值 → 决定"什么算能走"
 *   plan   规划器按当前认知出路线 → 看到规则的后果
 *   drive  实测（M5）
 *   revise 复测与不确定性处置（M5）
 *   report 成果记录（M5）
 *
 * 扫描次数不设上限，玩家可自由多次扫描收集数据。
 * "数据不足"的压力来自地形规模本身——1200m 盆地远大于几次扫描能覆盖的范围，
 * 因此学生仍需在有限探测下做取舍，而不是被硬性次数卡死。
 */
import { CHANNEL_SPINE, WORLD_GOALS, WORLD_SEEDS, createHeightField, type HeightField } from './heightField'
import {
  createGrid,
  ROCK_BLOCK,
  SOFT_BLOCK,
  type Grid,
  type GridCell,
} from './grid'
import { createKnowledgeField, KNOW_RES, type KnowledgeField } from './knowledge'
import {
  DEFAULT_WEIGHTS,
  planPath,
  type Corridor,
  type PlanOptions,
  type PlanResult,
  type PlanWeights,
} from './planner'
import {
  ENERGY_PER_CAUTION_CELL,
  ENERGY_PER_CLIMB_METER,
  ENERGY_PER_DESCENT_METER,
  ENERGY_PER_METER,
  ENERGY_PER_ROCK_CELL,
  ENERGY_PER_SOFT_CELL,
  ENERGY_PER_LOWCONF_CELL,
  ENERGY_UNKNOWN_BEST,
  ENERGY_UNKNOWN_WORST,
  HAULER_BATTERY,
  LOW_CONFIDENCE_THRESHOLD,
  WORLD1_HAULER_BATTERY,
  worldProfileFor,
  type RouteProfile,
  type UncertaintyChoice,
  type WorldProfile,
} from './worldProfile'

/**
 * 能源常量、路线集合与相关类型已于 2026-09-05 下沉到 `worldProfile.ts`
 * （老大拍板：二号任务独立开发，不再往共享代码插分支）。
 *
 * 此处 re-export 是为了**保持对外 API 不变**——既有的
 * `import { HAULER_BATTERY } from './mission'`（含全部测试）继续有效，
 * 不需要改动任何调用方。新增代码请直接从 `worldProfile.ts` 取用。
 */
export {
  ENERGY_PER_CAUTION_CELL,
  ENERGY_PER_CLIMB_METER,
  ENERGY_PER_DESCENT_METER,
  ENERGY_PER_LOWCONF_CELL,
  ENERGY_PER_METER,
  ENERGY_PER_ROCK_CELL,
  ENERGY_PER_SOFT_CELL,
  ENERGY_UNKNOWN_BEST,
  ENERGY_UNKNOWN_WORST,
  HAULER_BATTERY,
  LOW_CONFIDENCE_THRESHOLD,
  WORLD1_HAULER_BATTERY,
}
export type { RouteProfile, UncertaintyChoice, WorldProfile }

/** 岩石度 / 软沙度阈值：与坡度阈值并列，共同决定「可通行 / 难走 / 禁行」三档。 */
export const CAUTION_ROCK = 0.4
export const BLOCKED_ROCK = 0.7
export const CAUTION_SOFT = 0.4
export const BLOCKED_SOFT = 0.7

export type MissionPhase = 'scan' | 'rules' | 'plan' | 'drive' | 'revise' | 'report'

/** 场景中的可交互点（POI）：操作台、样本站、任务目标。 */
export type PoiKind =
  | 'base-clean'
  | 'base-label'
  | 'base-train'
  | 'base-select'
  | 'sample-a'
  | 'sample-b'
  | 'sample-c'
  | 'maze-entrance'
  | 'energy-station'

export type Poi = {
  id: string
  kind: PoiKind
  label: string
  /** 该地点"是干什么的"说明文案，点击场景里的 UI 标记时弹出（需求 E③）。 */
  description: string
  /** 交互半径（米） */
  radius: number
  x: number
  z: number
  /**
   * 标签悬浮高度（米）。**缺省时回退**到 `sample-* → 16.5 / 其它 → 13.5`的旧规则
   * （一号零回归）。二号必须显式给：三个样本站高度差极大——
   * 巨砾 8.5 m、层理剖面 14 m、水冰点几乎贴地（仅 2 m 标记杆），
   * 沿用统一高度会让巨砾标签悬空、水冰点标签埋进地里（设计 §3.2 适配点）。
   */
  labelHeight?: number
}

/** 玩家背包中的物品/数据。 */
export type InventoryItem = {
  id: string
  label: string
  kind: 'sample' | 'data'
  /** 是否已完成清洗 */
  cleaned: boolean
  /** 是否已完成标注 */
  labeled: boolean
}

// ---------------------------------------------------------------------------
// 数据记录（学生要在清洗台 / 标注台逐条处理）
// ---------------------------------------------------------------------------

/** 一条数据的质量问题。null 表示这条数据读数是正常的。 */
export type DataFlaw = 'out-of-range' | 'duplicate' | 'missing' | null

/** 学生给一条数据的分类标签。null 表示还没标。 */
export type DataLabel = 'pass' | 'caution' | 'block'

/** 一条地形数据记录。一次采集会带回一批，学生逐条清洗、逐条标注。 */
export type DataRecord = {
  id: string
  /** 来源样本站标签（河床 / 沙丘 / 坑缘）。 */
  source: string
  /** 同一样本站内的数据序号（从 1 开始），用于清洗台和标注台对齐显示「数据 1 / 数据 2」。 */
  dataNumber: number
  /** 坡度读数（度）。out-of-range / missing 缺陷时该字段不可信，UI 按缺陷单独呈现。 */
  slopeDeg: number
  /** 岩石度 0..1。missing 缺陷时为 -1（缺失）。 */
  rock: number
  /** 软沙度 0..1。missing 缺陷时为 -1（缺失）。 */
  soft: number
  /** 数据缺陷。null=正常数据。 */
  flaw: DataFlaw
  /** 清洗决定：keep=保留 / drop=剔除 / null=还没决定。 */
  cleanChoice: 'keep' | 'drop' | null
  /** 标注结果：pass=可通行 / caution=难走 / block=禁行 / null=还没标。 */
  label: DataLabel | null
}

/** 数据缺陷的人话说明（面向 10–12 岁，不出现术语）。 */
export const DATA_FLAW_TEXT: Record<Exclude<DataFlaw, null>, string> = {
  'out-of-range': '坡度读数是 -999°，传感器不可能读出这个数',
  duplicate: '这条和上面另一条一模一样，是重复记录',
  missing: '岩石度和软沙度都是空的，数据不完整',
}

export const DATA_LABEL_TEXT: Record<DataLabel, string> = {
  pass: '可通行',
  caution: '难走',
  block: '禁行',
}

/** aiquests 六步 PBL 语言的细化版：清洗与标注拆分为两步，进度条随学生真实操作推进。 */
export type SixStepPhase =
  | 'discover'
  | 'find-data'
  | 'clean-data'
  | 'label-data'
  | 'make-ai'
  | 'verify-ai'
  | 'practice'

export const SIX_STEP_ORDER: SixStepPhase[] = [
  'discover',
  'find-data',
  'clean-data',
  'label-data',
  'make-ai',
  'verify-ai',
  'practice',
]

export const SIX_STEP_LABEL: Record<SixStepPhase, string> = {
  discover: '发现问题',
  'find-data': '找到数据',
  'clean-data': '清洗数据',
  'label-data': '标记数据',
  'make-ai': '训练AI工具',
  'verify-ai': '验证AI工具',
  practice: '实践测试',
}

export const PHASE_ORDER: MissionPhase[] = ['scan', 'rules', 'plan', 'drive', 'revise', 'report']

export const PHASE_LABEL: Record<MissionPhase, string> = {
  scan: '扫描地形',
  rules: '设定规则',
  plan: '规划路线',
  drive: '实地测试',
  revise: '修改重测',
  report: '记录成果',
}

/** 实测阶段的行驶速度（米/秒）。演示用，不是教学数值。当前较初版提速约 50%。 */
export const DRIVE_SPEED = 37.8

/**
 * 实测状态机。
 * - running：漫游车沿规划路线行驶中
 * - stuck：开到"规划器以为能走、真实地形却禁行"的格子——这就是 M5 要暴露的教学冲突
 * - arrived：到达终点
 */
export type DriveStatus = 'idle' | 'running' | 'stuck' | 'arrived'

/** 翻车原因，决定复盘时讲什么故事。 */
export type StuckReason = 'guess' | 'known' | null

export type DriveInfo = {
  status: DriveStatus
  /** 已行驶里程（米），供渲染定位漫游车 */
  progress: number
  /** 翻车点世界坐标（status==='stuck' 时有值） */
  stuckAt: { x: number; z: number } | null
  /** 翻车原因：guess=这段没数据硬猜的 / known=已探明但阈值没拦住 */
  stuckReason: StuckReason
  /** 翻车主导危险类型：slope=陡坡 / rock=岩石 / soft=深软沙（可脱困）；soft 以外都是硬障碍 */
  stuckHazard: 'slope' | 'rock' | 'soft' | null
  /** 是否陷在深软沙里（可脱困小游戏）；陡坡/岩石等硬障碍不算。 */
  softStuck: boolean
  /** 漫游车当前所处的路径格世界坐标；没有路线时为 null。评审机位靠它跟车。 */
  at: { x: number; z: number } | null
}

/** 扫描次数不设上限（需求 C）：玩家可无限次扫描，由地形规模本身制造"数据不足"的取舍压力。 */
/** 单次轨道扫描的探明半径（米）。1200m 盆地需要更大半径才能覆盖关键走廊。 */
export const SCAN_RADIUS = 140
/** 着陆时的近距成像半径（免费赠送，保证学生一开始不是全黑） */
const LANDING_REVEAL = 90
/** 地图 C 盲区指挥：下达命令时局部揭示的半径（模拟"局部后果预览"，不消耗扫描预算）。 */
const BLIND_PREVIEW_RADIUS = 55
/** 盲区指挥：验证车在盲区入口前停下的安全距离（米）。 */
const BLIND_HALT_MARGIN = 6

/**
 * 键盘可达的扫描候选点。
 *
 * 鼠标用户可以直接点地面任意位置扫描；候选点是给键盘和触屏用户的等价入口
 * （纲领第七节：不做键盘专属功能，也不做鼠标专属功能）。
 * 顺带把"该先看哪里"这个决策显式摆出来——这本身就是教学内容。
 */
export type ScanCandidate = {
  id: string
  label: string
  /** 为什么值得扫这里。不给结论，只给线索。 */
  hint: string
  x: number
  z: number
}

export function buildScanCandidates(field: HeightField, worldIndex = 0): ScanCandidate[] {
  const byId = new Map(field.landmarks.map((l) => [l.id, l]))
  const pick = (id: string, hint: string): ScanCandidate | null => {
    const l = byId.get(id)
    if (!l) return null
    return { id: l.id, label: l.label, hint, x: l.x, z: l.z }
  }
  /**
   * 「航线中段」扫描候选点。
   *
   * 2026-09-11 河道 S 型改造后：原几何中点 `(start+goal)/2` 会落在台地山丘上，
   * 脱离河道（老大截图反馈"航线中段应该放在河道底部"）。
   * 二号改为取**河道脊柱的中段点**（`CHANNEL_SPINE[9]`，弧长位置约 45%），
   * 数据驱动——河道再怎么改形状，这个点始终跟着河谷走。
   * 一号仍用几何中点（一号地形以起点→终点为轴，几何中点就在谷地内，零回归）。
   */
  const mid: ScanCandidate =
    worldIndex === 1
      ? {
          id: 'midway',
          label: '航线中段',
          hint: '航线中段正好落在主河道谷底。不看这里，路线中间就是一段空白。',
          x: CHANNEL_SPINE[9][0],
          z: CHANNEL_SPINE[9][1],
        }
      : {
          id: 'midway',
          label: '航线中段',
          hint: '起点到终点的直线中点。不看这里，路线中间就是一段空白。',
          x: (field.start.x + field.goal.x) / 2,
          z: (field.start.z + field.goal.z) / 2,
        }

  if (worldIndex === 1) {
    // 火星二号（外流河道）：候选点 = 地形决策点（主河道/古汉道/支谷盲区）+ 航线中段 + 终点周边
    //
    // 2026-09-09 老大反馈修正：原先这里还有 `landing`（起点）与 `sample-a` 两个候选点，
    // 但它们**与 POI 完全重合**——landing 落在主基地上（老大：基地只准有 4 个流程点，
    // 且那个点被基地建筑挡住点不到），sample-a 与样本站 POI 重叠成两个 UI 标记。
    // 故都撤掉，只保留不与任何 POI 重合的地形决策点。
    return [
      // 2026-09-11 第 11 条：沿河主道是 `knownOnly`，B 状态（只扫候选点）已知区太小，
      // 它被迫绕进未扫描区 → unk 33、worst 192 > 电池 170，**稳档反而跑不完**。
      // 补两个**河道脊柱上、且不与任何 POI 重合**的候选点（北凸段 + 南凹段），
      // 让 knownOnly 在扫完候选点后能沿河谷找到连续已知路。
      // 坐标取自 CHANNEL_SPINE[2]/[14]，与 sample-a/b/c、midway、channel 距离均 > 44m。
      {
        id: 'channel-north-bend',
        label: '主河道北弯',
        hint: '河道向北凸出的这一段。弯内外地形差别很大，值得先看一眼。',
        x: -190,
        z: 226,
      },
      {
        id: 'channel-south-bend',
        label: '主河道南弯',
        hint: '河道向南凹进的这一段。凹岸与凸岸的坡度是两回事。',
        x: -4,
        z: -217,
      },
      pick('channel', '主外流河道：谷底平缓是快速段，但两岸陡崖是否禁行要靠数据判断。'),
      pick('old-channel', '古汉道：废弃河曲，比现代河床浅、半埋细沙，松软度未知。'),
      pick('blind', '支谷盲区：被崖壁遮挡的低置信度区，扫描压不零它的不确定性。'),
      mid,
      pick('target', '终点能源站在阶地上，周边没探明，最后一段就是猜的。'),
    ].filter((c): c is ScanCandidate => c !== null)
  }

  return [
    pick('riverbed', '低洼河床，可能平坦好走，也可能是死路。'),
    pick('dune', '沙丘带坡度不高，但松软度未知。'),
    pick('crater', '坑缘是抬升的陡坡，绕还是穿要靠数据决定。'),
    pick('ridge', '脊背最短，但两侧陡坡容错极小。'),
    mid,
    pick('target', '终点周边没探明，最后一段就是猜的。'),
  ].filter((c): c is ScanCandidate => c !== null)
}

/**
 * 平衡插桩（P4）：在「严格只扫推荐点」的最乖学生场景下，
 * 测量规划路线上「没数据却真禁行」的隐藏格数。用于确认地形规模本身足以逼出
 * 「数据不足」（routeHasHiddenBlocked 为 true 才说明不是无脑全图扫就能覆盖）。
 * 纯函数、无 three 依赖，可在 node 下单测与报告真实比例。
 */
export type ScanBudgetCoverage = {
  worldIndex: number
  /** 实际用掉的扫描次数（= 已扫的推荐点数；扫描不再受预算上限限制） */
  scansApplied: number
  /** 路线上「未探明却真禁行」的格数 */
  routeHiddenBlocked: number
  /** 路线是否仍含 ≥1 隐藏禁行格（数据不足的实证） */
  routeHasHiddenBlocked: boolean
}

export function measureScanBudgetCoverage(worldIndex: number): ScanBudgetCoverage {
  const seed = WORLD_SEEDS[worldIndex] ?? WORLD_SEEDS[0]
  const field = createHeightField(seed, worldIndex)
  const m = createMission(field, worldIndex)
  const cands = buildScanCandidates(field, worldIndex)
  const budget = cands.length
  let scansApplied = 0
  for (const c of cands) {
    if (scansApplied >= budget) break
    if (m.scanAt(c.x, c.z).ok) scansApplied += 1
  }
  m.replan()
  const hidden = m.snapshot().hiddenBlocked
  return { worldIndex, scansApplied, routeHiddenBlocked: hidden, routeHasHiddenBlocked: hidden > 0 }
}

export type PlanSummary = {
  found: boolean
  /** 里程（米） */
  lengthM: number
  /** 经过的谨慎格数 */
  cautionCells: number
  /** 经过的未探测格数——路线里"猜的部分" */
  unknownCells: number
  /** A* 展开格数，用来讲"算法算了多少步" */
  expanded: number
  cost: number
  /** 规则快照：生成该路线时的阈值与权重，便于 v1/v2 对照复盘 */
  cautionDeg: number
  blockedDeg: number
  cautionRock: number
  blockedRock: number
  cautionSoft: number
  blockedSoft: number
  weights: PlanWeights
}

/** 一条候选路线的往返能源账。区间是因为未探明区到底好不好走得走了才知道。 */
export type RouteEnergy = {
  /** 单程里程（米） */
  oneWayM: number
  /** 往返里程（米） */
  roundTripM: number
  /** 单程经过的未探明格数 */
  unknownCells: number
  /** 单程经过的难走（谨慎）格数 */
  cautionCells: number
  /**
   * 单程经过的软沙格数（cell.scanned>=0.5 && cell.soft>0.5）。
   * 二号地图计入 certain（古汉道"必翻车"档的分轴）；一号地图总为 0（零回归护栏）。
   * 不暴露给 UI——只是能源账内部维度（铁律 #3 UI 不泄答案）。
   */
  softCells: number
  /** 单程经过的岩石格数（cell.scanned>=0.5 && cell.rock>阈值）。同 softCells 语义。 */
  rockCells: number
  /**
   * 单程经过的低置信度格数（已扫描但 confidence 低于阈值）。
   *
   * 这些格"扫过了但没看清"（支谷深处被崖壁遮挡），其不确定性**不可通过继续扫描消除**。
   * 因此它们的代价只计入 `worst`、不计入 `best`——这是赌档「best < B < worst」
   * 能够成立的机制基础（铁律 #6）。一号地图恒为 0。
   * 不暴露给 UI——只是能源账内部维度（铁律 #3 UI 不泄答案）。
   */
  lowConfCells: number
  /** 往返的确定耗电：里程 + 已探明难走路段，这部分是板上钉钉的 */
  certain: number
  /** 最省电的情况：未探明区底下全是好路 */
  best: number
  /** 最费电的情况：未探明区底下全是难走路 */
  worst: number
  /** 电池总量 */
  battery: number
}

/** 路径选择台展示的一条候选路线（规划摘要 + 风格标签与一句话说明 + 实际格路径）。 */
export type RouteCandidate = {
  /** 风格标签：走近路 / 绕远路 */
  label: string
  /** 一句话风险评估 */
  note: string
  summary: PlanSummary | null
  /** 实际规划出的格路径（用于 3D 场景里画出候选路线丝带对比）。 */
  path: GridCell[]
  /** 往返能源账。路径不可行时为 null。 */
  energy: RouteEnergy | null
}

// ---------------------------------------------------------------------------
// 采集车验证运行（自动驾驶，学生不能操控）
// ---------------------------------------------------------------------------

export type HaulerRunStatus =
  | 'idle'
  | 'outbound'
  | 'collecting'
  | 'returning'
  | 'success'
  | 'failed'

/** 一次采集车验证运行的实时状态。 */
export type HaulerRun = {
  status: HaulerRunStatus
  /** 当前这一段（去程 / 回程）的进度 0..1 */
  legProgress: number
  /** 整趟（去程 45% + 采集 10% + 回程 45%）的总进度 0..1 */
  progress: number
  /** 剩余能源 */
  energy: number
  /** 电池总量 */
  battery: number
  /** 已行驶里程（米） */
  drivenM: number
  /** 失败原因（人话）。成功/进行中为 null。 */
  failReason: string | null
  /** 本次验证采用的路线标签 */
  routeLabel: string
  /** 本次路线里未探明的格数（失败提示里要说清楚 AI 猜了多少格）。 */
  routeUnknown: number
}


/** 决策日志条目：学生每一步关键选择都留下可追溯记录。 */
export type DecisionEntry =
  | { type: 'scan'; x: number; z: number; scansLeft: number }
  | { type: 'thresholds'; cautionDeg: number; blockedDeg: number }
  | { type: 'weight'; key: keyof PlanWeights; value: number }
  | { type: 'plan'; lengthM: number; unknownCells: number; cautionCells: number }
  | { type: 'uncertainty'; choice: NonNullable<UncertaintyChoice>; reason: string }
  | { type: 'drive-start'; run: number }
  | { type: 'drive-end'; run: number; status: DriveStatus; progress: number }
  | { type: 'manual-start' }
  | { type: 'manual-end'; distance: number }
  | { type: 'collect'; poiId: string; label: string }
  | { type: 'interact'; poiId: string; label: string }
  | { type: 'blind-command'; x: number; z: number; radius: number }

/** 一次完整运行（v1/v2 ...）的记录。 */
export type RunRecord = {
  run: number
  /** 该次运行时的规划结果快照 */
  plan: PlanSummary | null
  /** 该次运行的最终状态 */
  status: DriveStatus
  /** 终点/翻车点的里程 */
  progress: number
  /** 车辆经过的世界坐标序列（简化，每 8m 取一个点） */
  trace: Array<{ x: number; z: number }>
  /** 不确定性处置选择 */
  uncertainty: UncertaintyChoice
  /** 选择理由 */
  reason: string
}

export type MissionSnapshot = {
  phase: MissionPhase
  scansLeft: number
  scansUsed: number
  /** 已探明比例 0..1 */
  coverage: number
  cautionDeg: number
  blockedDeg: number
  /** 岩石度阈值（0..1），供标注台显示参考。 */
  cautionRock: number
  blockedRock: number
  /** 软沙度阈值（0..1），供标注台显示参考。 */
  cautionSoft: number
  blockedSoft: number
  weights: PlanWeights
  plan: PlanSummary | null
  /** 是否已经至少扫描过一次（没扫描不允许进入规则阶段） */
  hasScanned: boolean
  /** 终点是否已被探明。没探明也允许规划，但要如实提示 */
  targetKnown: boolean
  /** 实测状态机（M5） */
  driveStatus: DriveStatus
  /** 实测已行驶里程（米），供 HUD 进度条 */
  driveProgress: number
  /** 翻车点（M5，status==='stuck' 时有值） */
  stuckAt: { x: number; z: number } | null
  /** 翻车原因：guess=没数据硬猜的 / known=已探明但阈值漏判 */
  stuckReason: StuckReason
  /** 翻车主导危险类型：slope=陡坡 / rock=岩石 / soft=深软沙（可脱困）；soft 以外都是硬障碍 */
  stuckHazard: 'slope' | 'rock' | 'soft' | null
  /** 是否陷在深软沙里（可脱困小游戏）；陡坡/岩石等硬障碍不算。 */
  softStuck: boolean
  /** 是否处于手动驾驶（RPG 操控）模式 */
  manual: boolean
  /** 电量 0..1，随行驶里程下降（用于太阳能板可见状态变化） */
  battery: number
  /** 路线里"没数据却真禁行"的格数——规划器猜错的那些，复盘时如实展示 */
  hiddenBlocked: number
  /** aiquests 六步 PBL 当前步骤 */
  sixStep: SixStepPhase
  /** 当前对"路线存在未知格"的处置选择（必须在进入 drive 前做出） */
  uncertaintyChoice: UncertaintyChoice
  /** 不确定性选择的理由文本 */
  uncertaintyReason: string
  /** 决策日志 */
  decisionLog: DecisionEntry[]
  /** 历次运行记录；v1/v2 对照靠它实现 */
  runs: RunRecord[]
  /** 上一个被保存为 v1 的规划结果（当前 v2 与之对照） */
  previousPlan: PlanSummary | null
  /** 场景中全部可交互点。 */
  pois: Poi[]
  /** 当前距离玩家最近的 POI（在交互范围内）。 */
  nearbyPoi: Poi | null
  /** 玩家背包：采集的样本/数据。 */
  inventory: InventoryItem[]
  /** 采集回来的原始地形数据记录（清洗 / 标注的对象）。 */
  records: DataRecord[]
  /** 清洗是否已全部做对并通过。 */
  cleaningDone: boolean
  /** 标注是否已全部做对并通过。 */
  labelingDone: boolean
  /** 采集车验证运行的实时状态。未出发时 status 为 'idle'。 */
  hauler: HaulerRun
  /** 是否已与某个操作台交互过（用于新手引导）。 */
  hasInteracted: boolean
  /** 导航 AI 是否已训练完成（消耗标注数据后变 true）。 */
  trained: boolean
  /** 导航 AI 信心值 0..1，由训练数据量/质量/覆盖/决策完整性决定，直接影响自动驾驶验证车成功率。 */
  aiConfidence: number
  /** 当前所在世界索引（地图 A/B/C）。 */
  worldIndex: number
  /** 当前地图的教学目标（P2 三段强制教学弧锚点）。 */
  worldGoal: { id: 'A' | 'B' | 'C'; label: string; brief: string; teaching: string }
  /** 路线上最长一段连续未探明的"盲区"（地图 C 高潮在此）。null 表示路线已全探明。 */
  blindZone: {
    startIndex: number
    endIndex: number
    entryDist: number
    lengthM: number
    entry: { x: number; z: number }
  } | null
  /** 验证车是否停在地图 C 盲区入口、等待学生下达指挥命令（P6）。 */
  awaitingBlindCommand: boolean
  /** 本次运行是否已下达过盲区指挥命令。 */
  blindCommanded: boolean
  /** 缺口-7：本局所有"盲区指挥命令"揭示的圆心（世界坐标 + 半径），供小地图画高亮环标记"这是你指挥探明的"。 */
  blindReveals: { x: number; z: number; radius: number }[]
  /**
   * 缺口-1 加固：本次到达（arrived）是否来自手动驾驶。
   * stepDrive（AI 验证车实测）到达恒为 false；若未来接入手动到达，置 true。
   * 用于 KIBO arrived 台词区分"AI 规划到达"与"你手控练车到达"，避免主线误念沙盒台词。
   */
  arrivedManual: boolean
  /** 是否已把数据交付能源站、完成整局任务。 */
  missionComplete: boolean
}

export type ScanOutcome =
  | { ok: true; gained: number; coverage: number }
  | { ok: false; reason: string }

/** 自动驾驶验证车（资源采集车）对当前选定路线的验证结果。 */
export type ValidationResult =
  | { ok: true; message: string }
  | { ok: false; reason: string; cell: { x: number; z: number } | null; distance: number }

export type Mission = {
  field: HeightField
  knowledge: KnowledgeField
  grid: Grid
  /** 当前规划结果（含仅供复盘的 hiddenBlocked） */
  result: () => PlanResult | null
  path: () => GridCell[]
  snapshot: () => MissionSnapshot
  scanAt: (x: number, z: number) => ScanOutcome
  setThresholds: (cautionDeg: number, blockedDeg: number) => void
  setWeight: (key: keyof PlanWeights, value: number) => void
  replan: () => PlanResult
  setPhase: (phase: MissionPhase) => void
  /** 推进到下一阶段（受前置条件约束） */
  advance: () => MissionPhase
  /** 进入实测：从起点重新跑 */
  startDrive: () => void
  /** 每帧推进实测（dt 秒），开到真实禁行格会翻车 */
  stepDrive: (dt: number) => void
  /** 退出实测（翻车/到达后退回修改阶段） */
  stopDrive: () => void
  /** 软沙脱困：把里程推过陷住的格子并恢复行驶（#53/#68）。仅 stuck 且属"没数据硬猜"时有效。 */
  escapeFromStuck: () => boolean
  /** 地图 C 盲区指挥（P6）：在盲区入口下达命令，局部揭示地形作为"后果预览"并放行验证车。 */
  /**
   * 下达盲区指挥命令（设计 §四 P6）。
   * @param choice `'proceed'` 继续前进（赌）｜`'reroute'` 返回重选路线（override plan）
   */
  issueBlindCommand: (choice?: 'proceed' | 'reroute') => boolean
  /** 实测当前状态（status / 里程 / 翻车点 / 原因） */
  driveInfo: () => DriveInfo
  /** 进入手动驾驶（RPG 操控 / 实践测试） */
  enterManual: () => void
  /** 退出手动驾驶 */
  exitManual: () => void
  /** 手动模式是否激活 */
  manualActive: () => boolean
  /** 手动位姿（位置/朝向/速度/里程） */
  manualPose: () => { x: number; z: number; heading: number; speed: number; distance: number }
  /** 漫游车逻辑世界坐标（手动模式取车体、实测取路径位、其余取停靠位）。 */
  roverPosition: () => { x: number; z: number }
  /** 设定手动输入（油门/转向 ∈ [-1,1]） */
  setManualInput: (throttle: number, steer: number) => void
  /** 每帧推进手动驾驶（dt 秒） */
  stepManual: (dt: number) => void
  /** 对"路线存在未知格"做出显式处置选择 */
  setUncertaintyChoice: (choice: UncertaintyChoice, reason: string) => void
  /** 取全部决策日志（用于 report 阶段生成任务记录） */
  getDecisionLog: () => DecisionEntry[]
  /** 取历次运行记录（v1/v2 对照） */
  getRuns: () => RunRecord[]
  reset: () => void
  /** 与最近的 POI 交互（玩家在半径内时生效）。返回是否成功。 */
  interact: () => boolean
  /** 取当前玩家位置附近的 POI（供 HUD 显示交互提示）。 */
  nearbyPoi: () => Poi | null
  /** 全部 POI（坐标固定，供 3D 信标与地图一次性构建）。 */
  pois: () => Poi[]
  /** 已交互完成的 POI id 集合，供 3D 信标把"已完成"地标变色提示。 */
  completedPoiIds: () => Set<string>
  /** 消耗已标注数据，训练导航 AI。标注数据为空时返回 false。训练会计算 aiConfidence。 */
  train: () => boolean
  /** 取当前导航 AI 信心值（0..1）。 */
  aiConfidence: () => number
  /** 派遣自动驾驶验证车（资源采集车）沿当前路线验证 AI 路线是否成立。 */
  validateRouteWithAI: () => ValidationResult
  /** 应用 AI 验证失败：把失败点揭示为训练样本，并切换到 revise 阶段。 */
  applyAIValidationFailure: (cell: { x: number; z: number }) => void
  /** 生成 2 条候选路线（走近路 / 绕远路），不改变当前路线，仅供路径选择台展示。 */
  candidatePaths: () => RouteCandidate[]
  /** 选定一条候选路线作为当前规划结果，并记录决策。 */
  selectCandidate: (index: number) => boolean
  // --- 数据清洗 / 标注（学生逐条操作，不是一键完成）---
  /** 学生在清洗台对某条数据做出保留/剔除决定。 */
  setRecordCleanChoice: (id: string, choice: 'keep' | 'drop') => void
  /**
   * 提交清洗结果。返回是否正确，以及每条判错的理由（人话）。
   * 规则：有缺陷的数据必须剔除，正常数据必须保留。
   */
  confirmCleaning: () => { ok: boolean; mistakes: { id: string; why: string }[] }
  /** 学生在标注台给某条数据打标签。 */
  setRecordLabel: (id: string, label: DataLabel) => void
  /**
   * 提交标注结果。判分依据就是学生自己在「设定规则」阶段定的坡度阈值，
   * 标错时把规则原文念回去，而不是只说"错了"。
   */
  confirmLabeling: () => { ok: boolean; mistakes: { id: string; why: string }[] }
  // --- 采集车验证运行 ---
  /** 派遣采集车沿某条候选路线往返验证（自动驾驶，学生不能操控）。 */
  beginHaulerRun: (candidateIndex: number) => boolean
  /** 每帧推进采集车（dt 秒）。 */
  stepHauler: (dt: number) => void
  /** 放弃/复位当前采集车运行。 */
  resetHaulerRun: () => void
  /** 采集车当前状态（HUD 能源条与失败提示读它）。 */
  haulerRun: () => HaulerRun
  /** 采集车当前出勤实际走的路线 cell 列表（主丝带在出勤期间应画这条，与 hauler 对齐）。无出勤时为空数组。 */
  haulerRoute: () => GridCell[]
  subscribe: (listener: (s: MissionSnapshot) => void) => () => void
}

export function createMission(field: HeightField, worldIndex: number = 0): Mission {
  const knowledge = createKnowledgeField(KNOW_RES)
  const grid = createGrid(field, KNOW_RES, 14, 24)
  const weights: PlanWeights = { ...DEFAULT_WEIGHTS }
  const currentWorld = Math.max(0, Math.min(1, worldIndex))
  /**
   * 当前地图的世界档案（2026-09-05 架构隔离，老大拍板「二号任务独立开发」）。
   *
   * 两张地图的全部差异化参数集中在 `worldProfile.ts`，此处只取一次。
   * 后续所有"这张图该用哪个值"的读取一律走 `profile.xxx`，不再散落
   * `if (currentWorld === 1)` 分支——二号后续开发只改 worldProfile，
   * 不会碰到一号的代码路径（红线：完全不影响火星一号）。
   */
  const profile: WorldProfile = worldProfileFor(worldIndex)
  /**
   * 当前地图的采集车电池内部物理容量。
   * - World 0（火星一号）100（已审核通过的旧值，零回归护栏）。
   * - World 1（火星二号）120（百分比语义，UI 只显示 0~100%，不暴露此数字）。
   *   电池窗口按二号地形真实难度独立设计，学生看不到二者物理量的差异。
   * 凡 mission.ts 内的 haulerRun init / beginHaulerRun / stepHauler / failHauler /
   * computeRouteEnergy 等"采集车能源账"路径，全部从本常量取值，不直接读 `HAULER_BATTERY`。
   */
  const missionBattery = profile.battery
  /** 扫描预算：设为无穷大表示"无限扫描"（需求 C）。扫描次数不再限制，由地形规模制造取舍压力。 */
  const scanBudget = Infinity

  let phase: MissionPhase = 'scan'
  let scansUsed = 0
  let result: PlanResult | null = null
  const listeners = new Set<(s: MissionSnapshot) => void>()

  // --- 实测仿真状态（M5）---
  let driveProg = 0
  let driveStatus: DriveStatus = 'idle'
  let stuckAt: { x: number; z: number } | null = null
  let stuckReason: StuckReason = null
  /** 翻车点的主导危险类型：slope=陡坡硬障碍 / rock=岩石硬障碍 / soft=深软沙（可脱困）。 */
  let stuckHazard: 'slope' | 'rock' | 'soft' | null = null
  let pathCum: number[] = [0]
  let pathLen = 0
  /** 地图 C 盲区指挥（P6）：验证车已停在盲区入口、等待学生下达命令。 */
  let awaitingBlindCommand = false
  /** 本次运行是否已下达过盲区指挥命令（下达后局部揭示并放行）。 */
  let blindCommanded = false
  /** 缺口-7：本局所有盲区指挥命令揭示的圆心（世界坐标 + 半径），小地图据此画高亮环。 */
  let blindReveals: { x: number; z: number; radius: number }[] = []
  /** 缺口-1 加固：本次到达是否来自手动驾驶（AI 实测到达恒为 false）。 */
  let arrivedManual = false

  // --- 手动驾驶仿真（RPG 操控 / aiquests「实践测试」阶段）---
  // 与自动沿路径行驶共用同一套地形采样，但由玩家输入（油门/转向）驱动。
  // 确定性：输入来自玩家，不引入任何随机数；同一输入序列必然得到同一轨迹。
  // 漫游车停靠位：基地外的开阔地。主基地环半径 18m、四座操作台 POI 簇半径约 36m，
  // 这里北偏 44m 完全在基地建筑与操作台之外——第三人称跟车入画即见车，不会被主基地遮挡。
  // 着陆近距成像半径 90m 覆盖此点，入画周围地形已揭示，不会黑屏。
  // 2026-09-12 老大反馈：二号火星车默认停靠位从基地西南挪到**东南、KIBO 旁**
  // （从玩家视角基地右下方）。一号保持原位（零回归）。
  const ROVER_SPAWN =
    worldIndex === 1
      ? { x: field.start.x + 36, z: field.start.z + 34 }
      : { x: field.start.x, z: field.start.z + 44 }
  let manualOn = false
  let manualX = ROVER_SPAWN.x
  let manualZ = ROVER_SPAWN.z
  let manualHeading = 1 // 2026-09-02 默认朝 sample-a（河床沉积）方向
  let manualV = 0
  let manualDist = 0
  let manualThrottle = 0
  let manualSteer = 0

  // --- aiquests 六步闭环：决策日志、运行记录、不确定性处置 ---
  let uncertaintyChoice: UncertaintyChoice = null
  let uncertaintyReason = ''
  const decisionLog: DecisionEntry[] = []
  const runs: RunRecord[] = []
  let previousPlan: PlanSummary | null = null
  /** 当前运行序号。每次 startDrive 递增，v1/v2/v3... */
  let currentRun = 0
  /** 当前运行采样的路径点（用于生成 trace） */
  let currentTrace: Array<{ x: number; z: number }> = []
  /** 上次采样 trace 时的里程，控制采样间隔（每 8m 取一个点） */
  let lastTraceDist = 0

  // --- 游戏化 POI 与背包系统 ---
  /**
   * 一号（陨石坑盆地）三个样本站。**原样保留，零回归。**
   */
  const BASIN_SAMPLE_POIS: Poi[] = [
    { id: 'sample-a', kind: 'sample-a', label: '河床沉积样本站', radius: 22, x: -216, z: 236, description: '古河床沉积层是判断地形年龄和松软度的关键样本。采回去清洗标注，AI 才认识「古河道」这种地形。' },
    { id: 'sample-b', kind: 'sample-b', label: '沙丘背风侧样本站', radius: 22, x: -152, z: -156, description: '背风侧堆积的细沙最容易让车轮陷住。分析它，AI 才能学会预判软沙陷阱。' },
    { id: 'sample-c', kind: 'sample-c', label: '坑缘溅射样本站', radius: 22, x: 216, z: 92, description: '撞击坑边缘的溅射物记录着地形历史。标进数据集，AI 以后就知道坑附近不能硬闯。' },
  ]

  /**
   * 二号（外流河道）三个样本站（设计 §3.2）。坐标与 `OUTFLOW_LANDMARKS` 一致。
   *
   * `labelHeight` 必须显式给：三个站高度差极大——巨砾 8.5 m、层理剖面 14 m、
   * 水冰点几乎贴地（只有 2 m 标记杆）。沿用一号的统一高度（16.5 m）会让
   * 巨砾标签悬在半空、水冰点标签埋进地里（设计 §3.2 适配点）。
   */
  const OUTFLOW_SAMPLE_POIS: Poi[] = [
    {
      id: 'sample-a',
      kind: 'sample-a',
      label: '洪水搬运巨砾样本站',
      labelHeight: 13,
      radius: 22,
      // 2026-09-11 河道 S 型改造：样本站搬到新河道沿线（与 OUTFLOW_LANDMARKS 同步）
      x: -101,
      z: 225,
      description:
        '这么大的石头，风搬不动，只有洪水能搬。它证明这里曾有过一场大洪水——但现在的火星，一滴水都没有。',
    },
    {
      id: 'sample-b',
      kind: 'sample-b',
      label: '河道层理剖面样本站',
      labelHeight: 13,
      radius: 22,
      x: -25,
      z: -18,
      description:
        '一层一层，是不同时期的洪水留下的。最底下那层最粗——水最大的时候，连这么大的石头都冲得动。',
    },
    {
      id: 'sample-c',
      kind: 'sample-c',
      label: '浅层水冰探测样本站',
      labelHeight: 13,
      radius: 22,
      x: 51,
      z: -260,
      description:
        '这里的地下有水冰——是真的，探测器挖到过。但它埋在土里，不是河里的水。',
    },
  ]

  const POIS: Poi[] = [
    // 2026-09-12：老大问蓝圈橘黄面片 = 本台（数据清洗台）的台面板。挪位尝试引发
    // cleanAndLabel 测试连锁失败（驱动方式依赖台位），先回退原位；是否挪、怎么挪待老大拍板。
    { id: 'base-clean', kind: 'base-clean', label: '数据清洗台', radius: 18, x: field.start.x - 18, z: field.start.z + 12, description: '原始扫描数据里混着噪点和误判。在这里把脏数据清掉，AI 才不会学错——垃圾进，垃圾出。' },
    { id: 'base-label', kind: 'base-label', label: '数据标注台', radius: 18, x: field.start.x + 12, z: field.start.z + 18, description: '你亲自告诉 AI 每一格「能走 / 不能走」。这些标注就是 AI 学习的标准答案，决定了它以后怎么判断地形。' },
    { id: 'base-train', kind: 'base-train', label: 'AI 训练舱', radius: 18, x: field.start.x - 8, z: field.start.z - 16, description: '把清洗、标注好的数据喂进去，导航 AI 才真正学会你定的通行规则。' },
    { id: 'base-select', kind: 'base-select', label: '路径选择台', radius: 18, x: field.start.x + 16, z: field.start.z - 10, description: 'AI 按你的规则和已扫数据，生成「走近路 / 绕远路」两条候选路线。最终走哪条，拍板的是你。' },
    ...(currentWorld === 1 ? OUTFLOW_SAMPLE_POIS : BASIN_SAMPLE_POIS),
    // 一号「岩石迷阵入口」/ 二号「支谷盲区入口」：复用同一 kind（信标配色与拾取逻辑不变），
    // 坐标与文案按地貌分叉——二号根本没有岩石迷阵，那里是支谷汇入口（设计 §2.1）。
    ...(currentWorld === 1
      ? [
          {
            id: 'blind-zone',
            kind: 'maze-entrance' as PoiKind,
            label: '支谷盲区入口',
            radius: 28,
            x: 180,
            z: -130,
            description:
              '支谷深处被两侧崖壁挡着，连扫描都看不真切。要不要从这里走，得你自己拍板。',
          },
        ]
      : [
          {
            id: 'maze-entrance',
            kind: 'maze-entrance' as PoiKind,
            label: '岩石迷阵入口',
            radius: 28,
            x: 300,
            z: -60,
            description: '一片巨石组成的天然迷宫。只有 AI 规划并通过实测验证的路线，才能安全穿过。',
          },
        ]),
    { id: 'energy-station', kind: 'energy-station', label: '能源站', radius: 32, x: field.goal.x, z: field.goal.z, description: '任务终点。在这里派遣 AI 自动驾驶的资源采集车，把它当成你训练成果的一场「期末考试」。' },
  ]
  const inventory: InventoryItem[] = []
  const collectedPoiIds = new Set<string>()
  /** 已交互完成的 POI id 集合，供场景信标把"已完成"地标变色提示。 */
  const completedPoiIds = new Set<string>()

  // --- 数据记录（清洗 / 标注的对象）---
  /**
   * 每个样本站一次带回 6 条读数：4 条好数据 + 2 条坏数据。
   * 模板是**写死的**而不是随机的：教学上要保证三张地图的学生看到同样难度、
   * 同样的缺陷种类，且标注阶段必须同时覆盖「可通行 / 难走 / 禁行」三档，
   * 否则学生标不出三类的区别，标注这一步就白做了。
   *
   * 坏数据刻意覆盖全部三类缺陷（超量程 / 重复 / 缺失），且重复那条紧挨着它的原型，
   * 让学生能靠"逐条比对"自己发现——而不是靠界面把答案标出来。
   *
   * 判分规则从"只看坡度"升级为"坡度、岩石度、软沙度取最严格一档"：
   * 即使坡度很缓，岩石太密或软沙太深也要降级。这是 AI 导航的真实逻辑。
   */
  const STATION_READINGS: Record<string, Array<{ slope: number; rock: number; soft: number; flaw: DataFlaw }>> = {
    // 每站 6 条：4 好 + 2 坏。三站合计 18 条（12 好 6 坏）。
    // 清洗后剩 12 条，按三维度最严格一档正好分成 可通行 4 / 难走 4 / 禁行 4，
    // 保证学生在标注台能同时见到三档，否则标注这一步就白做了。
    'sample-a': [
      { slope: 4, rock: 0.1, soft: 0.2, flaw: null }, // 可通行
      { slope: 15, rock: 0.2, soft: 0.2, flaw: null }, // 难走（坡度）
      { slope: 30, rock: 0.7, soft: 0.1, flaw: null }, // 禁行（坡度 + 岩石）
      { slope: 16, rock: 0.2, soft: 0.2, flaw: null }, // 难走（坡度）
      { slope: -999, rock: 0.3, soft: 0.4, flaw: 'out-of-range' }, // 超量程
      { slope: 12, rock: -1, soft: -1, flaw: 'missing' }, // 缺失
    ],
    'sample-b': [
      { slope: 8, rock: 0.05, soft: 0.2, flaw: null }, // 可通行
      { slope: 8, rock: 0.1, soft: 0.55, flaw: null }, // 难走（软沙）：坡度/岩石都过关，完全由软沙度决定
      { slope: 31, rock: 0.4, soft: 0.5, flaw: null }, // 禁行（坡度）
      { slope: 28, rock: 0.1, soft: 0.3, flaw: null }, // 禁行（坡度）
      { slope: -999, rock: 0.3, soft: 0.5, flaw: 'out-of-range' }, // 超量程
      { slope: 8, rock: 0.1, soft: 0.55, flaw: 'duplicate' }, // 与上面第 2 条重复
    ],
    'sample-c': [
      { slope: 6, rock: 0.2, soft: 0.1, flaw: null }, // 可通行
      { slope: 22, rock: 0.5, soft: 0.3, flaw: null }, // 难走（坡度）
      { slope: 33, rock: 0.8, soft: 0.05, flaw: null }, // 禁行（坡度 + 岩石）
      { slope: 11, rock: 0.3, soft: 0.1, flaw: null }, // 可通行
      { slope: 9, rock: -1, soft: -1, flaw: 'missing' }, // 缺失
      { slope: 6, rock: 0.2, soft: 0.1, flaw: 'duplicate' }, // 与上面第 1 条重复
    ],
  }

  /**
   * 火星二号（world 1）的读数模板：与一号**完全相同的 18 条数值、相同的缺陷种类**
   * （每站 4 好 2 坏，合计 12 好 6 坏，清洗后正好分成 可通行 4 / 难走 4 / 禁行 4），
   * 但**好/坏数据的位置被打乱**。
   *
   * 老大 2026-09-09 反馈：一号固定「4 条好的排在前面、2 条坏的垫在最后」太容易，
   * 学生看位置就能猜出来。二号是**提供难度**的地图，坏数据必须分散在各处，
   * 逼学生逐条读数值判断，而不是靠位置规律蒙。
   *
   * 唯一保留的让步：`duplicate` 类坏数据仍**紧邻其原型**——二号已经够难，
   * 不再叠加「连重复的原型都找不到」的挫败（E5：学生卡死无处可去 = 教学失败）。
   */
  const OUTFLOW_STATION_READINGS: Record<
    string,
    Array<{ slope: number; rock: number; soft: number; flaw: DataFlaw }>
  > = {
    // 坏数据分散在第 2、5 位（一号是第 5、6 位）
    'sample-a': [
      { slope: 4, rock: 0.1, soft: 0.2, flaw: null }, // 可通行
      { slope: -999, rock: 0.3, soft: 0.4, flaw: 'out-of-range' }, // 坏
      { slope: 15, rock: 0.2, soft: 0.2, flaw: null }, // 难走（坡度）
      { slope: 30, rock: 0.7, soft: 0.1, flaw: null }, // 禁行（坡度 + 岩石）
      { slope: 12, rock: -1, soft: -1, flaw: 'missing' }, // 坏
      { slope: 16, rock: 0.2, soft: 0.2, flaw: null }, // 难走（坡度）
    ],
    // 坏数据分散在第 1、4 位；duplicate 紧邻原型（第 3 条）
    'sample-b': [
      { slope: -999, rock: 0.3, soft: 0.5, flaw: 'out-of-range' }, // 坏
      { slope: 8, rock: 0.05, soft: 0.2, flaw: null }, // 可通行
      { slope: 8, rock: 0.1, soft: 0.55, flaw: null }, // 难走（软沙）← 原型
      { slope: 8, rock: 0.1, soft: 0.55, flaw: 'duplicate' }, // 坏（紧邻原型）
      { slope: 31, rock: 0.4, soft: 0.5, flaw: null }, // 禁行（坡度）
      { slope: 28, rock: 0.1, soft: 0.3, flaw: null }, // 禁行（坡度）
    ],
    // 坏数据分散在第 2、4 位；duplicate 紧邻原型（第 3 条）
    'sample-c': [
      { slope: 22, rock: 0.5, soft: 0.3, flaw: null }, // 难走（坡度）
      { slope: 9, rock: -1, soft: -1, flaw: 'missing' }, // 坏
      { slope: 6, rock: 0.2, soft: 0.1, flaw: null }, // 可通行 ← 原型
      { slope: 6, rock: 0.2, soft: 0.1, flaw: 'duplicate' }, // 坏（紧邻原型）
      { slope: 33, rock: 0.8, soft: 0.05, flaw: null }, // 禁行（坡度 + 岩石）
      { slope: 11, rock: 0.3, soft: 0.1, flaw: null }, // 可通行
    ],
  }
  const records: DataRecord[] = []
  /** 清洗是否全部做对并通过。 */
  let cleaningDone = false
  /** 标注是否全部做对并通过。 */
  let labelingDone = false

  let hasInteracted = false
  /** 导航 AI 是否已训练完成。 */
  let trained = false
  /** 导航 AI 信心值 0..1。训练时按数据量/覆盖率/决策完整性计算。 */
  let aiConfidence = 0
  /** 是否已交付能源站、完成整局任务。 */
  let missionComplete = false

  // --- 采集车验证运行（自动驾驶，学生不能操控）---
  let haulerRun: HaulerRun = {
    status: 'idle',
    legProgress: 0,
    progress: 0,
    energy: missionBattery,
    battery: missionBattery,
    drivenM: 0,
    failReason: null,
    routeLabel: '',
    routeUnknown: 0,
  }
  /** 本次运行的往返格序列（去程 + 回程，不含重复端点）。 */
  let haulerLegs: { cells: GridCell[]; cum: number[]; length: number }[] = []
  /** 当前在第几段：0=去程，1=回程。 */
  let haulerLegIndex = 0
  /** 当前段已行驶里程。 */
  let haulerLegDist = 0
  /** 采集（机械臂抓取）已停留的秒数。 */
  let haulerCollectTime = 0
  /** 本次运行已累计消耗的能源。 */
  let haulerEnergyUsed = 0
  /**
   * 采集车出勤期间，主丝带要画的「规划路径」cell 列表。
   * 必须和采集车实际走的 cand.path 完全一致，否则车会"在某些路段脱离丝带"。
   * 默认 plan（result.path）用的是当前 weights 的 replan，与按 ROUTE_PROFILE 全量缩放权重
   * 算出的候选路线不同，所以这里单独持有采集车实际路线，覆盖 path() 的输出。
   */
  let haulerDisplayCells: GridCell[] = []

  /** 规划结果一变就重算路径里程表，供实测按里程定位漫游车与检测翻车格。 */
  const rebuildPathMetrics = (r: PlanResult | null) => {
    const cells = r?.path ?? []
    pathCum = [0]
    for (let k = 1; k < cells.length; k += 1) {
      pathCum.push(pathCum[k - 1] + Math.hypot(cells[k].x - cells[k - 1].x, cells[k].z - cells[k - 1].z))
    }
    pathLen = pathCum[pathCum.length - 1] || 0
  }

  /** 给定里程，返回路径上对应的格索引（二分近似，path 不长是线性也够）。 */
  const sampleIndex = (dist: number): number => {
    const d = Math.min(Math.max(dist, 0), pathLen)
    if (d <= 0) return 0
    let k = 1
    while (k < pathCum.length && pathCum[k] < d) k += 1
    return Math.max(0, Math.min(pathCum.length - 1, k))
  }

  /** 路线里"没数据却真禁行"的格数——规划器猜错的那些。 */
  const hiddenBlocked = (): number => {
    const cells = result?.path ?? []
    let n = 0
    for (const c of cells) if (c.scanned < 0.5 && c.trueFlag === 2) n += 1
    return n
  }

  /** 路线上的"盲区"：最长一段连续未探明（scanned<0.5）的格。地图 C 的高潮在此。 */
  const computeBlindZone = (): {
    startIndex: number
    endIndex: number
    entryDist: number
    lengthM: number
    entry: { x: number; z: number }
  } | null => {
    const cells = result?.path ?? []
    if (cells.length < 2) return null
    let best: { start: number; end: number } | null = null
    let runStart = -1
    for (let k = 0; k < cells.length; k += 1) {
      const unknown = cells[k].scanned < 0.5
      if (unknown && runStart < 0) runStart = k
      if (!unknown && runStart >= 0) {
        if (!best || k - 1 - runStart > best.end - best.start) best = { start: runStart, end: k - 1 }
        runStart = -1
      }
    }
    if (runStart >= 0 && (!best || cells.length - 1 - runStart > best.end - best.start)) {
      best = { start: runStart, end: cells.length - 1 }
    }
    if (!best) return null
    const entryCell = cells[best.start]
    const entryDist = pathCum[best.start] ?? 0
    const lengthM = (pathCum[best.end] ?? pathLen) - entryDist
    return { startIndex: best.start, endIndex: best.end, entryDist, lengthM, entry: { x: entryCell.x, z: entryCell.z } }
  }

  const startCell = grid.worldToGrid(field.start.x, field.start.z)
  /**
   * 当前任务目标点。默认 = 主终点（能源站）；选中赌档路线后切到**隐藏采集点**。
   *
   * 这是「多终点」支持的核心（老大 2026-09-06 隐藏采集点方案）：实测推进与到达判定
   * 本来就基于**当前路径的终点**，不绑定 field.goal，因此只需切换规划目标即可，
   * 无需改动 stepDrive / 到达 / 复盘任何逻辑。
   */
  let activeGoal: { x: number; z: number } = { x: field.goal.x, z: field.goal.z }
  const goalCellOf = (g: { x: number; z: number } = activeGoal) => grid.worldToGrid(g.x, g.z)

  const bootstrap = () => {
    // 着陆点近距成像：免费，让学生有一个已知的立足点
    knowledge.reveal(field.start.x, field.start.z, LANDING_REVEAL)
    grid.syncKnowledge(knowledge)
  }

  const summarize = (r: PlanResult | null): PlanSummary | null => {
    if (!r) return null
    return {
      found: r.found,
      lengthM: r.lengthM,
      cautionCells: r.cautionCells,
      unknownCells: r.unknownCells,
      expanded: r.expanded,
      cost: r.cost,
      cautionDeg: grid.cautionDeg,
      blockedDeg: grid.blockedDeg,
      cautionRock: CAUTION_ROCK,
      blockedRock: BLOCKED_ROCK,
      cautionSoft: CAUTION_SOFT,
      blockedSoft: BLOCKED_SOFT,
      weights: { ...weights },
    }
  }

  const deriveSixStep = (): SixStepPhase => {
    // 进度条必须随学生真实操作推进，而不是只跟当前 phase 走。
    // 已完成步骤：发现 / 找到数据 / 清洗 / 标注 / 训练 / 验证 / 实践。
    if (missionComplete) return 'practice'
    if (haulerRun.status === 'outbound' || haulerRun.status === 'collecting' || haulerRun.status === 'returning') {
      return 'verify-ai'
    }
    if (phase === 'drive' || phase === 'revise') return 'verify-ai'
    if (phase === 'report') return 'practice'
    // 训练一完成，进度条就必须跳到「验证AI工具」——不能等采集车真的出发才动。
    // （train() 不切 phase，所以这一步必须显式判 trained，否则进度条会卡在"训练"上不动。）
    if (trained) return 'verify-ai'
    if (phase === 'plan') return 'make-ai'

    // 清洗 / 标注以"学生是否真的做对"为准，不是以"是否到过操作台"为准。
    if (records.length > 0) {
      if (labelingDone) return 'make-ai'
      if (cleaningDone) return 'label-data'
      return 'clean-data'
    }
    if (scansUsed > 0) return 'find-data'
    return 'discover'
  }

  const snapshot = (): MissionSnapshot => {
    const near = nearestPoi()
    return {
      phase,
      scansLeft: scanBudget - scansUsed,
      scansUsed,
      coverage: knowledge.coverage(),
      cautionDeg: grid.cautionDeg,
      blockedDeg: grid.blockedDeg,
      cautionRock: CAUTION_ROCK,
      blockedRock: BLOCKED_ROCK,
      cautionSoft: CAUTION_SOFT,
      blockedSoft: BLOCKED_SOFT,
      weights: { ...weights },
      plan: summarize(result),
      hasScanned: scansUsed > 0,
      targetKnown: (grid.at(goalCellOf().i, goalCellOf().j)?.scanned ?? 0) >= 0.5,
      driveStatus,
      driveProgress: driveProg,
      stuckAt,
      stuckReason,
      stuckHazard,
      softStuck: driveStatus === 'stuck' && stuckHazard === 'soft',
      hiddenBlocked: hiddenBlocked(),
      manual: manualOn,
      battery: Math.max(0, 1 - (manualOn ? manualDist : driveProg) / 1200),
      sixStep: deriveSixStep(),
      uncertaintyChoice,
      uncertaintyReason,
      decisionLog: decisionLog.slice(),
      runs: runs.slice(),
      previousPlan,
      pois: POIS,
      nearbyPoi: near && near.dist <= near.poi.radius ? near.poi : null,
      inventory: inventory.slice(),
      records: records.map((r) => ({ ...r })),
      cleaningDone,
      labelingDone,
      hauler: { ...haulerRun },
      hasInteracted,
      trained,
      aiConfidence,
      worldIndex: currentWorld,
      worldGoal: WORLD_GOALS[currentWorld],
      blindZone: computeBlindZone(),
      awaitingBlindCommand,
      blindCommanded,
      blindReveals: blindReveals.slice(),
      arrivedManual,
      missionComplete,
    }
  }

  const emit = () => {
    const s = snapshot()
    for (const fn of listeners) fn(s)
  }

  const replan = (): PlanResult => {
    result = planPath(grid, startCell, goalCellOf(), weights)
    rebuildPathMetrics(result)
    // 规划结果变化后，旧的不确定性处置可能不再适用，让学生重新决定
    uncertaintyChoice = null
    uncertaintyReason = ''
    const summary = summarize(result)
    if (summary) {
      decisionLog.push({
        type: 'plan',
        lengthM: summary.lengthM,
        unknownCells: summary.unknownCells,
        cautionCells: summary.cautionCells,
      })
    }
    emit()
    return result
  }

  const scanAt = (x: number, z: number): ScanOutcome => {
    // 需求 C：扫描次数不再限制，可无限次扫描（scansUsed 仅用于统计与展示）。
    scansUsed += 1
    const gained = knowledge.reveal(x, z, SCAN_RADIUS)
    grid.syncKnowledge(knowledge)
    decisionLog.push({ type: 'scan', x, z, scansLeft: scanBudget - scansUsed })
    // 已有路线的话，认知变了就必须重算——不能让学生看着过期的路线做决定
    if (result) replan()
    else emit()
    return { ok: true, gained, coverage: knowledge.coverage() }
  }

  const setThresholds = (cautionDeg: number, blockedDeg: number) => {
    const c = Math.min(cautionDeg, blockedDeg - 1)
    grid.setThresholds(c, blockedDeg)
    decisionLog.push({ type: 'thresholds', cautionDeg: c, blockedDeg })
    if (result) replan()
    else emit()
  }

  const setWeight = (key: keyof PlanWeights, value: number) => {
    weights[key] = value
    decisionLog.push({ type: 'weight', key, value })
    if (result) replan()
    else emit()
  }

  const canEnter = (next: MissionPhase): boolean => {
    if (next === 'rules') return scansUsed > 0
    if (next === 'plan') return scansUsed > 0
    if (next === 'drive') return Boolean(result?.found)
    return true
  }

  /** 采样当前车位到 trace（用于 v1/v2 轨迹对照）。 */
  const sampleTrace = () => {
    const cells = result?.path ?? []
    if (cells.length === 0) return
    const here = cells[sampleIndex(driveProg)]
    currentTrace.push({ x: here.x, z: here.z })
  }

  /** 一次运行结束（到达或翻车）：归档为 RunRecord，并把当前规划存为 v1 供下轮对照。 */
  const finalizeRun = () => {
    sampleTrace()
    runs.push({
      run: currentRun,
      plan: summarize(result),
      status: driveStatus,
      progress: driveProg,
      trace: currentTrace.slice(),
      uncertainty: uncertaintyChoice,
      reason: uncertaintyReason,
    })
    // 下一轮规划（v2）与这次（v1）对照
    previousPlan = summarize(result)
    decisionLog.push({ type: 'drive-end', run: currentRun, status: driveStatus, progress: driveProg })
  }

  /** 进入实测：从起点重新跑，清空上一轮的翻车记录，开启一次新运行。 */
  const startDrive = () => {
    driveProg = 0
    driveStatus = 'running'
    stuckAt = null
    stuckReason = null
    stuckHazard = null
    blindCommanded = false
    // 地图 C（未见地形）：路线几乎必含盲区。若盲区够长，进入实测时先在入口停下，
    // 强制学生在盲区下达指挥命令、预览后果，再放行——这正是 P6 的高潮。
    const bz = computeBlindZone()
    awaitingBlindCommand =
      profile.blindZone.enabled && bz !== null && bz.lengthM > profile.blindZone.minM
    currentRun += 1
    currentTrace = []
    lastTraceDist = 0
    sampleTrace()
    decisionLog.push({ type: 'drive-start', run: currentRun })
    emit()
  }

  /** 每帧推进实测。开到真实禁行的格子就翻车停下，记录原因。 */
  const stepDrive = (dt: number) => {
    if (driveStatus !== 'running') return
    // 地图 C 盲区指挥：未下达命令前，验证车停在盲区入口外，绝不进入未知地形。
    // 这样"盲区"从一段文案变成必须亲自拍板并承担后果的高潮，而非自动溜过去。
    if (awaitingBlindCommand) {
      const bz = computeBlindZone()
      if (bz) {
        const haltDist = Math.max(0, bz.entryDist - BLIND_HALT_MARGIN)
        if (driveProg >= haltDist) {
          driveProg = haltDist
          return
        }
      }
    }
    const cells = result?.path ?? []
    if (cells.length < 2) {
      // 缺口-1 加固：到达来自 AI 实测（stepDrive），恒为非手动；若手动模式仍激活属控制流异常，仅 dev 告警不崩溃。
      if (import.meta.env.DEV && manualOn) {
        console.warn('[mars] stepDrive arrived while manual mode still active — control-flow anomaly; arrived line will not claim manual drive.')
      }
      arrivedManual = false
      driveStatus = 'arrived'
      finalizeRun()
      emit()
      return
    }
    driveProg = Math.min(pathLen, driveProg + dt * DRIVE_SPEED)
    if (driveProg - lastTraceDist >= 8) {
      sampleTrace()
      lastTraceDist = driveProg
    }
    if (driveProg >= pathLen) {
      // 缺口-1 加固：同上，到达来自 AI 实测，恒为非手动。
      if (import.meta.env.DEV && manualOn) {
        console.warn('[mars] stepDrive arrived while manual mode still active — control-flow anomaly; arrived line will not claim manual drive.')
      }
      arrivedManual = false
      driveStatus = 'arrived'
      finalizeRun()
      emit()
      return
    }
    const cell = cells[sampleIndex(driveProg)]
    // 翻车触发：真实禁行坡（trueFlag===2），或深软沙（soft>=SOFT_BLOCK，AI 验证车会陷住）。
    if (cell.trueFlag === 2 || cell.soft >= SOFT_BLOCK) {
      // 翻车：把里程退回到翻车格起点，让漫游车停在该格
      driveProg = pathCum[sampleIndex(driveProg)]
      driveStatus = 'stuck'
      stuckAt = { x: cell.x, z: cell.z }
      // 没数据硬猜的 → guess；已探明却因阈值漏判的 → known
      stuckReason = cell.scanned < 0.5 ? 'guess' : 'known'
      // 主导危险类型：深软沙可脱困；陡坡/岩石是硬障碍，不能摇出
      stuckHazard = cell.soft >= SOFT_BLOCK ? 'soft' : cell.rock >= ROCK_BLOCK ? 'rock' : 'slope'
      finalizeRun()
      emit()
      return
    }
  }

  /** 从翻车/到达退回修改阶段，保留当前认知与路线供调整。 */
  const stopDrive = () => {
    driveStatus = 'idle'
    emit()
  }

  /**
   * 软沙脱困（#53/#68）：把里程推过陷住的格子并恢复行驶。
   * 仅当处于 `stuck` 且属于"深软沙陷住"（`stuckHazard === 'soft'`）时有效——陡坡 / 岩石是硬障碍，
   * 不论是否已探明都不能"摇出来"，只能重新规划路线。
   * 这样修掉了旧实现的一个诚实漏洞：未扫描的陡崖（`trueFlag === 2`、`stuckReason === 'guess'`）
   * 原本也能被当成"软沙"摇出去，等于让 AI 把硬障碍摇没了。
   * 脱困成功会让 R-7 从陷住的格子边缘重新起步，继续走原本的路线，
   * 把"AI 把没探明的软沙当硬地"的代价变成一段可操作的脱困小游戏，而非直接判失败。
   */
  const escapeFromStuck = (): boolean => {
    if (driveStatus !== 'stuck' || !stuckAt) return false
    // 只有深软沙陷住的格才能摇出来；陡坡/岩石是硬障碍，只能重新规划
    if (stuckHazard !== 'soft') return false
    const cells = result?.path ?? []
    const idx = sampleIndex(driveProg)
    // 一次性跳过连续的多格禁行（深软沙 / 禁行坡成片），落到危险区之后，避免脱困后立刻再卡死
    let next = idx + 1
    while (next < cells.length && (cells[next].trueFlag === 2 || cells[next].soft >= SOFT_BLOCK)) next += 1
    const target = pathCum[Math.min(next, pathCum.length - 1)]
    driveProg = Math.min(pathLen, target + 0.5)
    driveStatus = 'running'
    stuckAt = null
    stuckReason = null
    stuckHazard = null
    emit()
    return true
  }

  /**
   * 地图 C 盲区指挥（P6）：在盲区入口下达命令。
   * 以盲区入口为中心局部揭示一片地形（"1–2s 局部后果预览"），让学生看见盲区内到底是什么，
   * 据此决定重新规划还是继续。不消耗扫描预算——这是"指挥"而非"扫描"，
   * 揭示的是 AI 临门一脚能看到的那一小片，不是把整张图补完。
   * 下达后放行验证车继续前进；硬障碍（陡坡/岩石）若恰在盲区内，揭示后实测仍会如实翻车。
   */
  /**
   * 下达盲区指挥命令（二号地图 P6 高潮节拍，设计 §四）。
   *
   * @param choice 学生的决策：
   *   - `'proceed'`：**继续前进**——接受盲区风险硬闯（赌档的合理张力）。
   *   - `'reroute'`：**返回重选路线**——用刚揭示的 55m 局部信息重新规划。
   *     这就是设计文档说的"override plan"：到现场才发现信息不全时，允许推翻
   *     plan 阶段的既定选择，而不是只能硬着头皮走完。
   *
   * 两种选择都会局部揭示（不消耗扫描预算），区别只在于之后是否放行。
   */
  const issueBlindCommand = (choice: 'proceed' | 'reroute' = 'proceed'): boolean => {
    if (!awaitingBlindCommand) return false
    const bz = computeBlindZone()
    if (bz) {
      knowledge.reveal(bz.entry.x, bz.entry.z, BLIND_PREVIEW_RADIUS)
      grid.syncKnowledge(knowledge)
      blindReveals.push({ x: bz.entry.x, z: bz.entry.z, radius: BLIND_PREVIEW_RADIUS })
      decisionLog.push({ type: 'blind-command', x: bz.entry.x, z: bz.entry.z, radius: BLIND_PREVIEW_RADIUS })
    }
    awaitingBlindCommand = false
    blindCommanded = true

    if (choice === 'reroute') {
      // override plan：回到规划阶段，让学生拿新数据重新拍板。
      // 不清空已采集数据（清洗/标注结果保留），只重置本次实测的行驶状态。
      phase = 'plan'
      driveStatus = 'idle'
      driveProg = 0
      pathCum = [0]
      pathLen = 0
      stuckAt = null
      stuckReason = null
      stuckHazard = null
      replan()
    }
    emit()
    return true
  }

  const driveInfo = (): DriveInfo => {
    const cells = result?.path ?? []
    const here = cells.length > 0 ? cells[sampleIndex(driveProg)] : null
    return {
      status: driveStatus,
      progress: driveProg,
      stuckAt,
      stuckReason,
      stuckHazard,
      softStuck: driveStatus === 'stuck' && stuckHazard === 'soft',
      at: here ? { x: here.x, z: here.z } : null,
    }
  }

  /** 漫游车逻辑世界坐标：手动模式取车体、实测取路径位、其余取停靠位（ROVER_SPAWN 或上次手动停靠）。 */
  const roverWorldPosition = (): { x: number; z: number } => {
    if (manualOn) return { x: manualX, z: manualZ }
    const at = driveInfo().at
    if (at) return { x: at.x, z: at.z }
    return { x: manualX, z: manualZ }
  }

  /** 取玩家当前位置（手动模式优先，否则取实测位或停靠位）。 */
  const playerPosition = (): { x: number; z: number } => roverWorldPosition()

  /** 计算最近 POI 及其距离。 */
  const nearestPoi = (): { poi: Poi; dist: number } | null => {
    const pos = playerPosition()
    let best: { poi: Poi; dist: number } | null = null
    for (const poi of POIS) {
      const d = Math.hypot(poi.x - pos.x, poi.z - pos.z)
      if (!best || d < best.dist) best = { poi, dist: d }
    }
    return best
  }

  /** 进入手动驾驶：从火星车当前实时坐标接管，避免点新目的地时回到基地/残留路径端点。 */
  const enterManual = () => {
    // 关键修复：起点必须用「车当前实时坐标」（roverWorldPosition），而不是 driveInfo().at。
    // 实测/到达后 result.path 仍残留，driveInfo().at 会指向路径端点甚至基地起点，
    // 导致「每次点目的地车都从基地重新出发」。roverWorldPosition 在 drive 阶段取路径实时位、
    // 手动/停靠阶段取车体当前位，恒等于车此刻真实位置。
    const here = roverWorldPosition()
    manualX = here.x
    manualZ = here.z
    manualV = 0
    manualDist = 0
    manualThrottle = 0
    manualSteer = 0
    manualOn = true
    decisionLog.push({ type: 'manual-start' })
    emit()
  }

  /** 退出手动驾驶，回到规划/自动模式。 */
  const exitManual = () => {
    if (manualOn) decisionLog.push({ type: 'manual-end', distance: manualDist })
    manualOn = false
    manualThrottle = 0
    manualSteer = 0
    emit()
  }

  /** 每帧推进手动驾驶。throttle/steer ∈ [-1,1]。 */
  const stepManual = (dt: number) => {
    if (!manualOn) return
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
    const e = 1.6
    const hl = field.heightAt(manualX - e, manualZ)
    const hr = field.heightAt(manualX + e, manualZ)
    const hd = field.heightAt(manualX, manualZ - e)
    const hu = field.heightAt(manualX, manualZ + e)
    // 沿车头方向的坡度（正=上坡，负=下坡），用于重力分量
    const fwdX = Math.cos(manualHeading)
    const fwdZ = -Math.sin(manualHeading)
    const slopeAlong = ((hr - hl) / (2 * e)) * fwdX + ((hu - hd) / (2 * e)) * fwdZ
    const soft = field.softAt(manualX, manualZ)

    // 转向：随速度放大，低速也能小幅原地修正。转向角速度提升 100%（1.7→3.4），
    // 解决「转向很慢」的问题。
    const speedFactor = 0.35 + 0.65 * Math.min(1, Math.abs(manualV) / 3)
    manualHeading += manualSteer * 3.4 * dt * speedFactor

    // 提速设计（2026-09-01 调整）：大部分地面都额外 +50%~100% 基础速度，
    // 只有明显陡坡（达到警示坡度 cautionDeg）才回落到基础速度——让学生长距离奔袭更顺，
    // 陡坡段自然慢下来形成对比。软沙阻力由下方 drag 项单独处理，不再单独取消提速。
    // 阈值用 grid.cautionDeg（默认 14°）动态计算，与学生调高的"禁行坡度"联动。
    const cautionRatio = Math.tan(grid.cautionDeg * Math.PI / 180)
    const absSlope = Math.abs(slopeAlong)
    let boost: number
    if (absSlope >= cautionRatio) {
      boost = 1.0 // 明显陡坡：回落到基础速度
    } else {
      // 越平缓提速越多：平地约 +100%，接近警示坡度收敛到 +50%（落在设计区间内）
      const t = Math.min(1, absSlope / cautionRatio)
      boost = 2.0 - 0.5 * t
    }
    const engine = 45.9 * manualThrottle * boost
    const drag = 3.2 * manualV + (soft > 0.5 ? 5.5 * (soft - 0.5) * Math.sign(manualV) : 0)
    const gravity = 11 * slopeAlong
    const a = engine - drag - gravity
    manualV += a * dt
    manualV = clamp(manualV, -6.75, boost > 1.0 ? 24 : 13.5)
    if (manualThrottle === 0) manualV *= 1 - Math.min(1, dt * 1.4)

    manualX += fwdX * manualV * dt
    manualZ += fwdZ * manualV * dt

    // 盆地边界：软墙，不冲出 1200m 地形（留一点边距）
    const B = 588
    manualX = clamp(manualX, -B, B)
    manualZ = clamp(manualZ, -B, B)
    manualDist += Math.abs(manualV) * dt
  }

  const manualActive = (): boolean => manualOn

  const manualPose = () => ({
    x: manualX,
    z: manualZ,
    heading: manualHeading,
    speed: manualV,
    distance: manualDist,
  })

  const setManualInput = (throttle: number, steer: number) => {
    manualThrottle = Math.max(-1, Math.min(1, throttle))
    manualSteer = Math.max(-1, Math.min(1, steer))
  }

  /** 对"路线里有未探明格"做出显式处置：绕行 / 说明理由通过 / 承担风险。 */
  const setUncertaintyChoice = (choice: UncertaintyChoice, reason: string) => {
    uncertaintyChoice = choice
    uncertaintyReason = reason
    if (choice) decisionLog.push({ type: 'uncertainty', choice, reason })
    emit()
  }

  const getDecisionLog = (): DecisionEntry[] => decisionLog.slice()
  const getRuns = (): RunRecord[] => runs.slice()

  const setPhase = (next: MissionPhase) => {
    if (!canEnter(next)) return
    phase = next
    if (next === 'plan' && !result) replan()
    else if (next === 'drive') startDrive()
    else emit()
  }

  const advance = (): MissionPhase => {
    const k = PHASE_ORDER.indexOf(phase)
    const next = PHASE_ORDER[Math.min(PHASE_ORDER.length - 1, k + 1)]
    setPhase(next)
    return phase
  }

  /** 取玩家当前在交互范围内的 POI。 */
  const nearbyPoi = (): Poi | null => {
    const near = nearestPoi()
    return near && near.dist <= near.poi.radius ? near.poi : null
  }

  /** 与最近的 POI 交互。样本站会采集样本；基地操作台会消耗样本/数据推进训练流程。 */
  // ------------------------------------------------------------------
  // 数据清洗 / 标注：学生逐条操作
  // ------------------------------------------------------------------

  /** 采集样本站时把该站的原始读数灌进数据集。 */
  const ingestStationRecords = (poi: Poi) => {
    // 二号用打乱好/坏位置的模板（老大要求：提高难度，不能靠位置规律蒙）
    const readings = (currentWorld === 1 ? OUTFLOW_STATION_READINGS : STATION_READINGS)[poi.id]
    if (!readings) return
    readings.forEach((r, k) => {
      records.push({
        id: `${poi.id}#${k}`,
        source: poi.label.replace('样本站', ''),
        dataNumber: k + 1,
        slopeDeg: r.slope,
        rock: r.rock,
        soft: r.soft,
        flaw: r.flaw,
        cleanChoice: null,
        label: null,
      })
    })
  }

  /** 某条数据按学生自己定的规则应该标成什么。这是标注台判分的唯一依据。
   * 规则升级：坡度、岩石度、软沙度三维度取最严格的一档。
   * 例如坡度可通行但软沙度超过 70%，整体仍判为禁行——这是真实导航 AI 的决策逻辑。
   */
  const expectedLabel = (r: DataRecord): DataLabel => {
    const slopeCat = r.slopeDeg < grid.cautionDeg ? 0 : r.slopeDeg < grid.blockedDeg ? 1 : 2
    // missing 用 1（难走）兜底，避免异常值破坏教学；正常读数按阈值分档。
    const rockCat = r.rock < 0 ? 1 : r.rock < CAUTION_ROCK ? 0 : r.rock < BLOCKED_ROCK ? 1 : 2
    const softCat = r.soft < 0 ? 1 : r.soft < CAUTION_SOFT ? 0 : r.soft < BLOCKED_SOFT ? 1 : 2
    const cat = Math.max(slopeCat, rockCat, softCat)
    return cat === 0 ? 'pass' : cat === 1 ? 'caution' : 'block'
  }

  const setRecordCleanChoice = (id: string, choice: 'keep' | 'drop') => {
    const r = records.find((x) => x.id === id)
    if (!r) return
    r.cleanChoice = choice
    emit()
  }

  const confirmCleaning = (): { ok: boolean; mistakes: { id: string; why: string }[] } => {
    const mistakes: { id: string; why: string }[] = []
    for (const r of records) {
      if (r.flaw !== null && r.cleanChoice !== 'drop') {
        mistakes.push({
          id: r.id,
          why: r.cleanChoice === null
            ? `这条还没检查：${DATA_FLAW_TEXT[r.flaw]}，应该删掉。`
            : `这条是坏数据却留下了：${DATA_FLAW_TEXT[r.flaw]}，应该删掉。`,
        })
      } else if (r.flaw === null && r.cleanChoice !== 'keep') {
        mistakes.push({
          id: r.id,
          why: r.cleanChoice === null
            ? '这条还没检查：读数都正常，应该留下。'
            : '这条数据好好的却被你删了：坡度、岩石度、软沙度都在正常范围，应该留下。',
        })
      }
    }
    if (mistakes.length === 0) {
      cleaningDone = true
      // 背包里的样本同步标记：样本站整体已清洗干净（HUD/小地图读它）。
      for (const item of inventory) item.cleaned = true
      decisionLog.push({ type: 'interact', poiId: 'base-clean', label: '数据清洗台' })
    }
    emit()
    return { ok: mistakes.length === 0, mistakes }
  }

  const setRecordLabel = (id: string, label: DataLabel) => {
    const r = records.find((x) => x.id === id)
    if (!r) return
    r.label = label
    emit()
  }

  const confirmLabeling = (): { ok: boolean; mistakes: { id: string; why: string }[] } => {
    const mistakes: { id: string; why: string }[] = []
    for (const r of records) {
      if (r.cleanChoice !== 'keep') continue
      const want = expectedLabel(r)
      if (r.label === null) {
        mistakes.push({ id: r.id, why: '这条还没标：先给它选一个分类。' })
      } else if (r.label !== want) {
        const rockHint = r.rock >= 0 ? `岩石度 ${Math.round(r.rock * 100)}` : '岩石度缺失'
        const softHint = r.soft >= 0 ? `软沙度 ${Math.round(r.soft * 100)}` : '软沙度缺失'
        mistakes.push({
          id: r.id,
          why: `按你定的规则：坡度 ${r.slopeDeg}°、${rockHint}、${softHint} 综合起来属于「${DATA_LABEL_TEXT[want]}」。` +
            `（坡度 < ${grid.cautionDeg}° 且岩石/软沙 < 40% 算可通行；` +
            `< ${grid.blockedDeg}° 且岩石/软沙 < 70% 算难走；否则禁行）。` +
            `你标成了「${DATA_LABEL_TEXT[r.label]}」。`,
        })
      }
    }
    if (mistakes.length === 0) {
      labelingDone = true
      for (const item of inventory) item.labeled = true
      decisionLog.push({ type: 'interact', poiId: 'base-label', label: '数据标注台' })
    }
    emit()
    return { ok: mistakes.length === 0, mistakes }
  }

  // ------------------------------------------------------------------
  // 采集车验证运行
  // ------------------------------------------------------------------

  /** 把一条格路径整理成带累计里程的可行驶段。 */
  const buildLeg = (cells: GridCell[]) => {
    const cum = [0]
    for (let k = 1; k < cells.length; k += 1) {
      cum.push(cum[k - 1] + Math.hypot(cells[k].x - cells[k - 1].x, cells[k].z - cells[k - 1].z))
    }
    return { cells, cum, length: cum[cum.length - 1] || 0 }
  }

  /**
   * 进入某格时的耗电。已探明格按读数结算；未探明格一律按最坏情况（ENERGY_UNKNOWN_WORST）结算。
   *
   * 为什么未探明格不能按"最好情况"算：这是 2026-09 修的一个教学 bug 的根因——
   * 之前未探明格按 ENERGY_UNKNOWN_BEST（0.2）计，于是走近路只要运气好
   * （底下其实是好走的平地）就能把耗电压到电池以内，结果"本该失败的路线也跑通了"，
   * 学生学不到"先验证再相信"。改成最坏情况后，凡是切过未知区的路线，耗电账必然超出电池，
   * 想成功就必须先把未知区扫明白（或绕开它）——这正是 PBL 要教的点。
   * 绕远路走的是已探明区（planKnownOnly 强制全程已知），不含未探明格，所以不受这条影响，
   * 仍然稳稳跑得完。
   */
  const cellEnergyCost = (c: GridCell, segLen: number, dh: number): number | 'blocked' => {
    let cost = segLen * ENERGY_PER_METER
    // 坡度能耗（仅火星二号）：用真实高度差结算，上坡费电、下坡省电。与扫描无关——
    // 采集车在真实地形上爬，爬不爬坡是物理事实，不是"猜的部分"。
    if (profile.slopeEnergy) {
      if (dh > 0) cost += dh * ENERGY_PER_CLIMB_METER
      else if (dh < 0) cost += -dh * ENERGY_PER_DESCENT_METER // DESCENT 为负 → 负成本（省电）
    }
    /**
     * 2026-09-11 第 11 条：**采集车边开边自动扫描**。
     *
     * 旧行为有两处问题，正是老大反馈的「未知区域路径只要遇到未扫描区域就直接失败」：
     *  1. 未扫描格若 `trueFlag === 2` 直接判 `'blocked'` —— 车还没开就被判死，
     *     学生完全看不到"未知区里到底有什么"，赌档变成"选了就死"的假选择。
     *  2. 未扫描格按**全局** `ENERGY_UNKNOWN_WORST`(1.1) 扣电，而规划用的却是
     *     `profile.unknownWorstCost`(二号 0.3) —— 规划与实际两套系数，结果对不上。
     *
     * 新行为：车经过未扫描格时**先自动揭示**（车载传感器实时获取地形，
     * 这正是"边开边扫"的语义），再按**真实地形**结算：
     *   - 难走(caution) → 按 `profile.cautionCellCost` 扣电（二号 4.5，一号 3.0 同原式）
     *   - 禁行(blocked) → 物理上确实过不去，仍然 'blocked'
     *   - 其余 → 无额外惩罚（已经开过去了，不存在"未知溢价"）
     * 于是未知区路径的失败原因回归**地形本身**（难走格多 → 电量耗尽），
     * 而不是"没扫描过"这个可被学生消除的状态。
     */
    if (c.scanned < 0.5) {
      c.scanned = 1
      // 2026-09-13 老大反馈「走完未知区域后难走路段仍显示 1」：揭示时必须同步分类！
      // 旧代码只设 scanned 不更新 flag → 统计(c.flag===1)与扣电用的都是旧 flag(0)，
      // 真实难走地形全部漏算。与 grid.reclassify 语义一致（scanned>=0.5 → flag=trueFlag）。
      c.flag = c.trueFlag
    }
    if (c.flag === 1) cost += profile.cautionCellCost
    if (c.flag === 2) return 'blocked'
    // 2026-09-12 老大实测「三条路径全部成功」的根因：**规划与实际耗电不一致**。
    // 规划 certain 里 rock/soft 惩罚是第二大的项（未知区域路径走廊铺满 rock≈0.85，
    // certain 377 判失败），但实际行驶的 cellEnergyCost **从来没算过 rock/soft**
    // ——车真的开过去时巨石形同虚设，实际 ~150 < 电池 170，赌档也能跑回来。
    // 补上（按揭示后的真实地表结算），规划与实际才说同一种话：
    if (c.scanned >= 0.5) {
      if (c.rock >= profile.rockThreshold) cost += profile.rockCellCost
      if (c.soft >= profile.softThreshold) cost += profile.softCellCost
    }
    return cost
  }

  const failHauler = (reason: string) => {
    haulerRun = {
      ...haulerRun,
      status: 'failed',
      failReason: reason,
      energy: 0,
    }
    emit()
  }

  const beginHaulerRun = (candidateIndex: number): boolean => {
    const cands = candidatePaths()
    const cand = cands[candidateIndex]
    const cells = cand?.path ?? []
    if (cells.length < 2) return false
    if (!trained) return false
    // 让主丝带在出勤期间画「采集车实际走的路线」，与 hauler 完全对齐，避免车脱离丝带。
    haulerDisplayCells = cells.slice()
    // 往返：去程到能源站采集，回程原路返回主基地。
    const back = cells.slice(0, -1).reverse()
    haulerLegs = [buildLeg(cells), buildLeg([...back, cells[0]])]
    haulerLegIndex = 0
    haulerLegDist = 0
    haulerCollectTime = 0
    haulerEnergyUsed = 0
    haulerRun = {
      status: 'outbound',
      legProgress: 0,
      progress: 0,
      energy: missionBattery,
      battery: missionBattery,
      drivenM: 0,
      failReason: null,
      routeLabel: cand?.label ?? '',
      routeUnknown: cand?.summary?.unknownCells ?? 0,
    }
    emit()
    return true
  }

  /** 本次运行的往返总里程（米）。 */
  const roundTripLength = (): number => haulerLegs.reduce((sum, l) => sum + l.length, 0)

  const HAULER_SPEED = 30 // 米/秒（2026-09-02 用户反馈"太快"：60→30；火星车 DRIVE_SPEED=37.8 不变）
  const HAULER_COLLECT_TIME = 2.2 // 秒

  const resetHaulerRun = () => {
    haulerLegs = []
    haulerLegIndex = 0
    haulerLegDist = 0
    haulerCollectTime = 0
    haulerEnergyUsed = 0
    haulerDisplayCells = []
    haulerRun = {
      status: 'idle',
      legProgress: 0,
      progress: 0,
      energy: missionBattery,
      battery: missionBattery,
      drivenM: 0,
      failReason: null,
      routeLabel: '',
      routeUnknown: 0,
    }
    emit()
  }

  const stepHauler = (dt: number) => {
    if (haulerRun.status === 'idle' || haulerRun.status === 'success' || haulerRun.status === 'failed') return
    if (haulerRun.status === 'collecting') {
      haulerCollectTime += dt
      const f = Math.min(1, haulerCollectTime / HAULER_COLLECT_TIME)
      haulerRun = { ...haulerRun, progress: 0.45 + f * 0.1 }
      if (f >= 1) haulerRun = { ...haulerRun, status: 'returning', legProgress: 0 }
      emit()
      return
    }

    const leg = haulerLegs[haulerLegIndex]
    if (!leg || leg.length <= 0) return
    const prevDist = haulerLegDist
    haulerLegDist = Math.min(leg.length, haulerLegDist + HAULER_SPEED * dt)

    // 逐格结算：只结算这一帧新进入的格，避免重复扣电。
    for (let k = 1; k < leg.cum.length; k += 1) {
      const enter = leg.cum[k]
      if (enter > prevDist && enter <= haulerLegDist) {
        const c = leg.cells[k]
        const segLen = leg.cum[k] - leg.cum[k - 1]
        const dh = c.height - leg.cells[k - 1].height
        const cost = cellEnergyCost(c, segLen, dh)
        if (cost === 'blocked') {
          // 撞上了才知道那里是禁行地形——那就把这一片揭示出来。
          // 不揭示的话学生会一直在同一片未知区反复撞车，却看不到地图有任何变化，
          // 表现为"两条路都失败、体验卡死"。失败必须换来新的信息。
          knowledge.reveal(c.x, c.z, SCAN_RADIUS * 0.5)
          grid.syncKnowledge(knowledge)
          failHauler(
            `采集车撞上了还没探明的禁行地形——坡度太陡，车过不去。` +
              `这条路线里有 ${haulerRun.routeUnknown} 格是没扫过的，AI 只能猜，` +
              `猜错了就会撞。回基地重新选一条路线，或者先把未知区扫明白。`,
          )
          return
        }
        haulerEnergyUsed += cost
      }
    }

    if (haulerEnergyUsed >= missionBattery) {
      failHauler(
        haulerLegIndex === 0
          ? `还没开到能源站，电池就见底了。这条路线往返 ${Math.round(roundTripLength())} 米，` +
              `路上难走的路段又额外费电——换一条更省电的路线再来。`
          : `回程路上电池见底，差最后 ${Math.round(leg.length - haulerLegDist)} 米就能回基地。` +
              `能源只够单程，不够往返——换一条路线再来。`,
      )
      return
    }

    const legProgress = leg.length > 0 ? haulerLegDist / leg.length : 1
    const done = haulerLegDist >= leg.length - 1e-6
    if (!done) {
      haulerRun = {
        ...haulerRun,
        legProgress,
        progress: haulerLegIndex === 0 ? legProgress * 0.45 : 0.55 + legProgress * 0.45,
        energy: Math.max(0, missionBattery - haulerEnergyUsed),
        drivenM: haulerRun.drivenM + (haulerLegDist - prevDist),
      }
      emit()
      return
    }

    if (haulerLegIndex === 0) {
      haulerRun = { ...haulerRun, status: 'collecting', legProgress: 0, progress: 0.45, energy: Math.max(0, missionBattery - haulerEnergyUsed) }
    } else {
      haulerRun = {
        ...haulerRun,
        status: 'success',
        legProgress: 1,
        progress: 1,
        energy: Math.max(0, missionBattery - haulerEnergyUsed),
        failReason: null,
      }
      missionComplete = true
      decisionLog.push({ type: 'interact', poiId: 'energy-station', label: '能源站' })
    }
    haulerLegIndex += 1
    haulerLegDist = 0
    emit()
  }

  const haulerRunInfo = (): HaulerRun => haulerRun

  const interact = (): boolean => {
    const near = nearestPoi()
    if (!near || near.dist > near.poi.radius) return false
    hasInteracted = true
    const { poi } = near
    let result = false

    if (poi.kind === 'sample-a' || poi.kind === 'sample-b' || poi.kind === 'sample-c') {
      if (!collectedPoiIds.has(poi.id)) {
        collectedPoiIds.add(poi.id)
        inventory.push({
          id: poi.id,
          label: poi.label,
          kind: 'sample',
          cleaned: false,
          labeled: false,
        })
        ingestStationRecords(poi)
        decisionLog.push({ type: 'collect', poiId: poi.id, label: poi.label })
        result = true
      }
    } else if (poi.kind === 'base-clean') {
      // 清洗台不再"按 E 就洗完"。这里只负责开门，真正的清洗由学生在弹窗里
      // 逐条判定保留/剔除，再经 confirmCleaning() 判分——这是 PBL 的训练环节，
      // 一键完成等于没训练。
      if (records.length > 0) {
        decisionLog.push({ type: 'interact', poiId: poi.id, label: poi.label })
        result = true
      }
    } else if (poi.kind === 'base-label') {
      // 必须先清洗通过，才有干净数据可标注。
      if (cleaningDone) {
        decisionLog.push({ type: 'interact', poiId: poi.id, label: poi.label })
        result = true
      }
    } else if (poi.kind === 'base-train') {
      // 必须先标注通过，才有标准答案可训练。
      if (labelingDone) {
        decisionLog.push({ type: 'interact', poiId: poi.id, label: poi.label })
        result = true
      }
    } else if (poi.kind === 'base-select' || poi.kind === 'maze-entrance') {
      decisionLog.push({ type: 'interact', poiId: poi.id, label: poi.label })
      result = true
    } else if (poi.kind === 'energy-station') {
      // 只有训练好的 AI + 已采集的数据，能源站才会接收并判定任务完成。
      if (!trained) return false
      if (missionComplete) return true
      missionComplete = true
      decisionLog.push({ type: 'interact', poiId: poi.id, label: poi.label })
      result = true
    }

    if (result) {
      completedPoiIds.add(poi.id)
      emit()
    }
    return result
  }

  /** 消耗已标注数据，训练导航 AI。标注未通过时返回 false。 */
  const train = (): boolean => {
    // 训练的前提是"学生亲手把数据标对了"。只采集不标注，等于没给 AI 标准答案。
    if (!labelingDone) return false
    const labeled = records.filter((r) => r.cleanChoice === 'keep' && r.label !== null)
    if (labeled.length === 0) return false
    // 训练：把已标注样本、覆盖范围、规则阈值、不确定性决策综合成 AI 信心。
    // 数据越多、清洗标注越完整、探明区域越广、决策越明确，信心越高。
    const sampleScore = Math.min(0.55, labeled.length * 0.045)
    const allCleanedAndLabeled = records.length > 0 && records.every((r) => r.cleanChoice !== null && (r.cleanChoice === 'drop' || r.label !== null))
    const cleanScore = allCleanedAndLabeled ? 0.1 : 0
    const coverageScore = Math.min(0.2, knowledge.coverage() * 0.5)
    const ruleScore = (grid.cautionDeg < grid.blockedDeg && scansUsed > 0) ? 0.05 : 0
    const choiceScore = uncertaintyChoice ? 0.1 : 0
    aiConfidence = Math.min(0.98, sampleScore + cleanScore + coverageScore + ruleScore + choiceScore)
    trained = true
    decisionLog.push({ type: 'interact', poiId: 'base-train', label: 'AI 训练舱' })
    emit()
    return true
  }

  const getAiConfidence = (): number => aiConfidence

  /** 自动驾驶验证车（资源采集车）沿当前路线做确定性模拟验证。 */
  const validateRouteWithAI = (): ValidationResult => {
    const cells = result?.path ?? []
    if (cells.length < 2) {
      return { ok: false, reason: '还没有规划路线，验证车无法出发。', cell: null, distance: 0 }
    }
    if (!trained) {
      return { ok: false, reason: '导航 AI 尚未训练，验证车不敢自动驾驶。', cell: null, distance: 0 }
    }
    // 路线风险 = 隐藏禁行格占路线长度比例；AI 信心需覆盖该风险才会成功。
    const hidden = cells.filter((c) => c.scanned < 0.5 && c.trueFlag === 2)
    if (hidden.length === 0) {
      return { ok: true, message: '路线已被完全探明，AI 验证车安全通过。' }
    }
    const pathLenCells = cells.length
    const requiredConfidence = Math.min(0.95, (hidden.length / pathLenCells) * 2.5 + 0.12)
    if (aiConfidence >= requiredConfidence) {
      return { ok: true, message: `AI 信心 ${(aiConfidence * 100).toFixed(0)}% 足以应对 ${hidden.length} 处未知风险。` }
    }
    // 信心不足：在第一个隐藏禁行格失败，该点变成真实训练样本。
    const failCell = hidden[0]
    return {
      ok: false,
      reason: `AI 信心 ${(aiConfidence * 100).toFixed(0)}% 不足以应对 ${hidden.length} 处未知风险，验证车在未探明危险格触停。`,
      cell: { x: failCell.x, z: failCell.z },
      distance: pathCum[Math.max(0, cells.indexOf(failCell))] ?? 0,
    }
  }

  /** 把 AI 验证失败点加入训练集（揭示该格）并切换到 revise 阶段。 */
  const applyAIValidationFailure = (cell: { x: number; z: number }) => {
    knowledge.reveal(cell.x, cell.z, SCAN_RADIUS * 0.6)
    grid.syncKnowledge(knowledge)
    decisionLog.push({ type: 'scan', x: cell.x, z: cell.z, scansLeft: scanBudget - scansUsed })
    if (result) replan()
    phase = 'revise'
    emit()
  }

  /**
   * 候选路线权重剖面。每个剖面回答"这条路线愿意承担哪类代价"。
   *
   * 关键设计（实测得出的结论，不是拍脑袋）：
   * 地形里通往终点的走廊拓扑有限，所以在多条轴上拉开差距：
   *   1. 未知区谨慎度（unknown 权重）：决定绕不绕开没扫过的地方；
   *   2. 地表惩罚（caution / rock / soft）：决定绕不绕开难走的路段；
   *   3. 爬升惩罚（climb）：决定要不要为省力气多绕一点。
   * 多轴同时拉开，才得到几条里程、未知格数、难走格数都明显不同的路线，
   * 学生才有得选；否则几张卡片数字一样，选择界面就是摆设。
   *
   * 剖面都从学生当前的权重出发做倍率缩放，保留"你定的规则"这条主线。
   *
   * 路线集合本身在 `worldProfile.ts`（两张图各自的 `routes`）。
   */
  const ROUTE_PROFILES: RouteProfile[] = profile.routes

  /** 一条路线的往返能源账。未探明区的耗电只能给区间——底下好不好走得走了才知道。 */
  const computeRouteEnergy = (r: PlanResult): RouteEnergy => {
    /**
     * certain 基线：里程 + 谨慎格。两图共用同一公式，差异全部由 `profile` 的
     * 权重参数表达（一号两个地表权重为 0，故结果与改动前逐值相等）。
     *
     * 设计动机（§2.6）：古汉道会硬穿半埋细沙，软沙格数远多于其他两条，
     * 不把软沙计入 certain 就推不到"必翻车"区间，三档无法拉开。
     */
    // 难走格系数走 profile：一号 3.0（原式）、二号 4.5（老大的"耗电押在难走路段"原则）。
    const baseCertain1 =
      r.lengthM * ENERGY_PER_METER + r.cautionCells * profile.cautionCellCost

    // 地表惩罚：软沙 / 岩石计入 certain（二号专属；一号两个权重为 0 → 原式，零回归护栏，铁律 #1）。
    // 等价性：World 0 时 softCellCost = rockCellCost = 0，surfaceCertain1 退化为 baseCertain1，
    // 于是 best1/worst1/certain1 与改动前逐值相等。
    const surfaceCertain1 =
      baseCertain1 + r.softCells * profile.softCellCost + r.rockCells * profile.rockCellCost
    // 未知区系数也走 profile：二号把它**调低**（0.2→0.15、1.1→0.6），
    // 让耗电主要来自地形本身，而不是"有没有扫描"——扫描是学生能改变的状态，
    // 把耗电押在 unknown 上，学生一扫风险就被抹平（老大的原则）。
    const best1 = surfaceCertain1 + r.unknownCells * profile.unknownBestCost
    // 低置信度惩罚**只进 worst、不进 best**：这些格"扫过了但没看清"（支谷被崖壁遮挡），
    // 乐观时可以假设它们其实好走，悲观时才暴露代价。二者之差就是不可消除的赌性——
    // 这是赌档「best < B < worst」成立的机制基础（铁律 #6）。一号该权重为 0，原式不变。
    const worst1 =
      surfaceCertain1 +
      r.unknownCells * profile.unknownWorstCost +
      r.lowConfCells * profile.lowConfCellCost
    const certain1 = surfaceCertain1

    // 坡度能耗（开关在 profile，仅火星二号启用，设计 §2.5）：往返的爬升/下坡量。
    // 往返净高差为 0（起点台地 0 m → 谷底 → 返回 0 m），但上坡费电、下坡省电不对称：
    // 去程的上坡段返程变成下坡、去程的下坡段返程变成上坡，故往返坡度能耗 =
    // (爬升量 + 下坡量) × (ENERGY_PER_CLIMB_METER + ENERGY_PER_DESCENT_METER)。
    // 这一项与扫描无关——车在真实地形上爬，与"未探明区好不好走"是两个正交维度。
    let climbM = 0
    let descentM = 0
    if (profile.slopeEnergy) {
      const path = r.path
      for (let k = 1; k < path.length; k += 1) {
        const dh = path[k].height - path[k - 1].height
        if (dh > 0) climbM += dh
        else descentM += -dh
      }
    }
    const slopeRound = (climbM + descentM) * (ENERGY_PER_CLIMB_METER + ENERGY_PER_DESCENT_METER)

    return {
      oneWayM: r.lengthM,
      roundTripM: r.lengthM * 2,
      unknownCells: r.unknownCells,
      cautionCells: r.cautionCells,
      softCells: r.softCells,
      rockCells: r.rockCells,
      lowConfCells: r.lowConfCells,
      certain: certain1 * 2 + slopeRound,
      best: best1 * 2 + slopeRound,
      worst: worst1 * 2 + slopeRound,
      battery: missionBattery,
    }
  }

  /**
   * 保守档规划：把未探明格的代价拉到天文数字，逼 A* 只走已探明区。
   *
   * 为什么必须这样：能量模型里的"最坏情况"只假设未知格难走，
   * 但实测时未知格可能真的是禁行地形——撞上就直接失败。
   * 于是会出现"两条路全撞未知禁行格、学生无路可走"的死局。
   * 保守档必须真的全程已知，"稳"这一档才成立。
   *
   * 如果连一条全程已知的路线都排不出来（说明扫描还不够），
   * 就退回普通规划，由上层 UI 明确提示学生继续扫描。
   */
  const planKnownOnly = (
    w: PlanWeights,
    opts: PlanOptions,
    targetCell: { i: number; j: number } = goalCellOf(),
  ): PlanResult => {
    const strict: PlanWeights = { ...w, unknown: 1e9 }
    const r = planPath(grid, startCell, targetCell, strict, opts)
    if (r.found && r.unknownCells === 0) return r
    return planPath(grid, startCell, targetCell, w, opts)
  }

  const candidatePaths = (): RouteCandidate[] =>
    ROUTE_PROFILES.map((p) => {
      const w = p.scale(weights)
      // 走廊约束与三个统计阈值都来自 profile：一号全是空/缺省值
      //（corridor 未配置、lowConfThreshold = 0 → confidence < 0 恒假、soft/rock 阈值 0.5），
      // 规划与计数行为与改动前逐值一致。
      const opts: PlanOptions = {
        corridor: p.corridor,
        lowConfThreshold: profile.lowConfThreshold,
        softThreshold: profile.softThreshold,
        rockThreshold: profile.rockThreshold,
      }
      // 每条路线规划到**自己的目标点**：赌档通向隐藏采集点，其余通向主终点（能源站）。
      const routeGoalCell = goalCellOf(p.goal ?? { x: field.goal.x, z: field.goal.z })
      // knownOnly 档（绕远路 / 沿河主道）必须全程已知、绝不切未知区，走 planKnownOnly；
      // 其余档允许切一小片未知区换里程，走普通规划。
      const r = p.knownOnly
        ? planKnownOnly(w, opts, routeGoalCell)
        : planPath(grid, startCell, routeGoalCell, w, opts)
      return {
        label: p.label,
        note: p.note,
        summary: summarize(r),
        path: r.path,
        energy: r.found ? computeRouteEnergy(r) : null,
      }
    })

  /** 选定一条候选路线作为当前规划结果，并记录决策。 */
  const selectCandidate = (index: number): boolean => {
    const p = ROUTE_PROFILES[index]
    if (!p) return false
    const unknown = p.scale(weights).unknown
    weights.unknown = unknown
    decisionLog.push({ type: 'weight', key: 'unknown', value: unknown })
    // 切到该路线的目标点：赌档 → 隐藏采集点，其余 → 主终点（能源站）。
    // 必须放在 replan() 之前，replan 用 activeGoal 重新规划。
    activeGoal = p.goal
      ? { x: p.goal.x, z: p.goal.z }
      : { x: field.goal.x, z: field.goal.z }
    replan()
    setUncertaintyChoice(
      p.uncertainty,
      `选择「${p.label}」候选路线（未知区谨慎度 ${unknown.toFixed(1)}）。`,
    )
    return true
  }

  const reset = () => {
    knowledge.reset()
    scansUsed = 0
    result = null
    phase = 'scan'
    // currentWorld 保持不变：reset 是同一地图内重来，不是切换地图
    grid.setThresholds(14, 24)
    Object.assign(weights, DEFAULT_WEIGHTS)
    driveProg = 0
    driveStatus = 'idle'
    stuckAt = null
    stuckReason = null
    stuckHazard = null
    awaitingBlindCommand = false
    blindCommanded = false
    blindReveals = []
    arrivedManual = false
    manualOn = false
    manualV = 0
    manualDist = 0
    manualThrottle = 0
    manualSteer = 0
    manualX = ROVER_SPAWN.x
    manualZ = ROVER_SPAWN.z
    manualHeading = 0
    // aiquests 六步闭环状态一并清空
    uncertaintyChoice = null
    uncertaintyReason = ''
    decisionLog.length = 0
    runs.length = 0
    previousPlan = null
    currentRun = 0
    currentTrace = []
    lastTraceDist = 0
    inventory.length = 0
    collectedPoiIds.clear()
    completedPoiIds.clear()
    hasInteracted = false
    trained = false
    aiConfidence = 0
    missionComplete = false
    records.length = 0
    cleaningDone = false
    labelingDone = false
    resetHaulerRun()
    bootstrap()
    emit()
  }

  bootstrap()

  return {
    field,
    knowledge,
    grid,
    result: () => result,
    path: () => result?.path ?? [],
    /** 采集车当前出勤实际走的路线 cell 列表（主丝带在出勤期间应画这条，与 hauler 对齐）。无出勤时为空。 */
    haulerRoute: () => haulerDisplayCells,
    snapshot,
    scanAt,
    setThresholds,
    setWeight,
    replan,
    setPhase,
    advance,
    startDrive,
    stepDrive,
    stopDrive,
    escapeFromStuck,
    issueBlindCommand,
    driveInfo,
    enterManual,
    exitManual,
    manualActive,
    manualPose,
    roverPosition: roverWorldPosition,
    setManualInput,
    stepManual,
    setUncertaintyChoice,
    getDecisionLog,
    getRuns,
    reset,
    interact,
    nearbyPoi,
    completedPoiIds: () => completedPoiIds,
    pois: () => POIS,
    train,
    aiConfidence: getAiConfidence,
    validateRouteWithAI,
    applyAIValidationFailure,
    candidatePaths,
    selectCandidate,
    setRecordCleanChoice,
    confirmCleaning,
    setRecordLabel,
    confirmLabeling,
    beginHaulerRun,
    stepHauler,
    resetHaulerRun,
    haulerRun: haulerRunInfo,
    subscribe: (listener) => {
      listeners.add(listener)
      listener(snapshot())
      return () => listeners.delete(listener)
    },
  }
}
