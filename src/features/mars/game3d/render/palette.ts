/**
 * 火星任务 3D 舞台的**唯一**调色板。
 *
 * 提示词要求"选定一套克制的高饱和调色板，并在地形、天空、车体、HUD 上贯彻到底"。
 * 因此这里是全场唯一允许出现颜色字面量的地方——其他模块一律从此处引用。
 * 评审若指出色彩不统一，修改点也只有这一个文件。
 *
 * 调性目标：动画赛璐珞。暖橙沙地 + 冷紫阴影 + 高饱和天青作为互补重音。
 * 阴影刻意偏冷偏紫（而不是把亮部调暗），这是让画面读起来像手绘动画而非 PBR 的关键。
 */

export const PALETTE = {
  /** 地表：可通行的平坦沙地（深铁锈红/赭石，对齐参考图，去掉旧版的"苍白米黄"） */
  sandFlat: '#c2633a',
  /** 地表：沙丘波纹的迎光面（更亮更暖的沙脊高光，仍饱和锈橙） */
  duneCrest: '#d98a4e',
  /** 地表：压实砾石（干涸河床，深锈红） */
  gravel: '#9c4a28',
  /** 地表：需谨慎的中坡（深橙红） */
  slopeCaution: '#a83c18',
  /** 地表：超阈值的陡坡（近黑深火星红） */
  slopeBlocked: '#5e1810',
  /** 地表：裸露岩体（坑缘、脊背，深锈红岩） */
  rockOutcrop: '#7a3a26',
  /** 教学叠加：软沙危险（深琥珀，与坡度谨慎色区分） */
  softHazard: '#d97a22',
  /** 教学叠加：岩石危险（与坡度危险色区分的冷蓝灰，色觉障碍可凭图案分辨） */
  rockHazard: '#6f8aa6',

  // ---- 火星二号专属配色（设计文档 §3.3，2026-09-07 新增）----
  /** 帽岩与深层岩层（外流河道崖壁层理的最深色） */
  strataDark: '#5e2a1c',
  /** 岩层中层（同 rockOutcrop 观感，用于层理之间的过渡） */
  strataMid: '#7a3a26',
  /** 岩层浅层（同 gravel，层理顶部与粗砾层） */
  strataLight: '#9c4a28',
  /** 水冰探测点地面（冰楔多边形，冷灰褐，与锈红地表拉开） */
  iceGround: '#b8a094',
  /** 冰楔多边形裂缝 */
  iceCrack: '#6b5a52',
  /** 挖掘坑新鲜断面（最亮，表示新翻出的含水冰土层） */
  iceExcavated: '#d4c4b8',

  /** 阴影染色（冷紫），与亮部做冷暖对冲 */
  shadowTint: '#4b3550',
  /** 最暗档的染色 */
  deepShadowTint: '#33253f',

  /** 天空：天顶（冷灰蓝） */
  skyZenith: '#556180',
  /** 天空：中段 */
  skyMid: '#a87b6a',
  /** 天空：地平线附近的火星尘霭（暖黄粉） */
  skyHorizon: '#e4b88f',
  /** 近地平面尘霭（偏暖橙赭，呼应火星地表与参考图地平线雾感） */
  hazeColor: '#c97b5a',
  /** 沙尘暴泛黄天幕（乌云压顶时的天空染色，偏赭红压暗，更压迫） */
  stormTint: '#93381c',

  /** 太阳本体（偏小偏冷，火星日轮） */
  sunCore: '#fff6e2',
  /** 太阳光晕 */
  sunHalo: '#ffcf8f',

  /** 云/尘幕的亮面 */
  cloudLight: '#f7d9bb',
  /** 云/尘幕的暗面 */
  cloudDark: '#b98a80',

  /** 巨型尘墙亮面（暖赭红，避免风暴墙过淡过亮，压暗增厚） */
  stormWallLight: '#b3603a',
  /** 巨型尘墙主体（赭红，更深更实） */
  stormWallMid: '#8a2f17',
  /** 巨型尘墙暗面/边缘（深红褐，逼近墨黑制造压迫） */
  stormWallDark: '#3f130a',

  /** 墨线（描边）。不是纯黑，是深赭，避免画面发脏 */
  ink: '#2a1620',

  /** 重音色：扫描、路线、UI 高亮（冷青，与暖沙互补） */
  accentCyan: '#3fe0d0',
  /** 重音色：警告 */
  accentWarn: '#ffc247',
  /** 重音色：危险 */
  accentDanger: '#ff6b57',
  /** 重音色：规划器建议路线（高饱和青绿，确保在暖沙/未探测区上可读） */
  accentRoute: '#3fffe3',
  /** 重音色：路线里"猜的路段"（未扫描区上的规划段，用暖橙虚线告警） */
  accentGuess: '#ff9d4d',
  /** 重音色：幽灵/历史路线（低饱和蓝紫，用于非当前建议） */
  accentGhost: '#9fb8ff',

  /** 未扫描区域的低饱和处理 */
  unknownBase: '#7c7387',
  unknownPattern: '#5d5568',
  /** 未探测区覆盖的雾纱色（去色后往这个冷紫灰上靠） */
  unknownVeil: '#6f6880',
  /** 已探明/未探明的数据边界高亮 */
  scanEdge: '#7ff0ff',
  /** 教学网格线（淡暖灰，仅在已探明区显示） */
  gridLine: '#a8998e',

  /** R-7 漫游车：暖灰车体 */
  roverBody: '#bcab95',
  /** R-7：深蓝太阳能板 */
  roverPanel: '#2c3e63',
  /** R-7：深褐轮胎 */
  roverTire: '#352b22',
  /** R-7：火星橙点缀（轮缘、臂端） */
  roverAccent: '#d65a2e',
  /** R-7：浅金属桅杆 */
  roverMetal: '#d9d2c4',
  /** R-7：机械结构暗色（连杆内侧、胎槽、面板缝） */
  roverDark: '#1e1814',
  /** R-7：镜头玻璃 */
  roverGlass: '#8ee8ff',
  /** R-7：悬挂金属（比 roverMetal 稍冷） */
  roverBogie: '#b8b0a4',

  /** 地标建筑：深结构件/岩石暗影 */
  rockDark: '#4d3f3a',
  /** 地标建筑：太阳能电池板深色面 */
  solarDark: '#1f2d4d',

  /** KIBO：白胶囊体 */
  kiboBody: '#f2f5f8',
  /** KIBO：青色 visor 屏 */
  kiboVisor: '#36d6e7',
  /** KIBO：黑色面罩底色 */
  kiboDark: '#111216',
  /** KIBO：黄色发光眼 */
  kiboEye: '#ffe255',
  /** KIBO：黄色微笑 */
  kiboMouth: '#ffe255',
  /** KIBO：灰色关节 */
  kiboJoint: '#6e737a',
  /** KIBO：橙点缀 */
  kiboAccent: '#f0a24b',
  /** KIBO：推进辉光 */
  kiboGlow: '#7ff0ff',
} as const

