/**
 * 火星任务「世界档案」：两张地图的全部差异化参数集中在此。
 *
 * ## 为什么存在这个文件（2026-09-05 老大拍板）
 *
 * 老大的原话：「如果二号地图的一项开发任务，会引起二号地图和一号地图的冲突，
 * 那么可以考虑将这项二号地图的任务独立开发。」
 *
 * 在此之前，二号的所有差异都以 `if (currentWorld === 1)` 的形式散落在 `mission.ts`
 * 里——每加一个二号特性就要往共享代码里多插一个分支。分支越多，改动二号时
 * 误伤一号的概率越高，而这恰恰是红线（「完全不影响火星一号」）最不能接受的。
 *
 * 收敛成 profile 之后：
 * - **后续二号任务只改本文件**，不再往 `mission.ts` 插新分支；
 * - `WORLD_PROFILES[0]` 的每一项取值都等于一号当前的行为（等价搬迁，字节级不变）；
 * - `WORLD_PROFILES[1]` 是二号自由迭代区，随便改都碰不到一号。
 *
 * ## 依赖方向（单向，禁止反转）
 *
 * `mission.ts` → `worldProfile.ts` → `planner.ts`
 *
 * 本文件**不得** import `mission.ts`，否则形成循环依赖。因此能源常量、
 * `UncertaintyChoice`、`RouteProfile` 全部下沉到此处，由 `mission.ts` re-export
 * 以保持对外 API 不变（`import { HAULER_BATTERY } from './mission'` 仍然有效）。
 */

import {
  GAMBLE_CORRIDOR,
  HIDDEN_SAMPLE,
  OUTFLOW_GOAL,
  OUTFLOW_SPINES,
  OUTFLOW_START,
} from './heightField'
import { DEFAULT_WEIGHTS, type Corridor, type PlanWeights } from './planner'

// ---------------------------------------------------------------------------
// 采集车能源模型（教学简化模型，不是真实火星车工程数值）
// ---------------------------------------------------------------------------

/** 采集车电池总量（火星一号）。整个验证过程只能用这么多电。 */
export const HAULER_BATTERY = 100
/**
 * 每米行驶的基础耗电。
 * 标定依据：让"绕远路"往返约 2800m 时，光里程就吃掉约 73% 的电池——
 * 路线够长就一定紧张，学生必须真的去比较两条路线，而不是闭眼选最短的。
 */
export const ENERGY_PER_METER = 0.026
/**
 * 每格"难走"（谨慎）路段的额外耗电——颠簸路面更费电。
 * 标定依据：这是"走近路"的致命项。走近路会硬穿 8~11 格难走路段，
 * 往返合计 48~66 点耗电，足以把总账推到 100 以上——学生一算就能把它排除。
 */
export const ENERGY_PER_CAUTION_CELL = 3.0
/** 每格未探明区域在最乐观情况下的额外耗电（底下其实很好走）。 */
export const ENERGY_UNKNOWN_BEST = 0.2
/**
 * 每格未探明区域在最悲观情况下的额外耗电（底下其实很难走）。
 * 标定依据：走近路会切过一小片未知区，未知格越多最坏耗电越高。
 * 让这条路线的最坏值稳稳跨过 100——它真的可能死，不是吓唬人。
 */
export const ENERGY_UNKNOWN_WORST = 1.1
/**
 * 每米上坡的额外耗电（爬升更费电）。仅火星二号地图启用（坡度能耗，设计 §2.5）。
 * 火星一号（world 0）不启用——它的路线拓扑里"爬不爬坑缘"不是决策点，加进去只会
 * 污染已通过审核的一号能源账，触发零回归红线。
 */
export const ENERGY_PER_CLIMB_METER = 0.45
/**
 * 每米下坡的额外耗电（负值：下坡省电，重力助力）。仅火星二号地图启用（设计 §2.5）。
 * 负值不是"免费发电"，而是"下坡这段比平路省 0.08 点/米"的教学简化表达。
 */
export const ENERGY_PER_DESCENT_METER = -0.08

