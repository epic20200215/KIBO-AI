/**
 * 分块 LOD 地形网格 + 赛璐珞地表着色。
 *
 * 关键设计
 * ---------
 * 1. **顶点高度直接取自 CPU 高度场**，不在着色器里重算噪声。物理、A\*、渲染读同一份数据，
 *    从构造上杜绝了"看到的地形和算出来的坡度不是一回事"。
 * 2. **LOD 只改采样步长，不改法线来源**。所有 LOD 的顶点法线都用 `field.normalAt` 求得，
 *    因此切档时着色不会突变，只有轮廓会轻微变化，大幅削弱 LOD 弹跳。
 * 3. **裙边补缝**：每块地形四周挂一圈下垂裙边，相邻块 LOD 不同产生的缝隙被裙边挡住，
 *    不需要复杂的边界缝合逻辑。
 * 4. **色带边界即规则边界**：地表分档的坡度阈值是 uniform，与规划器使用的阈值同源。
 *    学生把阈值调松，地图上的红色区域会同步缩小——颜色不是装饰，是数据可视化。
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  LinearFilter,
  Mesh,
  NearestFilter,
  ShaderMaterial,
  Vector2,
  Vector3,
  type Texture,
} from 'three'
import { BASIN_SIZE, FIELD_RES, type HeightField } from '../core/heightField'
import { SOFT_CAUTION, SOFT_BLOCK, ROCK_CAUTION, ROCK_BLOCK } from '../core/grid'
import { PALETTE, sunDirectionFor } from './palette'
import { RAMP_GLSL } from './ramp'

/** 每边分块数。8×8 = 64 块，块边长 75 米。 */
const CHUNKS = 8
/** 每块在 LOD0 下的四边形数。(385-1)/8 = 48，正好对齐高度场采样点。 */
const CHUNK_QUADS = (FIELD_RES - 1) / CHUNKS
/** LOD 采样步长。stride 越大越粗。 */
const LOD_STRIDES = [1, 2, 4, 8] as const
/** LOD 切换距离（米），按块中心到相机焦点的水平距离判定。 */
const LOD_DISTANCES = [110, 220, 360] as const
/** 迟滞带（米），避免在阈值附近来回切档产生闪烁。 */
const LOD_HYSTERESIS = 18
/** 裙边下垂深度（米）。 */
const SKIRT_DEPTH = 14

const HALF = BASIN_SIZE / 2

export type TerrainUniforms = {
  slopeCaution: number
  slopeBlocked: number
}

export type TerrainRenderer = {
  group: Group
  material: ShaderMaterial
  /** 每帧调用：按相机焦点更新各块 LOD */
  updateLod: (focusX: number, focusZ: number) => void
  /** 学生调整通行阈值时调用，色带会立即跟着变 */
  setThresholds: (u: TerrainUniforms) => void
  /** 接入探测置信度纹理。未接入时地表按"全部已探明"渲染（开发机位用） */
  setKnowledgeTexture: (texture: Texture | null) => void
  /** 接入车辙遮罩（M6）。未接入时地表无辙痕。 */
  setTrackMask: (texture: Texture | null) => void
  /** 按画质降低车辙采样精度，减少低端机带宽。 */
  setTrackLod: (scale: number) => void
  /** 低端机强制更粗的 LOD 下限，直接砍三角形数（不影响顶点法线来源，不突变）。 */
  setMinLod: (minLod: number) => void
  setTime: (t: number) => void
  /** 当前实际渲染的三角形数，供性能面板显示 */
  getTriangleCount: () => number
  dispose: () => void
}