export type PaletteKey = keyof typeof PALETTE

/** 光照量化档位。索引 0 为最暗，末位为最亮。这三个阈值是整套赛璐珞外观最敏感的参数。 */
export const RAMP_THRESHOLDS = [0.22, 0.46, 0.72] as const

/**
 * 各档位对底色的染色与明度。
 * 亮部略微提亮并偏暖，暗部压暗并偏冷紫——冷暖对冲是动画质感的来源。
 * 亮度上限 1.0，避免经过 sRGB 输出转换后过曝。
 */
export const RAMP_BANDS = [
  { brightness: 0.34, tint: PALETTE.deepShadowTint, tintAmount: 0.50 },
  { brightness: 0.56, tint: PALETTE.shadowTint, tintAmount: 0.38 },
  { brightness: 0.86, tint: PALETTE.sandFlat, tintAmount: 0.10 },
  { brightness: 1.00, tint: PALETTE.sunCore, tintAmount: 0.06 },
] as const

/** 主光方向（世界空间，指向光源）。y=0.58 保留侧光长影，同时让 N·L 梯度更陡，
 *  把 cel-ramp 硬边量化在平缓地形上形成的宽条带压缩变窄，远看不再显眼。
 *  各材质均 normalize 后使用，故无需手动归一。
 *
 *  ⚠️ 这是一号地图（World 0）的取值，已通过最终审核，**不得改动**。
 *  二号地图请用 `sunDirectionFor(1)`。 */