/**
 * 火星二号采集车电池总量（内部物理容量）。
 *
 * 用户看到的能源条只是 `(energy/battery)*100%` 的百分比——
 * 学生不需要、也不应该看到电池的真实物理值。本常量决定二号地图的"100%"对应多少内部单位，
 * UI 文本与读条宽度都不变。
 *
 * **选 170 的依据**（2026-09-06 按隐藏采集点方案重标定，二轮仿真实证）：
 *   加入隐藏采集点（西南角）与赌档走廊的坑群/巨石后，实测三路线：
 *     - 沿河主道（稳）：全扫 certain **141** < 170，余 29 ✅ 稳过
 *     - 古汉道（死）  ：全扫 certain **232** > 170，超 62 ✅ 必死
 *     - 未知区域（赌）：不扫 best **164** < 170 < worst **243** ✅ 赌档窗口成立
 *                      全扫 certain **220** > 170 ✅ 扫完也是最耗电的一条
 *   三档各归其位，且赌档同时满足老大两条要求（不扫是赌、扫完最耗电）。
 *
 *   历史值留档：初版 120（2026-09-04，当时三路线 107.2/133.7/134.0）；
 *   后因地加入隐藏路径与难走地形、坡度能耗整体抬升，120 会让三条全成死档
 *   （实测 141/232/220），学生无路可走，故上调至 170。
 *
 *   ⚠️ 注意"不扫时所有路线 worst 都 > 170"是**正确的教学**：不扫描就无法确定
 *   任何路线可行，这正是"先扫描再决策"的压力来源；"稳档"指的是**扫完后**稳过。
 *
 *   ⚠️ 当前地形下赌档窗口（best<B<worst）不成立：best = certain + unknown×0.2 ≥ certain
 *   = 134.0 > 120，故 best 不可能 < 120。根因不是数值，而是机制——只要能扫明全图，
 *   unknown 惩罚就归零，赌档必然塌缩（与一号当年删赌档同一根因）。正解见 #422：
 *   用「置信度上限」让未知风险不可归零，而不是调 soft/rock 权重（那只会让 certain 更大）。
 */
// 2026-09-12：170→180。rock/soft 纳入实际行驶结算后，b 档 worst 168 贴着 170 零余量，
// 任何一格实际偏差都会误杀稳档（老大实测三路全失败）；180 让 b 恢复成功、a/c 仍必败。
// 窗口锁 (150, 190) 仍通过。
export const WORLD1_HAULER_BATTERY = 180

/**
 * 每格「软沙」的额外耗电。仅火星二号启用（设计 §2.6 三路线分化）。
 *
 * 标定依据：软沙是"轮胎打滑 + 起动损耗"的代价，比岩石颠簸更痛但比堵死禁行轻。
 * 选 1.5：不会单独把沿河主道推过电池线。
 */
export const ENERGY_PER_SOFT_CELL = 1.5

/**
 * 每格「岩石」的额外耗电。仅火星二号启用（设计 §2.6 三路线分化）。
 *
 * 选 1.2：比软沙轻一点，比谨慎格（3.0）轻一截——表达"颠簸但不至于被困"。
 */
export const ENERGY_PER_ROCK_CELL = 1.2

/**
 * 每格「低置信度」区域的额外耗电，只计入 worst、不计入 best（设计 §2.2）。
 *
 * 这是**赌档不可消除**的机制基础（铁律 #6）：支谷深处被崖壁遮挡，即使扫过，
 * 置信度也有上限，其风险不可通过扫描归零。二号专属，一号恒为 0。
 *
 * 选 0.9 的依据（设计 §2.6）：需让北支谷 worst 在任何扫描等级下都 > 120，
 * 同时 best 不受影响（best 是"乐观情况"，乐观时低置信区恰好是好走的）。
 * 具体标定在 #422 实施时按仿真回调，**不硬凑**。
 */
export const ENERGY_PER_LOWCONF_CELL = 0.9

/**
 * 判定「低置信度格」的阈值：cell.confidence 低于此值即计入低置信惩罚。
 * 仅火星二号启用。
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.55

// ---------------------------------------------------------------------------
// 类型（从 mission.ts 下沉，避免循环依赖）
// ---------------------------------------------------------------------------

/** 学生面对未探明区时的处置选择。 */
export type UncertaintyChoice = 'detour' | 'pass-reason' | 'accept-risk' | null