function buildChunkGeometry(field: HeightField, cx: number, cz: number, stride: number): BufferGeometry {
  const quads = CHUNK_QUADS / stride
  const n = quads + 1
  const baseI = cx * CHUNK_QUADS
  const baseJ = cz * CHUNK_QUADS

  // 主面顶点 + 四条裙边（每条 n 个顶点）
  const mainCount = n * n
  const skirtCount = n * 4
  const total = mainCount + skirtCount

  const positions = new Float32Array(total * 3)
  const normals = new Float32Array(total * 3)
  const soft = new Float32Array(total)
  const rock = new Float32Array(total)
  const indices: number[] = []

  const nrm: [number, number, number] = [0, 1, 0]

  const writeVertex = (slot: number, x: number, z: number, y: number, flat: boolean) => {
    positions[slot * 3] = x
    positions[slot * 3 + 1] = y
    positions[slot * 3 + 2] = z
    if (flat) {
      normals[slot * 3] = 0
      normals[slot * 3 + 1] = 1
      normals[slot * 3 + 2] = 0
    } else {
      field.normalAt(x, z, nrm)
      normals[slot * 3] = nrm[0]
      normals[slot * 3 + 1] = nrm[1]
      normals[slot * 3 + 2] = nrm[2]
    }
    soft[slot] = field.softAt(x, z)
    rock[slot] = field.rockAt(x, z)
  }

  for (let qj = 0; qj < n; qj += 1) {
    const j = Math.min(FIELD_RES - 1, baseJ + qj * stride)
    const z = -HALF + j * field.cell
    for (let qi = 0; qi < n; qi += 1) {
      const i = Math.min(FIELD_RES - 1, baseI + qi * stride)
      const x = -HALF + i * field.cell
      writeVertex(qj * n + qi, x, z, field.height[j * FIELD_RES + i], false)
    }
  }

  for (let qj = 0; qj < quads; qj += 1) {
    for (let qi = 0; qi < quads; qi += 1) {
      const a = qj * n + qi
      const b = a + 1
      const c = a + n
      const d = c + 1
      indices.push(a, c, b, b, c, d)
    }
  }

  // --- 裙边：沿四条边向下延伸，遮挡相邻块 LOD 不同造成的缝
  let slot = mainCount
  const addSkirt = (edgeIndex: (k: number) => number, reverse: boolean) => {
    const start = slot
    for (let k = 0; k < n; k += 1) {
      const src = edgeIndex(k)
      writeVertex(
        slot,
        positions[src * 3],
        positions[src * 3 + 2],
        positions[src * 3 + 1] - SKIRT_DEPTH,
        true,
      )
      slot += 1
    }
    for (let k = 0; k < n - 1; k += 1) {
      const top0 = edgeIndex(k)
      const top1 = edgeIndex(k + 1)
      const bot0 = start + k
      const bot1 = start + k + 1
      if (reverse) indices.push(top0, bot0, top1, top1, bot0, bot1)
      else indices.push(top0, top1, bot0, top1, bot1, bot0)
    }
  }

  addSkirt((k) => k, false) // 上边 (z 最小)
  addSkirt((k) => (n - 1) * n + k, true) // 下边
  addSkirt((k) => k * n, true) // 左边
  addSkirt((k) => k * n + (n - 1), false) // 右边

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(normals, 3))
  geometry.setAttribute('aSoft', new BufferAttribute(soft, 1))
  geometry.setAttribute('aRock', new BufferAttribute(rock, 1))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}

