/**
 * 赛璐珞材质与反向外壳描边。
 *
 * 这是 M3 描边管线的核心。所有载具/角色/道具都使用同一套量化光照 + 同一套墨线，
 * 以保证整张画面"像同一部动画"。材质逻辑与 `terrainMesh.ts` 的 ramp 完全一致——
 * 共享 `RAMP_GLSL`，所以车体明暗和地表明暗是同一种语言。
 */
import {
  BackSide,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Matrix3,
  Matrix4,
  Mesh,
  type Object3D,
  PlaneGeometry,
  ShaderMaterial,
  type Texture,
  Vector3,
} from 'three'
import { PALETTE, SUN_DIRECTION, hexToLinearRgb, sunDirectionFor } from './palette'
import { NO_EDGE_LAYER } from './postfx'
import { RAMP_GLSL } from './ramp'

/** 反过来把 sRGB 的墨线色转成线性，避免描边发灰。 */
const INK_RGB = hexToLinearRgb(PALETTE.ink)
const INK_COLOR = new Color(INK_RGB[0], INK_RGB[1], INK_RGB[2])

/** 硬边高光参数。color 默认白；strength 0 表示无高光；shininess 越大反光圆盘越小越锐。 */
export type CelSpecular = {
  color?: string
  strength: number
  shininess: number
}

/** createCelMaterial 的可选参数。 */
export type CelMaterialOptions = {
  /** 自发光强度（0..1+），屏幕/灯等"自己会亮"的部件用。 */
  emissive?: number
  /** 硬边高光（卡通金属/玻璃反光）。不传则无高光。 */
  specular?: CelSpecular
}

/**
 * 任意几何体的赛璐珞材质。
 * @param hex 底色（sRGB 字面量，内部转线性）
 * @param ramp ramp 量化贴图（与地形共用，保证光影语言一致）
 * @param opts 可选：自发光 / 硬边高光。两者缺省都不改变原有观感。
 */
