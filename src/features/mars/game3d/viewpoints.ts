/**
 * 评审用固定机位。
 *
 * 每个里程碑的视觉结论都必须基于这些机位的真实截帧，而不是"代码应该会这样渲染"。
 * 机位定义放在产品代码里（而不是只放在测试工装里），是为了让宿主页面能直接切换机位，
 * 人工复核与自动截图看到的是同一组画面。
 */
export type Viewpoint = {
  id: string
  label: string
  /** 评审这一帧时应该重点看什么 */
  focusOn: string
  x: number
  z: number
  /** 方位角（弧度，绝对值）。留空使用默认。 */
  azimuth?: number
  /** 视距（米）。留空使用默认。 */
  distance?: number
  /**
   * 火星二号专用：从 `field.landmarks` 按 id 取实际坐标，覆盖硬编码的 x/z。
   *
   * 为什么需要它：本文件的 x/z 是**火星一号**的坐标，两图地物完全不同
   * （一号 sample-a 在 (-216,236)，二号在 (-150,130)）。不覆盖的话，二号机位
   * 会把相机摆到一号的位置上——表现为"所有机位都跳默认视角"，开发通道没法浏览二号。
   *
   * **一号永远走硬编码 x/z**，故零回归。
   */
  outflowLandmarkId?: string
  /** 该机位适用的地图。留空 = 两图通用。UI 与 `gotoViewpoint` 据此过滤。 */
  worlds?: number[]
}