function createTerrainMaterial(ramp: Texture, worldIndex = 0): ShaderMaterial {
  // new Color(hex) 会把 hex 当作 sRGB 解析并存储为线性值；
  // 之前用 setRGB(...hexToRgb(...)) 是把 sRGB 数字当线性喂进去，导致输出过曝。
  const c = (hex: string) => new Color(hex)
  // 主光方向按地图取用。worldIndex 缺省为 0（火星一号），
  // 取值与改动前的 SUN_DIRECTION 常量完全一致，一号观感不变。
  const sunDir = sunDirectionFor(worldIndex)

  return new ShaderMaterial({
    side: DoubleSide,
    uniforms: {
      uRamp: { value: ramp },
      uSunDir: { value: new Vector3(sunDir.x, sunDir.y, sunDir.z).normalize() },
      uTime: { value: 0 },
      uSlopeCaution: { value: 14 },
      uSlopeBlocked: { value: 24 },
      // --- P5 地表危险阈值（取自 grid.ts，与实测陷车判定同源）。非学生可调，固定常量。
      uSoftCaution: { value: SOFT_CAUTION },
      uSoftBlock: { value: SOFT_BLOCK },
      uRockCaution: { value: ROCK_CAUTION },
      uRockBlock: { value: ROCK_BLOCK },
      uSandFlat: { value: c(PALETTE.sandFlat) },
      uDuneCrest: { value: c(PALETTE.duneCrest) },
      uGravel: { value: c(PALETTE.gravel) },
      uSlopeCautionColor: { value: c(PALETTE.slopeCaution) },
      uSlopeBlockedColor: { value: c(PALETTE.slopeBlocked) },
      uRockOutcrop: { value: c(PALETTE.rockOutcrop) },
      // --- P3-6 崖壁层理（仅火星二号，设计 §2.4）：让外流河道崖壁露出水平岩层，
      //     解决"平顶不糊 + 崖壁可读"。**一号 uStrataStrength = 0 → 整段不执行，逐像素不变。**
      uStrataStrength: { value: worldIndex === 1 ? 0.85 : 0.0 },
      uStrataDark: { value: c(PALETTE.strataDark) },
      uStrataMid: { value: c(PALETTE.strataMid) },
      uStrataLight: { value: c(PALETTE.strataLight) },
      uSoftHazard: { value: c(PALETTE.softHazard) },
      uRockHazard: { value: c(PALETTE.rockHazard) },
      uHaze: { value: c(PALETTE.hazeColor) },
      // 大气尘浓度（P2-2）：二号是黄昏厚尘暖雾，远景更快被尘吃掉、景深更浅。
      // 一号保持 (220, 620) 不变（零回归）；二号收到 (170, 500)——
      // fog 起始更近、完全没入更远，长拉影 + 厚尘的黄昏压迫感才出得来。
      uFogRange: {
        value: new Vector2(worldIndex === 1 ? 170 : 220, worldIndex === 1 ? 500 : 620),
      },
      uContourSpacing: { value: 6.0 },
      // 默认关闭地形等高线：低角度跟车视角下，6m 间距的等高线会在起伏地表上
      // 形成规则明暗条纹，破坏火星地表的观感。后续若需规划视角的等高辅助，
      // 可通过 setContourStrength 在 runtime 按需开启。
      uContourStrength: { value: 0.0 },
      // --- M4 探测置信度
      uKnowledge: { value: null },
      uKnowledgeOn: { value: 0 },
      uBasinSize: { value: BASIN_SIZE },
      uUnknownColor: { value: c(PALETTE.unknownVeil) },
      uScanEdgeColor: { value: c(PALETTE.scanEdge) },
      uGridColor: { value: c(PALETTE.gridLine) },
      uSparkleColor: { value: c(PALETTE.sunCore) },
      // --- M6 车辙遮罩
      uTracks: { value: null },
      uTracksOn: { value: 0 },
      // 地表视觉细节：**2026-09-11 老大实测后要求撤销**（"从颗粒起伏地面恢复到原来的
      // 纯色平面效果"）。值置 0 = 整段 shader 不执行，视觉与改动前一致。
      // 代码保留，后续若要换一种更收敛的细节方案可直接调参复用。
      uDetail: { value: 0 },
      /**
       * 地表**危险色带 / 图案**开关（坡度 + 软沙 + 岩石三套）。
       *
       * 2026-09-11 老大决策：主基地入口坡道被谨慎/禁行色带涂成大片橘黄面片，
       * 确认「地形保留、色带删除」——规划器仍按真实坡度判定（选错坡道照样翻车，
       * 教学陷阱完整保留），但**不在地表涂色块**，视觉回归地形本色。
       * 学生判断危险改为看扫描数据（DOM 层读数），符合"数据驱动决策"的 PBL 教学。
       *
       * 一号 = 1（保留原式），二号 = 0（只渲染地形本色 + 等高线）。
       */
      uHazardBands: { value: worldIndex === 1 ? 0 : 1 },
    },
    vertexShader: /* glsl */ `
      attribute float aSoft;
      attribute float aRock;
      varying vec3 vNormal;
      varying vec3 vWorld;
      varying vec3 vViewDir;
      varying float vSoft;
      varying float vRock;
      varying float vViewDist;

      void main() {
        vSoft = aSoft;
        vRock = aRock;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vec4 viewPos = viewMatrix * world;
        vViewDist = -viewPos.z;
        vViewDir = normalize(-viewPos.xyz);
        gl_Position = projectionMatrix * viewPos;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      ${RAMP_GLSL}

      // --- 地表视觉细节：hash / value noise（渲染层用，不改几何）
      float detailHash21(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }
      float detailNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(detailHash21(i), detailHash21(i + vec2(1.0, 0.0)), u.x),
          mix(detailHash21(i + vec2(0.0, 1.0)), detailHash21(i + vec2(1.0, 1.0)), u.x),
          u.y
        );
      }

      uniform vec3 uSunDir;
      uniform float uTime;
      uniform float uSlopeCaution;
      uniform float uSlopeBlocked;
      uniform float uSoftCaution;
      uniform float uSoftBlock;
      uniform float uRockCaution;
      uniform float uRockBlock;
      uniform vec3 uSandFlat;
      uniform vec3 uDuneCrest;
      uniform vec3 uGravel;
      uniform vec3 uSlopeCautionColor;
      uniform vec3 uSlopeBlockedColor;
      uniform vec3 uRockOutcrop;
      uniform float uStrataStrength;
      uniform float uDetail;
      uniform float uHazardBands;
      uniform vec3 uStrataDark;
      uniform vec3 uStrataMid;
      uniform vec3 uStrataLight;
      uniform vec3 uSoftHazard;
      uniform vec3 uRockHazard;
      uniform vec3 uHaze;
      uniform vec2 uFogRange;
      uniform float uContourSpacing;
      uniform float uContourStrength;
      uniform sampler2D uKnowledge;
      uniform float uKnowledgeOn;
      uniform float uBasinSize;
      uniform vec3 uUnknownColor;
      uniform vec3 uScanEdgeColor;
      uniform vec3 uGridColor;
      uniform vec3 uSparkleColor;
      uniform sampler2D uTracks;
      uniform float uTracksOn;

      varying vec3 vNormal;
      varying vec3 vWorld;
      varying vec3 vViewDir;
      varying float vSoft;
      varying float vRock;
      varying float vViewDist;

      // --- 风险图案辅助函数（形状/纹理冗余编码，补色觉障碍可读性）
      float diagStripe(vec2 p, float spacing, float width) {
        float h = fract((p.x + p.y) / spacing);
        float w = fwidth(h) * 1.3;
        return 1.0 - smoothstep(width - w, width + w, abs(h - 0.5) * 2.0);
      }
      float crossHatch(vec2 p, float spacing, float width) {
        float h1 = fract((p.x + p.y) / spacing);
        float h2 = fract((p.x - p.y) / spacing);
        float w = fwidth(h1) * 1.2;
        float s1 = 1.0 - smoothstep(width - w, width + w, abs(h1 - 0.5) * 2.0);
        float s2 = 1.0 - smoothstep(width - w, width + w, abs(h2 - 0.5) * 2.0);
        return max(s1, s2);
      }
      float hashNoise(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      // --- 平滑 Value Noise：用 hashNoise 做双线性平滑插值，波长比地形丘陵大，
      //     专门用于 ramp 阈值抖动，把 cel-ramp 硬边量化产生的规则条纹拆成
      //     不规则斑块，同时避免高频 hash 的颗粒感。
      float smoothNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hashNoise(i);
        float b = hashNoise(i + vec2(1.0, 0.0));
        float c = hashNoise(i + vec2(0.0, 1.0));
        float d = hashNoise(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }

      // --- 地形专用软化 ramp：在 cel-ramp 档位边界做 1-texel 范围的三采样平均，
      //     并用低频 smoothNoise 抖动 ramp 采样坐标，把硬边量化在平缓地形上产生
      //     的规则明暗条纹拆成不规则自然斑块，同时保留像素中心处的赛璐珞硬边观感。
      //     此函数只用于地形，不影响车体/角色/地标。
      vec3 terrainRampShade(float ndl) {
        // 用高频 smoothNoise 抖动 ramp 采样坐标，把 cel-ramp 硬边量化在起伏地形上
        // 产生的规则明暗条纹拆成细碎不规则斑块。频率与地形丘陵错开（0.20 vs 0.03），
        // 避免同频叠加；±0.06 幅度约 4 texel，配合 7-texel 宽三采样模糊，保留微 cel
        // 感的同时让条带边缘彻底破碎。
        float jitter = (smoothNoise(vWorld.xz * 0.20 + vec2(7.3, 2.1)) - 0.5) * 0.12;
        float t = clamp(ndl * 0.5 + 0.5 + jitter, 0.0, 1.0);
        vec3 c = texture(uRamp, vec2(t, 0.5)).rgb;
        float texel = 7.0 / 64.0;
        vec3 cl = texture(uRamp, vec2(t - texel, 0.5)).rgb;
        vec3 cr = texture(uRamp, vec2(t + texel, 0.5)).rgb;
        float edge = abs(fract(t * 64.0) - 0.5) * 2.0; // 0=像素边界, 1=像素中心
        return mix((cl + c + cr) / 3.0, c, smoothstep(0.0, 0.55, edge));
      }

      // --- P5 地表危险图案：用形状冗余编码，补色觉障碍可读性。
      //     软沙危险=点阵；岩石危险=同心环；坡度危险=斜纹/交叉纹（见上）。三者图案互不重叠。
      float dotPattern(vec2 p, float spacing, float radius) {
        vec2 g = fract(p / spacing) - 0.5;
        float d = length(g);
        float w = fwidth(d) * 1.5;
        return 1.0 - smoothstep(radius - w, radius + w, d);
      }
      float ringPattern(vec2 p, float spacing, float radius) {
        vec2 g = fract(p / spacing) - 0.5;
        float d = length(g);
        float w = fwidth(d) * 1.5;
        return 1.0 - smoothstep(radius - w, radius + w, abs(d - radius * 0.55));
      }

      void main() {
        vec3 nrm = normalize(vNormal);
        float slopeDeg = degrees(acos(clamp(nrm.y, -1.0, 1.0)));

        // 视觉细节法线：**只用于光照与边缘光**，不参与 slopeDeg（坡度着色必须保持真实，
        // 否则学生会读到假的坡度色带）。几何与 heightfield 均不变 → 任务层零回归。
        vec3 shadeNrm = nrm;
        if (uDetail > 0.001) {
          vec2 dp = vWorld.xz * 1.8;
          float d0 = detailNoise(dp);
          float dx = detailNoise(dp + vec2(0.06, 0.0));
          float dz = detailNoise(dp + vec2(0.0, 0.06));
          shadeNrm = normalize(nrm + vec3((d0 - dx) * 6.0, 0.0, (d0 - dz) * 6.0) * uDetail);
        }

        // --- 探测置信度：没扫描过的地方，学生不该看到任何坡度读数
        float raw = 1.0;
        if (uKnowledgeOn > 0.5) {
          vec2 kuv = vWorld.xz / uBasinSize + 0.5;
          raw = texture2D(uKnowledge, clamp(kuv, 0.0, 1.0)).r;
        }
        float known = step(0.62, raw);          // 已探明
        float uncertain = step(0.20, raw) * (1.0 - known); // 扫描过但置信度低
        float unknown = 1.0 - step(0.20, raw);  // 完全未探测

        // --- 底色：地表成分。全部使用 step 硬切，杜绝渐变
        vec3 albedo = uSandFlat;
        // --- 岩石成团：低频率噪声把岩石聚成斑块，簇内阈值更低（大岩石多）、簇外维持高阈值
        //     （小碎石），制造参考图"多尺度成团散布"的火星散石感，并整体提升密度。
        float cluster = hashNoise(vWorld.xz * 0.05 + 3.0);
        float rockThresh = mix(0.70, 0.46, cluster);
        albedo = mix(albedo, uGravel, step(rockThresh - 0.16, vRock));
        albedo = mix(albedo, uRockOutcrop, step(rockThresh, vRock));
        albedo = mix(albedo, uDuneCrest, step(0.60, vSoft));

        // --- 风蚀波纹（R3 已移除）：R2 的 sin 连续波纹在浅色沙地上显成了规则条纹，
        //     反而破坏火星地表的自然感，因此整段移除。保留颗粒 noise 与岩石成团。

        // --- 基地前预置辙痕：主基地(-300,260)→rover 出生(-300,304)之间画两条平行轻车辙，
        //     让静态画面也有"来过车"的火星轨迹感（实时行驶辙痕仍由 RT mask 叠加在更上层）。
        float tz = clamp((vWorld.z - 258.0) / 48.0, 0.0, 1.0);
        float dxc = vWorld.x + 300.0;
        float rutA = 1.0 - smoothstep(0.9, 2.2, abs(dxc - 3.2));
        float rutB = 1.0 - smoothstep(0.9, 2.2, abs(dxc + 3.2));
        float trailMask = (rutA + rutB) * smoothstep(0.0, 0.06, tz) * (1.0 - smoothstep(0.94, 1.0, tz));
        albedo = mix(albedo, albedo * 0.68, trailMask * 0.55);

        // --- 散布裸岩：在岩石密度中等的区域，用噪声点出零星深色斑岩（火星地表散石感）。
        //     乘 known 保证未探测区不显示，与"学生看不见岩性"一致。阈值随 cluster 成团。
        float rockN = hashNoise(vWorld.xz * 0.9 + 17.0);
        float spotThresh = mix(0.86, 0.70, cluster);
        float rockSpot = step(spotThresh, rockN) * smoothstep(0.40, 0.55, vRock) * known;
        albedo = mix(albedo, uRockOutcrop * 0.82, rockSpot * 0.7);

        // --- 崖壁层理（P3-6，仅火星二号，设计 §2.4）
        //     外流河道的崖壁应露出水平岩层：既让崖壁"读得出层"，又给平顶一点变化不糊成一片。
        //     只在陡坡（崖壁）上生效，按**世界高度**切层，交替深浅；
        //     谷底往上 3 m 是最粗的砾石层（对应样本站 B 的"最底下那层最粗"）。
        //     uStrataStrength = 0（一号）时整段跳过，渲染结果与改动前逐像素一致。
        if (uStrataStrength > 0.001) {
          float cliffMask = smoothstep(10.0, 20.0, slopeDeg) * known;
          float band = floor(vWorld.y / 2.4);           // 单层厚 2.4 m
          float odd = mod(band, 2.0);                   // 深浅交替
          // 二号主河谷谷底 -30 m，往上 3 m 为粗砾层
          float gravelBand = 1.0 - smoothstep(-30.0, -27.0, vWorld.y);
          vec3 strataCol = mix(uStrataMid, uStrataDark, odd);
          strataCol = mix(strataCol, uStrataLight, gravelBand * 0.7);
          // 层内再加一点噪声，避免层界过于机械
          float layerJit = hashNoise(vWorld.xz * 0.35 + band * 7.0) * 0.08 - 0.04;
          albedo = mix(albedo, strataCol + layerJit, cliffMask * uStrataStrength);
          // 【已撤销 2026-09-11】谷底表面层理（第 7 条）：按 y<-6 全局染色会把二号
          // 大部分低地都涂成 strata 灰棕，revealAll 后整个画面灰紫（老大确认不是设计意图）。
          // "整段河床表面呈层理"的正确做法需要按 dRiver（距河道距离）限定，
          // 等河道 S 型改造（第 4 条）落了地形后再做。
        }

        // --- 教学色带 / 风险图案 / 软沙岩石分级：整段由 uHazardBands 控制。
        //     二号 = 0：只渲染地形本色（+等高线），不在地表涂色块；
        //     但规划器仍用真实坡度/软/岩判定，教学陷阱（R4 禁行）完整保留。
        if (uHazardBands > 0.5) {
          // --- 教学色带：坡度分档。边界严格等于规划器使用的阈值。
          //     乘 known：未探测区不显示分档，与规划器"看不见坡度"完全一致。
          albedo = mix(albedo, uSlopeCautionColor, step(uSlopeCaution, slopeDeg) * known);
          albedo = mix(albedo, uSlopeBlockedColor, step(uSlopeBlocked, slopeDeg) * known);

          // --- 风险图案冗余编码（A1）：谨慎/禁行不仅靠色相，还靠斜纹/交叉纹。
          //     色觉障碍学生仍能区分"要小心"与"不能走"。
          float isCaution = step(uSlopeCaution, slopeDeg) * (1.0 - step(uSlopeBlocked, slopeDeg)) * known;
          float isBlocked = step(uSlopeBlocked, slopeDeg) * known;
          if (isCaution > 0.001) {
            // 坡度谨慎：用细密高频噪声替代 45° 斜纹，避免低角度下形成规则条纹
            float s = hashNoise(vWorld.xz * 2.5 + 31.0) * 0.6 + hashNoise(vWorld.xz * 6.0 + 47.0) * 0.4;
            albedo = mix(albedo * 0.88, albedo, s);
          }
          if (isBlocked > 0.001) {
            // 坡度禁行：用更密的交叉噪声替代 crossHatch，保持"危险"质感但不显条纹
            float s1 = hashNoise(vWorld.xz * 3.0 + 51.0);
            float s2 = hashNoise(vWorld.xz * 3.0 + 73.0);
            float s = min(s1, s2) * 0.5 + 0.5;
            albedo = mix(albedo * 0.78, albedo, s);
          }

          // --- P5 地表危险叠加：软沙 / 岩石分级（颜色 + 图案双重编码）
          //     阈值取自 grid.ts（与实测陷车判定同源），乘 known 保证未探测区不显示，
          //     与"学生看不见软/岩属性"一致。这与上面的坡度色带是两套独立叠加，
          //     一个格可以同时是"陡坡+岩石"，两种图案叠在一起，信息不冲突。
          float softCaution = step(uSoftCaution, vSoft) * (1.0 - step(uSoftBlock, vSoft)) * known;
          float softBlock = step(uSoftBlock, vSoft) * known;
          float rockCaution = step(uRockCaution, vRock) * (1.0 - step(uRockBlock, vRock)) * known;
          float rockBlock = step(uRockBlock, vRock) * known;
          if (softCaution > 0.001) {
            // 软沙谨慎：稀疏点阵，暖黄
            float dp = dotPattern(vWorld.xz, 9.0, 0.22);
            albedo = mix(albedo, uSoftHazard, dp * 0.50);
          }
          if (softBlock > 0.001) {
            // 深软沙：密集点阵 + 整体压暗，暗示"会陷进去"
            float dp = dotPattern(vWorld.xz, 7.0, 0.30);
            albedo = mix(albedo, uSoftHazard, dp * 0.82);
            albedo *= mix(1.0, 0.82, softBlock * 0.6);
          }
          if (rockCaution > 0.001) {
            // 岩石谨慎：稀疏同心环，冷蓝灰
            float rp = ringPattern(vWorld.xz, 11.0, 0.46);
            albedo = mix(albedo, uRockHazard, rp * 0.48);
          }
          if (rockBlock > 0.001) {
            // 裸岩出露：密集同心环 + 压暗，暗示"硬障碍"
            float rp = ringPattern(vWorld.xz, 8.5, 0.46);
            albedo = mix(albedo, uRockHazard, rp * 0.80);
            albedo *= mix(1.0, 0.84, rockBlock * 0.5);
          }
        }

        // --- 等高线：让高差在俯视角下可读。用 fwidth 保持屏幕空间恒定线宽
        float hLine = vWorld.y / uContourSpacing;
        float f = fract(hLine);
        float w = fwidth(hLine) * 1.1;
        float line = 1.0 - smoothstep(0.0, max(w, 1e-4), min(f, 1.0 - f));
        albedo *= mix(1.0, 0.78, line * uContourStrength * max(known, 0.35));

        // --- 不确定带（A3）：0.20<=raw<0.62，扫描过但数据噪/不完整。
        //     旧版 45° 斜纹在低角度跟车视角下会形成规则明暗条纹；改用极细高频
        //     噪声做轻微亮度扰动，保留"这部分数据不完整"的图案冗余，但不再读成条纹。
        if (uncertain > 0.001 && uKnowledgeOn > 0.5) {
          float n = hashNoise(vWorld.xz * 1.5 + 5.0) * 0.6 + hashNoise(vWorld.xz * 3.5 + 13.0) * 0.4;
          vec3 uCol = albedo * 0.86 + vec3(0.03) * n;
          uCol *= mix(0.94, 1.06, n);
          albedo = mix(albedo, uCol, uncertain * 0.50);
        }

        // --- 完全未探测区：去色 + 极细高频噪声做轻微亮度扰动。
        //     旧版斜向硬边影线在低角度跟车视角下会被读成规则条纹；改为细密
        //     噪声后仍保留图案冗余（色觉障碍可读），但不再形成明显条纹。
        float unknownAmt = unknown * uKnowledgeOn;
        if (unknownAmt > 0.001) {
          float gray = dot(albedo, vec3(0.299, 0.587, 0.114));
          vec3 veil = mix(vec3(gray), uUnknownColor, 0.58);
          float n = hashNoise(vWorld.xz * 3.0 + 11.0) * 0.6 + hashNoise(vWorld.xz * 6.0 + 23.0) * 0.4;
          veil *= mix(0.96, 1.04, n);
          albedo = mix(albedo, veil, unknownAmt);
        }

        // --- 教学网格（A2）：24×16 大格叠加在已探明区，帮助学生把连续地形
        //     对应到"我标记的这一格"的离散决策单元上。
        {
          vec2 gridF = fract(vWorld.xz / vec2(50.0, 75.0) + 0.5);
          vec2 fw = fwidth(gridF) * 1.1;
          vec2 gridLine = smoothstep(vec2(0.0), fw, gridF) * (1.0 - smoothstep(vec2(1.0) - fw, vec2(1.0), gridF));
          float gridMask = (1.0 - gridLine.x) + (1.0 - gridLine.y);
          albedo = mix(albedo, uGridColor, clamp(gridMask, 0.0, 1.0) * 0.10 * known);
        }

        // --- M6 车辙：R-7 实际压出的辙痕。
        //     刻意画在未探测雾纱**之后**：那是车亲身走过的地方，
        //     无论有没有轨道扫描数据，学生都该看得见"我走过这里"。
        if (uTracksOn > 0.5) {
          vec2 tuv = clamp(vWorld.xz / uBasinSize + 0.5, 0.0, 1.0);
          float tr = texture2D(uTracks, tuv).r;
          float rut = smoothstep(0.28, 0.72, tr);
          if (rut > 0.001) {
            // 压实的辙底：大幅压暗并偏冷，形成"槽"
            vec3 rutCol = mix(albedo * 0.48, uUnknownColor, 0.22);
            albedo = mix(albedo, rutCol, rut * 0.94);

            // 被轮胎推到两侧的沙埂：提亮成迎光的松沙
            float berm = smoothstep(0.04, 0.22, tr) * (1.0 - smoothstep(0.28, 0.55, tr));
            albedo = mix(albedo, uDuneCrest, berm * 0.55);

            // 轮胎花纹：两道平行细线，增强"车走过"的读图线索
            float lane = abs(fract((vWorld.x - vWorld.z) * 1.35) - 0.5) * 2.0;
            float tread = step(0.78, lane) * rut;
            albedo = mix(albedo, albedo * 0.62, tread * 0.45);
          }
        }

        // --- M6 地表闪光：随机分布的小石英/云母反光点，按时间闪烁，增加沙地质感
        {
          float sx = fract(sin(vWorld.x * 73.3 + vWorld.z * 17.7) * 43758.5453);
          float sz = fract(sin(vWorld.z * 53.1 - vWorld.x * 29.3) * 12345.6789);
          float spark = step(0.978, sx) * step(0.35, sz) * step(0.42, vSoft);
          // 只在已探明沙地上闪烁，未探测区保持雾纱一致性
          spark *= known;
          // 量化闪烁：不用平滑 sin，而是 0/0.5/1 三档硬切，读出"动画片里的光闪"
          float wave = sin(uTime * 2.5 + sx * 6.2831);
          float twinkle = wave > 0.55 ? 1.0 : (wave > -0.35 ? 0.5 : 0.0);
          albedo = mix(albedo, uSparkleColor, spark * twinkle * 0.38);
        }

        // --- 量化光照（地形专用软化 ramp，避免平缓地表出现规则明暗条纹）
        float ndl = dot(shadeNrm, normalize(uSunDir));
        vec3 color = albedo * terrainRampShade(ndl);

        // --- 数据边界高亮：让"已探明到哪儿为止"一眼可见
        float bEdge = step(0.30, raw) * (1.0 - step(0.72, raw)) * uKnowledgeOn;
        color = mix(color, uScanEdgeColor, bEdge * 0.42);

        // --- 边缘光：让逆光剪影和坑缘轮廓更清晰，模拟赛璐珞的"描边感"
        float rim = pow(1.0 - max(0.0, dot(shadeNrm, vViewDir)), 3.0);
        color = mix(color, vec3(1.0, 0.92, 0.86), rim * 0.18);

        // --- 距离尘霭：给纵深，同时掩盖远处低 LOD
        float fogT = smoothstep(uFogRange.x, uFogRange.y, vViewDist);
        color = mix(color, uHaze, fogT * 0.82);

        gl_FragColor = vec4(color, 1.0);
        #include <colorspace_fragment>
      }
    `,
  })
}