/** 一条候选路线的规划参数。 */
export type RouteProfile = {
  label: string
  note: string
  /** true = 全程已知的保守档（走 planKnownOnly），绝不切未探明区。 */
  knownOnly: boolean
  /** 选定该路线时对应的不确定性处置（留待复盘对照）。 */
  uncertainty: NonNullable<UncertaintyChoice>
  scale: (w: PlanWeights) => PlanWeights
  /**
   * 地理走廊约束：让本路线在**几何上真的沿它自己的地物走**。
   *
   * 2026-09-05 实测教训：只靠 `scale` 的权重倍率区分路线不够——古汉道（caution×0.06）
   * 与北支谷（×0.05）只差 0.01，A* 收敛到了同一条几何最短路，三张卡片实际只有两条路。
   * 走廊把"沿哪条地物走"变成显式约束。火星一号不使用（不配置即关闭，零回归）。
   */
  corridor?: Corridor
  /**
   * 本路线的目标点（世界坐标）。**缺省 = 主终点**（`field.goal` 能源站）。
   *
   * 赌档路线必须显式指定：它通向**隐藏采集点**（`HIDDEN_SAMPLE`），是完全独立的
   * 第二条任务路径（老大 2026-09-06 方案）。因为没有 UI 标记，学生不知道那里有
   * 采集点，也就不会去扫那条路 → 它保持未探明 → 赌档成立。
   */
  goal?: { x: number; z: number }
}

// ---------------------------------------------------------------------------
// 路线集合
// ---------------------------------------------------------------------------

/**
 * 火星一号两条路线（已通过最终审核，**禁止修改**）。
 *
 * 命名沿用历史文案（走近路/绕远路）。这两条是"稳/死"两档：
 * 走近路 certain > 100 必死，绕远路充分扫描后 worst < 100 稳过。
 */
export const WORLD0_ROUTE_PROFILES: RouteProfile[] = [
  {
    label: '走近路',
    note: '为了近，愿意切过一小片没扫过的地段，也愿意硬穿颠簸的岩石路面',
    knownOnly: false,
    uncertainty: 'pass-reason',
    scale: (w) => ({
      ...w,
      // 未知区谨慎度介于保守档与激进档之间：切一点未知区换里程，
      // 但不像旧版"穿未知区"档那样一路直穿。这样两条路线的里程才有可辨识的梯度。
      unknown: Math.max(6, w.unknown * 3),
      caution: w.caution * 0.06,
      rock: w.rock * 0.06,
      soft: w.soft * 0.06,
      climb: w.climb * 0.1,
    }),
  },
  {
    label: '绕远路',
    note: '全程贴着已探明区走，绕开所有没扫过的地段，也不走颠簸路面',
    knownOnly: true,
    uncertainty: 'detour',
    scale: (w) => ({
      ...w,
      // 保守档必须"真的干净"：未知格和难走格都要压到接近 0，
      // 否则它跟走近路的耗电账拉不开差距，学生就没得选。
      unknown: Math.max(80, w.unknown * 45),
      caution: w.caution * 8,
      rock: w.rock * 8,
      soft: w.soft * 8,
      climb: w.climb * 8,
    }),
  },
]

/**
 * 二号地图两条激进路线的**完整走廊**：起点 → 途经地物 → 终点。
 *
 * 2026-09-05 实测教训（重要）：走廊必须是覆盖全程的折线，**不能只放地物本身那一小段**。
 * 地物段（古汉道 130 m、支谷 141 m）相对约 2400 m 的路径太短——起点段就已经把
 * "偏离走廊"的惩罚吃到饱和，惩罚退化成一个全图近似常数，改变不了 A* 的相对选择。
 * 实测三条路线仍锁在同一条几何最短路（里程都 2366 m），走廊等于没接。
 */
const OUTFLOW_START_PT: readonly [number, number] = [OUTFLOW_START.x, OUTFLOW_START.z]
const OUTFLOW_GOAL_PT: readonly [number, number] = [OUTFLOW_GOAL.x, OUTFLOW_GOAL.z]