export const VIEWPOINTS: Viewpoint[] = [
  {
    id: 'overview',
    label: '盆地全景',
    focusOn: '整体构图、地貌可读性、是否出现可见平铺重复、远近尘霭层次',
    x: 0,
    z: 0,
    azimuth: 0.42,
    distance: 620,
  },
  {
    id: 'landing',
    label: '着陆平台',
    focusOn: '平台是否真的水平、平台与周边地形的过渡是否自然',
    x: -300,
    z: 260,
    outflowLandmarkId: 'landing',
    distance: 120,
  },
  {
    id: 'riverbed',
    label: '干涸河床',
    focusOn: '河谷下切是否可读、河床与河岸的分档色带是否清楚',
    x: -284,
    z: 300,
    outflowLandmarkId: 'channel',
    distance: 150,
  },
  {
    id: 'dune',
    label: '风成沙丘带',
    focusOn: '沙丘脊的迎风缓、背风陡是否成立；波纹是否读成噪声',
    x: -264,
    z: -92,
    distance: 140,
  },
  {
    id: 'crater',
    label: '主陨石坑坑缘',
    focusOn: '坑缘抬升、碗底、溅射毯三段结构是否分明；陡坡色带边界是否硬',
    x: 104,
    z: -68,
    distance: 240,
  },
  {
    id: 'ridge',
    label: '岩石迷阵',
    focusOn: '脊背两侧陡坡是否有压迫感；剪影是否清晰；LOD 在此处有无弹跳',
    x: 284,
    z: 8,
    distance: 150,
  },
  {
    id: 'ridge-backlit',
    label: '岩石迷阵 · 逆光剪影',
    focusOn: '逆光下剪影是否立得住；暗部是否死黑；冷暖对冲是否成立',
    x: 284,
    z: 8,
    azimuth: -0.1,
    distance: 130,
  },
  {
    id: 'blind',
    label: '坑缘阴影盲区',
    focusOn: '低置信度区域的视觉编码是否可读（后续里程碑接入扫描遮罩）',
    x: 236,
    z: -216,
    outflowLandmarkId: 'blind',
    distance: 140,
  },
  {
    id: 'target',
    label: '能源站',
    focusOn: '终点区域是否有到达感；与岩石迷阵的空间关系是否清楚',
    x: 420,
    z: -340,
    outflowLandmarkId: 'target',
    distance: 140,
  },
  {
    id: 'horizon',
    label: '盆地边缘天际线',
    focusOn: '边界是否自然收口（不是一堵墙）；天空三段渐变与云幕是否协调',
    x: 80,
    z: 472,
    azimuth: 0.9,
    distance: 220,
  },
  {
    id: 'rover-side',
    // 朝向约定修正后（orientation.ts：模型正面为 +X），R-7 在起点约朝 +X/−Z（heading≈0.73）。
    // 正侧 profile = 沿车体右侧向量 rightVector(h) 取景 → atan2(0.668, 0.744)≈0.73。
    // 必须在 CameraRig 钳制区间 [-0.10, 0.94] 内，且与下面两个特写机位互异。
    label: 'R-7 车侧',
    focusOn: '车体比例、6 轮摇臂转向架、桅杆相机与表情是否读成"友好机器人"；描边是否完整不肥',
    x: -300,
    z: 260,
    azimuth: 0.73,
    distance: 18,
  },
  {
    id: 'rover-face',
    // 真·正面（沿 forwardVector(h)）对应 azimuth≈2.30，超出钳制区间会被夹到 0.94；
    // 0.94 即"可达的最接近正前 3/4"，能露出 visor 与摄像头表情。
    label: 'R-7 桅杆特写',
    focusOn: '摄像头表情、太阳能板栅格、描边在近处的宽度是否恒定',
    x: -300,
    z: 260,
    azimuth: 0.94,
    distance: 12,
  },
  {
    id: 'kibo-guide',
    // KIBO 在 guiding 时悬浮于车体前方（samplePath(driven+16)），需 3/4 取景同时纳入前方 KIBO。
    // 0.50 介于"侧(0.73)"与"前(0.94)"之间，与二者互异且皆在钳制区间内。
    label: 'KIBO 引导悬浮',
    focusOn: 'KIBO 悬浮胶囊、visor 表情、推进辉光与 Rover 的空间关系是否清楚；描边是否完整',
    x: -300,
    z: 260,
    azimuth: 0.5,
    distance: 32,
  },
  {
    id: 'base-ops',
    // 基地 4 个操作台信标（清洗/标注/训练/选路）围绕起点布置，簇半径约 18m。
    // 视距 72 能完整框住整簇信标与标签，又不会太远看不清颜色。
    label: '基地操作台',
    focusOn: '4 个操作台信标（清洗/标注/训练/选路）与 KIBO 的空间关系；信标光柱与文字标签是否清晰可读',
    x: -300,
    z: 260,
    outflowLandmarkId: 'landing',
    azimuth: 0.5,
    distance: 72,
  },
  {
    id: 'sample-a',
    // 河床沉积样本站 A 位于 (-216, 236)，与起点相距约 140m。
    label: '样本站 A',
    focusOn: '河床沉积样本站信标与标签是否立得起来；与地形、远山的可读层次',
    x: -216,
    z: 236,
    outflowLandmarkId: 'sample-a',
    azimuth: 0.4,
    distance: 60,
  },
  // ---- 火星二号专属机位（2026-09-08 修复 dev 通道 bug：原本所有机位共用一号坐标，二号完全无法浏览）----
  // 给 sample-b/c/channel/old-channel 单独的二号机位，避免再次踩机位硬编码一号坐标的坑。
  {
    id: 'sample-b',
    x: 60,
    z: -20,
    label: '样本站 B · 河道层理剖面',
    focusOn: '崖壁层理是否清晰可读、底 3m 粗砾层与上层差异、剖面 75° 视角',
    outflowLandmarkId: 'sample-b',
    azimuth: -0.26,
    distance: 60,
    worlds: [1],
  },
  {
    id: 'sample-c',
    x: 120,
    z: -80,
    label: '样本站 C · 浅层水冰探测点',
    focusOn: '冰楔多边形地面是否清晰、4 根青色标记杆是否立得住、挖掘坑是否可见',
    outflowLandmarkId: 'sample-c',
    azimuth: 0.5,
    distance: 60,
    worlds: [1],
  },
  {
    id: 'channel',
    x: 250,
    z: -230,
    label: '主外流河道',
    focusOn: '主河道谷底 -30m 是否清晰、两侧崖壁 P3-6 层理着色是否成立',
    outflowLandmarkId: 'target',
    azimuth: -0.8,
    distance: 120,
    worlds: [1],
  },
  {
    id: 'old-channel',
    x: 35,
    z: -25,
    label: '古汉道（废弃河曲）',
    focusOn: '废弃河曲是否与主河道在视觉上区分、半埋细沙观感',
    outflowLandmarkId: 'old-channel',
    azimuth: 0.4,
    distance: 80,
    worlds: [1],
  },
  {
    id: 'trib-blind',
    label: '支谷盲区',
    x: 180,
    z: -130,
    // 二号专属：用 id 'trib-blind' 避开与一号坑缘盲区 'blind' 重名 —— findViewpoint
    // 只返回首个匹配，重名会优先命中一号那个、导致二号永远切不到支谷盲区。
    focusOn: '支谷深处因崖壁遮挡的低置信度视觉编码是否生效（P3-6 验证盲区感知）',
    outflowLandmarkId: 'blind',
    azimuth: 0.0,
    distance: 100,
    worlds: [1],
  },
]

export function findViewpoint(id: string): Viewpoint | undefined {
  return VIEWPOINTS.find((v) => v.id === id)
}