export function createCelMaterial(hex: string, ramp: Texture, opts: CelMaterialOptions = {}): ShaderMaterial {
  const [r, g, b] = hexToLinearRgb(hex)
  // 轮廓光取冷白，与暖沙做冷暖对冲，是卡通"边缘发光"的来源
  const rim = hexToLinearRgb('#cfe6ff')
  const spec = opts.specular
  const specRgb = spec?.color ? hexToLinearRgb(spec.color) : [1, 1, 1]
  return new ShaderMaterial({
    // 标记为「赛璐珞受光材质」：`applySunDirection()` 凭此标记统一改写 uSunDir，
    // 无需给每个资产工厂（rover/hauler/kibo/landmarks…）逐层透传 worldIndex 参数。
    userData: { celSun: true },
    uniforms: {
      uRamp: { value: ramp },
      uColor: { value: new Color(r, g, b) },
      uSunDir: {
        value: new Vector3(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z).normalize(),
      },
      // 自发光强度：用于屏幕/灯这类"自己会亮"的部件
      uEmissive: { value: opts.emissive ?? 0 },
      uRimColor: { value: new Color(rim[0], rim[1], rim[2]) },
      // 菲涅尔轮廓光：让探测车 / KIBO 的剪影从地形里跳出来。提示词二.4 要求。
      uRimStrength: { value: 0.85 },
      // 硬边高光（默认强度 0 = 关闭，只有显式传入 specular 的部件才会有反光）
      uSpecularColor: { value: new Color(specRgb[0], specRgb[1], specRgb[2]) },
      uShininess: { value: spec?.shininess ?? 32 },
      uSpecularStrength: { value: spec?.strength ?? 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec3 vWorldPos;
      void main() {
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      ${RAMP_GLSL}
      uniform vec3 uColor;
      uniform vec3 uSunDir;
      uniform float uEmissive;
      uniform vec3 uRimColor;
      uniform float uRimStrength;
      uniform vec3 uSpecularColor;
      uniform float uShininess;
      uniform float uSpecularStrength;
      varying vec3 vNormalW;
      varying vec3 vWorldPos;
      void main() {
        vec3 nrm = normalize(vNormalW);
        float ndl = dot(nrm, normalize(uSunDir));
        vec3 shaded = uColor * rampShade(ndl);
        // 自发光部件：直接提亮 + 轻微外溢，不参与量化
        shaded = mix(shaded, uColor * 1.25, uEmissive);
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        // 菲涅尔轮廓光：仅掠射角出现，量化成硬边，强化卡通"描边光"
        float fres = pow(1.0 - max(dot(nrm, viewDir), 0.0), 3.0);
        // 量化：fres 只取高中两档，避免柔和过渡
        float rimMask = fres > 0.45 ? 1.0 : (fres > 0.22 ? 0.5 : 0.0);
        shaded += uRimColor * rimMask * uRimStrength;
        // 硬边高光（卡通金属/玻璃反光）：Blinn-Phong 半程向量 + step 量化成硬圆盘，
        // 只在受光面出现，强化"金属/玻璃被太阳打亮"的质感，且不破坏 cel 的硬边观感。
        vec3 halfVec = normalize(uSunDir + viewDir);
        float ndh = max(dot(nrm, halfVec), 0.0);
        float spec = pow(ndh, uShininess);
        float specMask = step(0.5, spec) * smoothstep(-0.04, 0.12, ndl);
        shaded += uSpecularColor * specMask * uSpecularStrength;
        gl_FragColor = vec4(shaded, 1.0);
        #include <colorspace_fragment>
      }
    `,
  })
}

/**
 * 反向外壳描边材质：沿视图空间法线把背面推开，形成恒定屏幕宽度的墨线。
 * 用 BackSide 渲染，所以只露出轮廓。
 */
function createOutlineMaterial(thickness: number): ShaderMaterial {
  return new ShaderMaterial({
    side: BackSide,
    uniforms: {
      uColor: { value: INK_COLOR },
      uThickness: { value: thickness },
    },
    vertexShader: /* glsl */ `
      uniform float uThickness;
      void main() {
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        // 视图空间法线（近似，用 modelView 的法线矩阵）
        vec3 nView = normalize(normalMatrix * normal);
        // 在裁剪空间沿法线方向推，乘 clip.w 以抵消透视收缩 -> 屏幕宽度大致恒定
        clip.xy += nView.xy * uThickness * clip.w * 0.01;
        gl_Position = clip;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uColor;
      void main() {
        gl_FragColor = vec4(uColor, 1.0);
        #include <colorspace_fragment>
      }
    `,
  })
}

/**
 * 给一个网格添加反向外壳描边。返回新建的描边网格（已挂到同一父节点之前由调用方处理）。
 * 默认厚度 1.2（屏幕空间单位，配合 0.01 系数约等于 1.2px @ 1000px 视口）。
 */
export function makeOutline(mesh: Mesh, thickness = 1.2): Mesh {
  const outline = new (mesh.constructor as typeof Mesh)(mesh.geometry, createOutlineMaterial(thickness))
  outline.name = `${mesh.name || 'mesh'}__outline`
  outline.castShadow = false
  outline.receiveShadow = false
  outline.frustumCulled = mesh.frustumCulled
  // 与本体完全同步变换
  outline.position.copy(mesh.position)
  outline.quaternion.copy(mesh.quaternion)
  outline.scale.copy(mesh.scale)
  outline.renderOrder = (mesh.renderOrder || 0) - 1
  // 外壳描边副本与本体几何完全重合，若参与屏幕空间 Sobel 的法线/深度趟会
  // 造成 z-fighting 噪点，直接挪到"不产生墨线"图层。
  outline.layers.set(NO_EDGE_LAYER)
  return outline
}

/** 把一个 Mesh 标记为“不参与描边”，用于螺丝、纹饰、内部小件等细节。 */
export function noOutline<T extends Mesh>(mesh: T): T {
  mesh.userData.outline = false
  return mesh
}

/** 描边规则选项。 */
export type OutlineOptions = {
  /**
   * 描边粗细（屏幕空间单位）。
   * 传数字表示所有 Mesh 统一粗细；传函数则按每个 Mesh 的局部包围球半径
   * 动态计算，实现"小车细线、大车粗线"的比例感。
   */
  thickness?: number | ((localRadius: number) => number)
  /** 跳过局部包围球半径小于此值的小零件（按 mesh.scale 折算后的本地单位）。
   *  用于抑制“每个螺丝都描边”的噪点。 */
  skipSmall?: number
  /** 显式尊重 mesh.userData.outline === false（主美可据此精确屏蔽内部细节）。 */
  respectUserData?: boolean
}

function meshLocalRadius(mesh: Mesh): number {
  const geo = mesh.geometry
  if (!geo || !geo.boundingSphere) geo.computeBoundingSphere()
  const r = geo.boundingSphere?.radius ?? 0
  const s = mesh.scale
  return r * Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z))
}

/**
 * 递归遍历对象树，为符合规则的 Mesh 生成描边副本并作为同级子节点加入。
 * 规则优先级：
 * 1. mesh.userData.outline === false 的零件不描边（精确控制内部细节）。
 * 2. 局部半径小于 skipSmall 的零件不描边（批量过滤螺丝/小窗/纹饰）。
 * 3. 其余按给定粗细描边。
 *
 * 这样描边只保留“整体外轮廓”与“主要结构件”，避免每个组成部分都被黑线切割。
 */
export function addOutlines(root: Object3D, options: number | OutlineOptions = 0.7): void {
  const opts: OutlineOptions = typeof options === 'number' ? { thickness: options } : options
  const baseThickness = opts.thickness ?? 0.7
  const skipSmall = opts.skipSmall ?? 0
  const respectUserData = opts.respectUserData ?? true

  const meshes: Mesh[] = []
  root.traverse((o) => {
    const m = o as Mesh
    if (!m.isMesh) return
    if (respectUserData && m.userData.outline === false) return
    if (skipSmall > 0 && meshLocalRadius(m) < skipSmall) return
    meshes.push(m)
  })
  for (const m of meshes) {
    const r = meshLocalRadius(m)
    const thickness = typeof baseThickness === 'function' ? baseThickness(r) : baseThickness
    const outline = makeOutline(m, thickness)
    m.parent?.add(outline)
  }
}

/**
 * 为整个模型生成**单一整体外部轮廓**描边。
 *
 * 与 `addOutlines` 不同：后者给每个符合条件的 Mesh 单独包一圈墨线，零件交界处
 * 会出现内部黑线，让模型看起来“黑糊糊”。`addSilhouetteOutline` 把所有可见零件
 * 的几何合并成一份，再生成一个 BackSide 外壳，因此只保留最外层轮廓，彻底消除
 * 零件之间的内部描边。
 *
 * 描边粗细仍支持数字或函数；函数接收的是合并后整体包围球半径。
 */
export function addSilhouetteOutline(root: Object3D, options: number | OutlineOptions = 0.7): void {
  const opts: OutlineOptions = typeof options === 'number' ? { thickness: options } : options
  const baseThickness = opts.thickness ?? 0.7
  const skipSmall = opts.skipSmall ?? 0
  const respectUserData = opts.respectUserData ?? true

  root.updateMatrixWorld(true)
  const rootInv = root.matrixWorld.clone().invert()

  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  let offset = 0

  const v = new Vector3()
  const n = new Vector3()
  const normalMatrix = new Matrix3()
  const matrix = new Matrix4()

  root.traverse((o) => {
    const m = o as Mesh
    if (!m.isMesh) return
    if (respectUserData && m.userData.outline === false) return
    if (skipSmall > 0 && meshLocalRadius(m) < skipSmall) return

    const geo = m.geometry
    if (!geo) return
    const posAttr = geo.attributes.position
    const normAttr = geo.attributes.normal
    if (!posAttr) return

    matrix.copy(m.matrixWorld).multiply(rootInv)
    normalMatrix.getNormalMatrix(matrix)

    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i)
      v.applyMatrix4(matrix)
      positions.push(v.x, v.y, v.z)

      if (normAttr) {
        n.fromBufferAttribute(normAttr, i)
        n.applyMatrix3(normalMatrix)
        normals.push(n.x, n.y, n.z)
      }
    }

    const indexAttr = geo.index
    if (indexAttr) {
      for (let i = 0; i < indexAttr.count; i++) {
        indices.push(indexAttr.getX(i) + offset)
      }
    } else {
      for (let i = 0; i < posAttr.count; i++) {
        indices.push(i + offset)
      }
    }
    offset += posAttr.count
  })

  if (positions.length === 0) return

  const merged = new BufferGeometry()
  merged.setAttribute('position', new Float32BufferAttribute(new Float32Array(positions), 3))
  if (normals.length > 0) {
    merged.setAttribute('normal', new Float32BufferAttribute(new Float32Array(normals), 3))
  }
  merged.setIndex(indices)
  merged.computeBoundingSphere()

  const r = merged.boundingSphere?.radius ?? 0
  const thickness = typeof baseThickness === 'function' ? baseThickness(r) : baseThickness

  const outline = new Mesh(merged, createOutlineMaterial(thickness))
  outline.name = `${root.name || 'model'}__silhouette`
  outline.userData.outline = false
  outline.castShadow = false
  outline.receiveShadow = false
  outline.frustumCulled = root.frustumCulled ?? true
  outline.renderOrder = -1000
  outline.layers.set(NO_EDGE_LAYER)
  root.add(outline)
}

/**
 * 接触阴影（blob shadow）：贴地、不依赖实时阴影贴图、确定性、且不参与 Sobel 墨线。
 *
 * 为什么不用实时阴影：
 *  - 本任务所有网格 `castShadow=receiveShadow=false`，赛璐珞自定义材质也不接收 shadow map，
 *     真阴影需要重做材质 + shadow pass，代价大且会引入逐帧依赖（与确定性 #3 相悖风险）；
 *  - 卡通渲染里"一团软软的接地影"比锐利阴影更像动画，blob 是业界标准做法。
 *
 * 为什么放 NO_EDGE_LAYER：后处理的几何缓冲趟只用 layer 0，blob（layer 1）不会进入
 * 法线/深度趟，于是合成 Sobel 不会在影子边缘勾出一圈墨线，保持"地面上的柔和暗斑"。
 *
 * 调用方把它作为子节点加到车体/采集车 group 上即可，位置由调用方微调到接地高度。
 */
export function createBlobShadow(options: { radius?: number; strength?: number; color?: string } = {}): Mesh {
  const radius = options.radius ?? 1.4
  const strength = options.strength ?? 0.45
  const [sr, sg, sb] = options.color ? hexToLinearRgb(options.color) : hexToLinearRgb(PALETTE.shadowTint)
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: new Color(sr, sg, sb) },
      uStrength: { value: strength },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uColor;
      uniform float uStrength;
      varying vec2 vUv;
      void main() {
        float d = distance(vUv, vec2(0.5));
        // 中心最浓、边缘平滑归零，形成柔和接地影
        float a = smoothstep(0.5, 0.05, d) * uStrength;
        if (a <= 0.002) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  })
  const mesh = new Mesh(new PlaneGeometry(radius * 2, radius * 2), material)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = 0
  mesh.renderOrder = -2
  mesh.frustumCulled = false
  // 关键：不参与几何缓冲趟，避免被 Sobel 勾边
  mesh.layers.set(NO_EDGE_LAYER)
  mesh.name = 'blobShadow'
  mesh.userData.outline = false
  return mesh
}

/**
 * 统一改写整棵场景树里所有赛璐珞材质的主光方向。
 *
 * **为什么用遍历而不是给每个工厂函数加 `worldIndex` 参数**：
 * `createCelMaterial` 有十多处调用点，分散在 rover / hauler / kibo / landmarks 等
 * 独立模块中。逐层透传 worldIndex 要改六七个文件的函数签名，改动面大、回归风险高。
 * 改为给材质打 `userData.celSun` 标记、由本函数统一注入——一处生效、零签名改动。
 *
 * **一号零回归**：`sunDirectionFor(0)` 返回的就是 `SUN_DIRECTION` 原值，
 * 因此对一号调用本函数**不改变任何观感**。
 *
 * @param root 场景树根（通常是 stage 的 world Group）
 * @param worldIndex 地图索引：0 = 火星一号（正午），1 = 火星二号（黄昏低角度）
 */
/**
 * 按地图注入**光环境参数**：主光方向 + 菲涅尔轮廓光（rim）强度。
 *
 * @param root 场景树根（通常是 stage 的 world Group）
 * @param worldIndex 地图索引：0 = 火星一号（正午），1 = 火星二号（黄昏低角度）
 */
export function applySunDirection(root: Object3D, worldIndex: number): void {
  const sun = sunDirectionFor(worldIndex)
  // P2-4：轮廓光随光环境一起调。rim 取冷白（#cfe6ff），在二号的暖橙黄昏天空下
  // 对比过强会让边缘"发灰"、糊进天空（主美 R1 风险点），故略降到 0.62。
  // 一号保持 0.85 不变（零回归）。
  const rimStrength = worldIndex === 1 ? 0.62 : 0.85
  root.traverse((obj) => {
    const mesh = obj as Mesh
    if (!mesh.isMesh) return
    const mat = mesh.material as ShaderMaterial | undefined
    if (!mat || mat.userData?.celSun !== true) return
    const uniform = mat.uniforms?.uSunDir
    if (uniform) {
      const v = uniform.value as Vector3
      v.set(sun.x, sun.y, sun.z).normalize()
    }
    const rimU = mat.uniforms?.uRimStrength
    if (rimU) rimU.value = rimStrength
  })
}