export const SUN_DIRECTION = { x: -0.52, y: 0.58, z: 0.72 }

/**
 * 各地图的主光方向（世界空间，指向光源）。
 *
 * 二号地图走「黄昏暖尘浴」方向：**只降低太阳仰角**，水平方位与一号保持一致
 * （x/z 不变），这样两图的太阳从同一侧来、只是高度不同——既保证观感差异明显，
 * 又不至于让学生重新适应光照方向。
 *
 * | 地图 | 仰角 | 观感 |
 * |---|---|---|
 * | 0 火星一号 | ≈33° | 正午偏高，短硬影 |
 * | 1 火星二号 | ≈11° | 黄昏低角度，长拉影 |
 *
 * 各材质均 normalize 后使用，故无需手动归一。
 */
const SUN_DIRECTIONS = [
  { x: -0.52, y: 0.58, z: 0.72 }, // 火星一号：正午
  { x: -0.52, y: 0.18, z: 0.72 }, // 火星二号：黄昏低角度
] as const

/** 按地图索引取主光方向。索引越界时退回最后一个合法图，避免出现 undefined 光照。 */
export function sunDirectionFor(worldIndex: number): { x: number; y: number; z: number } {
  const w = Math.max(0, Math.min(1, Math.trunc(worldIndex) || 0))
  return SUN_DIRECTIONS[w]
}

/** 天穹与尘霭配色。字段语义与 PALETTE 的 sky* / hazeColor 对应。 */
export type SkyPalette = {
  zenith: string
  mid: string
  horizon: string
  haze: string
}

/**
 * 各地图的天穹 / 尘霭配色。
 *
 * **设计前提（2026-09-04 与用户对齐，不可违背）**：
 * - **地表配色两图保持一致**（都是火星锈红）。视觉差异化**不靠改地表色**——
 *   火星岩石在两图上本来就该一样，把"暖锈红"当差异化卖点会和一号撞车。
 * - 差异化压在**光环境**：低太阳角 + 厚尘暖雾 + 更浓的暖橙地平线。
 * - **不采用深蓝主调**：火星没有地球式"蓝调时刻"。日落仅有太阳周围一圈细蓝边
 *   （尘埃前向散射所致），整片深蓝天在火星上不真实。
 *
 * 一号（索引 0）逐字段沿用 PALETTE 现值，保证零回归。
 */
const SKY_PALETTES: readonly SkyPalette[] = [
  // 火星一号：正午，天顶冷灰蓝、地平线暖黄粉
  {
    zenith: PALETTE.skyZenith,
    mid: PALETTE.skyMid,
    horizon: PALETTE.skyHorizon,
    haze: PALETTE.hazeColor,
  },
  // 火星二号：黄昏。地平线更浓的暖橙粉，天顶偏暖紫而非深蓝，尘霭更厚更暖。
  {
    zenith: '#6b5878',
    mid: '#b87456',
    horizon: '#e8a06a',
    haze: '#d4855c',
  },
] as const

/** 按地图索引取天穹配色。索引越界时退回最后一个合法图。 */
export function skyPaletteFor(worldIndex: number): SkyPalette {
  const w = Math.max(0, Math.min(1, Math.trunc(worldIndex) || 0))
  return SKY_PALETTES[w]
}

/** 十六进制转 0..1 的 RGB 三元组。 */
export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace('#', ''), 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

/** sRGB -> linear 转换。Shader 里的颜色必须在线性空间计算，否则 colorspace_fragment 会二次提亮。 */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** 十六进制转线性 RGB。用于手动写入 DataTexture 或 Color 构造。 */
export function hexToLinearRgb(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex)
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)]
}