export function createTerrainRenderer(field: HeightField, ramp: Texture, worldIndex = 0): TerrainRenderer {
  const group = new Group()
  group.name = 'MarsTerrain'
  const material = createTerrainMaterial(ramp, worldIndex)

  type ChunkEntry = {
    mesh: Mesh
    centerX: number
    centerZ: number
    lod: number
    geometries: Array<BufferGeometry | null>
  }

  /** LOD 下限（0 最细 … 3 最粗）。低端机设成 2，避免近处也铺满最细网格。 */
  let minLod = 0

  const chunks: ChunkEntry[] = []
  const chunkWorld = BASIN_SIZE / CHUNKS

  for (let cz = 0; cz < CHUNKS; cz += 1) {
    for (let cx = 0; cx < CHUNKS; cx += 1) {
      const geometries: Array<BufferGeometry | null> = [null, null, null, null]
      // 预建最粗的一档，保证首帧就有完整地形；细档按需惰性构建
      geometries[3] = buildChunkGeometry(field, cx, cz, LOD_STRIDES[3])
      const mesh = new Mesh(geometries[3], material)
      mesh.name = `chunk-${cx}-${cz}`
      mesh.frustumCulled = true
      group.add(mesh)
      chunks.push({
        mesh,
        centerX: -HALF + (cx + 0.5) * chunkWorld,
        centerZ: -HALF + (cz + 0.5) * chunkWorld,
        lod: 3,
        geometries,
      })
    }
  }

  const pickLod = (dist: number, current: number): number => {
    // 带迟滞：升档（变细）要更近，降档（变粗）要更远
    for (let l = 0; l < LOD_DISTANCES.length; l += 1) {
      const edge = LOD_DISTANCES[l] + (current <= l ? LOD_HYSTERESIS : -LOD_HYSTERESIS)
      if (dist < edge) return l
    }
    return LOD_DISTANCES.length
  }

  const updateLod = (focusX: number, focusZ: number) => {
    for (let k = 0; k < chunks.length; k += 1) {
      const chunk = chunks[k]
      const dist = Math.hypot(chunk.centerX - focusX, chunk.centerZ - focusZ)
      const lod = Math.max(pickLod(dist, chunk.lod), minLod)
      if (lod === chunk.lod) continue
      let geo = chunk.geometries[lod]
      if (!geo) {
        const cx = Math.round((chunk.centerX + HALF - chunkWorld / 2) / chunkWorld)
        const cz = Math.round((chunk.centerZ + HALF - chunkWorld / 2) / chunkWorld)
        geo = buildChunkGeometry(field, cx, cz, LOD_STRIDES[lod])
        chunk.geometries[lod] = geo
      }
      chunk.mesh.geometry = geo
      chunk.lod = lod
    }
  }

  const getTriangleCount = () => {
    let tris = 0
    for (let k = 0; k < chunks.length; k += 1) {
      const index = chunks[k].mesh.geometry.getIndex()
      if (index) tris += index.count / 3
    }
    return tris
  }

  const dispose = () => {
    for (const chunk of chunks) {
      for (const geo of chunk.geometries) geo?.dispose()
      group.remove(chunk.mesh)
    }
    chunks.length = 0
    material.dispose()
  }

  return {
    group,
    material,
    updateLod,
    setThresholds: ({ slopeCaution, slopeBlocked }) => {
      material.uniforms.uSlopeCaution.value = slopeCaution
      material.uniforms.uSlopeBlocked.value = slopeBlocked
    },
    setKnowledgeTexture: (texture) => {
      material.uniforms.uKnowledge.value = texture
      material.uniforms.uKnowledgeOn.value = texture ? 1 : 0
    },
    setTrackMask: (texture) => {
      material.uniforms.uTracks.value = texture
      material.uniforms.uTracksOn.value = texture ? 1 : 0
    },
    setTrackLod: (scale) => {
      // 低画质：把车辙纹理整体缩小采样，淡化远处摩尔纹
      const s = material.uniforms.uTracks.value
      if (s) {
        s.minFilter = scale < 0.75 ? NearestFilter : LinearFilter
        s.magFilter = scale < 0.75 ? NearestFilter : LinearFilter
      }
    },
    setMinLod: (l) => {
      minLod = Math.max(0, Math.min(LOD_STRIDES.length, l))
    },
    setTime: (t) => {
      material.uniforms.uTime.value = t
    },
    getTriangleCount,
    dispose,
  }
}