/**
 * 古汉道走廊：起点 → **新 S 型河道首端** → 古汉道（切弯走台地）→ **新 S 型河道尾端** → 终点。
 *
 * 2026-09-11：两端原是旧直线河道坐标 [-280,180]/[210,-200]，河道 S 化后与 spine 脱节，
 * 已改为新 spine 的首尾（[-300,200] / [250,-235]）。中间段直接展开
 * `OUTFLOW_SPINES.oldChannel`，地形改了这里自动跟随。
 */
const CORRIDOR_OLD_CHANNEL: ReadonlyArray<readonly [number, number]> = [
  OUTFLOW_START_PT,
  [-300, 200],
  ...OUTFLOW_SPINES.oldChannel,
  [250, -235],
  OUTFLOW_GOAL_PT,
]

/** 北支谷走廊：起点 → 主河道中段 → 折向东北进支谷 → 回终点。 */
const CORRIDOR_TRIBUTARY: ReadonlyArray<readonly [number, number]> = [
  OUTFLOW_START_PT,
  [-280, 180],
  [-170, 90],
  ...OUTFLOW_SPINES.tributary,
  OUTFLOW_GOAL_PT,
]

/**
 * 火星二号三条地理路线（设计 §2.6）。三轴拉开：里程 / 难走格 / 未知格。
 * - 沿河主道：保守档，全程已知、沿主河道谷底走。
 * - 古汉道：抄废弃河曲近路，硬穿半埋细沙与颠簸路面。
 * - 北支谷：从支谷盲区直插，里程最短但未知格最多。
 *
 * **命名只给地理、不给难易**（铁律 #3 UI 不泄答案）——档位结论由学生自己算出来。
 * 禁止出现"绕远路/走近路/稳妥路线/险路"等含长度或风险暗示的措辞。
 */
export const WORLD1_ROUTE_PROFILES: RouteProfile[] = [
  {
    label: '沿河主道',
    note: '沿主外流河道的谷底行进',
    knownOnly: true,
    uncertainty: 'detour',
    // 不加走廊：本档是"全程已知"的保守档，靠 unknown=1e9 强约束 + caution×8 已经能
    // 稳定走出 R1 畅通坡道（实测 caution=1、certain=107.2 < 120，稳档成立）。
    // 2026-09-05 实测教训：一旦给它加走廊，会被强行拉进河道走 14–24° 的 caution 路，
    // caution 从 1 涨到 8、certain 涨到 135 → 稳档直接变死档。保守档不要干预它的绕行。
    scale: (w) => ({
      ...w,
      unknown: Math.max(80, w.unknown * 45),
      caution: w.caution * 8,
      rock: w.rock * 8,
      soft: w.soft * 8,
      climb: w.climb * 8,
    }),
  },
  {
    label: '古汉道',
    note: '沿古汉道（废弃河曲）行进',
    knownOnly: false,
    uncertainty: 'pass-reason',
    // 2026-09-11 第 11 条：strength 0.1 → 0.3。
    // 老大的 a 档要求「**难走的路不少，耗电厉害**」，而本档 caution 权重只有 ×0.06
    // （即"不避开难走格"）——光靠低权重不够，A\* 仍会顺手走最短路。
    // 必须**强走廊**把它压到台地古汉道上（台地边缘难走格密集），才会真的耗电。
    // 2026-09-11 第 11 条调试记录（重要，别回退）：
    //  - 曾误判"台地 = 难走"，实测**台地是平的（cau 2）**，真正难走的是
    //    **距河道 60~105m 的谷壁斜坡带**（坡度≈20°，落 caution 档）。
    //  - radius 150 太大：A\* 在半径 150m 内可自由挑平缓路走，走廊等于没约束
    //    （实测古汉道 cau 只有 2 → 反而变成功，违背 a 档"难走耗电"）。
    //    **收紧到 60m** 才会把路径真正压到古汉道那条弦线上（弦线中段距 spine≈75m，
    //    正好落在谷壁斜坡带内）。
    corridor: { spine: CORRIDOR_OLD_CHANNEL, radius: 60, strength: 0.8 },
    scale: (w) => ({
      ...w,
      unknown: Math.max(6, w.unknown * 3),
      caution: w.caution * 0.06,
      rock: w.rock * 0.06,
      soft: w.soft * 0.06,
      climb: w.climb * 0.1,
    }),
  },
  {
    label: '未知区域',
    note: '朝地图边缘的未探明地带行进',
    knownOnly: false,
    uncertainty: 'accept-risk',
    // 通向**隐藏采集点**：第二个可采集终点，全程无 UI 标记（无信标/标签/箭头）。
    // 学生只看到"这条里程明显最短"，却不知道它通向哪里、底下藏着什么。
    goal: { x: HIDDEN_SAMPLE.x, z: HIDDEN_SAMPLE.z },
    // strength 0.25（高于另外两条的 0.1）：必须让路径**真正贴着走廊走**，
    // 才会压到足够多的坑与巨石上。实测 strength=0.1 时 A* 只把 25% 的格子落在
    // 走廊内（rock 仅 17 格、certain 180 < 古汉道 192），"扫完最耗电"这条就不成立。
    // 2026-09-11 第 11 条：**c 档必须真的难走**。
    // 原 strength 0.25 / radius 150 实测 cau 只有 1——它根本没压到难走地形上，
    // 全靠"未知格多"撑起 worst，这与老大的要求（"路程最短但难走的路非常多"）不符；
    // 而且一旦为了救 b 档下调 unknown 系数，c 会跟着一起变成功。
    // 与古汉道同理：radius 收紧到 60、strength 提到 0.8，把路径真正压到走廊线上。
    corridor: { spine: GAMBLE_CORRIDOR, radius: 60, strength: 0.8 },
    scale: (w) => ({
      ...w,
      unknown: Math.max(1, w.unknown * 0.12),
      caution: w.caution * 0.05,
      rock: w.rock * 0.05,
      soft: w.soft * 0.05,
      climb: w.climb * 0.05,
    }),
  },
]

// ---------------------------------------------------------------------------
// 世界档案表
// ---------------------------------------------------------------------------

export type WorldProfile = {
  /** 采集车电池内部物理容量。UI 只显示 `(energy/battery)*100%`，不暴露此值。 */
  battery: number
  /**
   * 盲区指挥机制（设计 §2.6 P6）。
   * 火星一号**根本不启用**该机制（`enabled: false`），故 `awaitingBlindCommand` 恒为 false。
   */
  blindZone: {
    enabled: boolean
    /** 路径上连续未探明段超过此长度（米）才触发盲区指挥。 */
    minM: number
  }
  /** 是否启用坡度能耗（ENERGY_PER_CLIMB_METER / ENERGY_PER_DESCENT_METER）。 */
  slopeEnergy: boolean
  /** 每格软沙计入 certain 的额外耗电。一号为 0（不把 soft 计入 certain）。 */
  softCellCost: number
  /**
   * 每格岩石计入 certain 的额外耗电。
   *
   * ⚠️ 二号当前为 **0**——2026-09-05 实测：把 rock 计入 certain 是有害的。
   * 三条路线的 rock 格数都是 11~12 格（几乎无差异），它**不产生任何档位分化**，
   * 却把沿河主道（稳档）的 certain 从 107.2 抬高到 133.3，直接把稳档打成死档。
   * 设计文档 §2.6 只要求"软沙"计入 certain（古汉道硬穿半埋细沙），岩石从未被要求。
   * 字段保留是为了不丢掉这层可调参数，当前不启用。
   */
  rockCellCost: number
  /** 每格低置信度区计入 worst（不计 best）的额外耗电。一号为 0。 */
  lowConfCellCost: number
  /**
   * 每格难走路段的耗电系数。
   *
   * **老大的设计原则（2026-09-09）**：耗电要押在**用户无法改变的难走路段**上，
   * 而不是可被扫描消除的未知区域——扫描是学生能改的状态，把耗电押在 unknown 上，
   * 学生一扫风险就被抹平，赌档与"只有一条路能成"都会失效。
   *
   * 故二号把 caution 系数**提高**（3.0 → 4.5）、把 unknown 系数**降低**，
   * 让耗电主要来自地形本身。一号保持原值（零回归）。
   */
  cautionCellCost: number
  /** 每格未知区的**乐观**耗电系数。一号 0.2 ／ 二号 0.15。 */
  unknownBestCost: number
  /** 每格未知区的**悲观**耗电系数。一号 1.1 ／ 二号 0.6。 */
  unknownWorstCost: number
  /** 判定低置信度格的 confidence 阈值。 */
  lowConfThreshold: number
  /**
   * 判定"软沙格"的 `cell.soft` 阈值。
   *
   * 2026-09-05 实测：二号地形 soft 峰值仅 0.21~0.25，用 0.5 判定则 softCells 恒为 0，
   * 软沙这一维度等于没接上。降到 0.3 让它真的生效。
   * **一号必须保持 0.5**——改动它会让一号的 softCells/rockCells 从 0 变非 0，
   * 直接污染已审核的一号能源账（红线）。
   */
  softThreshold: number
  /** 判定"岩石格"的 `cell.rock` 阈值。同上：一号 0.5，二号 0.3。 */
  rockThreshold: number
  /** 候选路线集合。 */
  routes: RouteProfile[]
}

/**
 * 两张地图的档案。**索引 0 = 火星一号，索引 1 = 火星二号。**
 *
 * ⚠️ `WORLD_PROFILES[0]` 已通过用户最终审核：任何数值改动都等于改动一号任务层，
 * 必须先经老大审核（红线）。二号（索引 1）是自由迭代区。
 */
export const WORLD_PROFILES: readonly [WorldProfile, WorldProfile] = [
  // ---- 火星一号（world 0）· 已审核，禁止改动 ----
  {
    battery: HAULER_BATTERY,
    blindZone: { enabled: false, minM: 12 },
    slopeEnergy: false,
    softCellCost: 0,
    rockCellCost: 0,
    lowConfCellCost: 0,
    // 一号：全部保持改动前的原值（零回归红线）
    cautionCellCost: ENERGY_PER_CAUTION_CELL,
    unknownBestCost: ENERGY_UNKNOWN_BEST,
    unknownWorstCost: ENERGY_UNKNOWN_WORST,
    lowConfThreshold: 0,
    softThreshold: 0.5,
    rockThreshold: 0.5,
    routes: WORLD0_ROUTE_PROFILES,
  },
  // ---- 火星二号（world 1）· 自由迭代区 ----
  {
    battery: WORLD1_HAULER_BATTERY,
    blindZone: { enabled: true, minM: 60 },
    slopeEnergy: true,
    softCellCost: ENERGY_PER_SOFT_CELL,
    /**
     * 岩石重新启用（2026-09-06）。此前设为 0 是因为三条路线 rock 都是 11~15 格、
     * 毫无分化却把稳档抬高 26 点。现在不同了：赌档走廊被显式铺上巨石（rock≈0.85），
     * 而沿河主道实测峰值仅 **0.49、够不到 0.5 阈值**，于是 rock 成为
     * **只在赌档路径上生效**的分化维度——既让隐藏路线"扫完也最耗电"，又不碰其他路线。
     */
    rockCellCost: ENERGY_PER_ROCK_CELL,
    lowConfCellCost: ENERGY_PER_LOWCONF_CELL,
    lowConfThreshold: LOW_CONFIDENCE_THRESHOLD,
    softThreshold: 0.2,
    rockThreshold: 0.5,
    // 二号：难走路段加权重 + 未知区降权重（老大的"耗电押在不可改变处"原则）
    cautionCellCost: 4.5,
    unknownBestCost: 0.15,
    // 2026-09-11 第 11 条：0.6 → 0.3。
    // 老大的 c 档机制是「采集车可以边开边自动扫描」——未知不等于必死，
    // unknown 只是"风险区间"，真正的失败必须来自**难走路段**（caution）。
    // 下调后 b 档 worst 才能落回电池 170 以内；c 档改由收紧后的走廊压 caution 来兜底。
    unknownWorstCost: 0.3,
    routes: WORLD1_ROUTE_PROFILES,
  },
]

/**
 * 按地图索引取档案。索引越界时钳制到 [0,1]，与 `createMission` 的钳制语义一致。
 */
export function worldProfileFor(worldIndex: number): WorldProfile {
  const w = Math.max(0, Math.min(1, Math.trunc(worldIndex) || 0))
  return WORLD_PROFILES[w]
}

/** 默认规划权重（从 planner 转出，供 mission 侧使用）。 */
export { DEFAULT_WEIGHTS }
