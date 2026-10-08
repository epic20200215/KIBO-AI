/**
 * 屏幕空间 Sobel 描边后处理（提示词二.3 强制项）。
 *
 * 为什么还需要它：反向外壳（`celMaterial.makeOutline`）只能画"外轮廓"，
 * 画不出**内部结构线**——地形山脊的折角、车体与地面的接触缝、岩石之间的
 * 前后遮挡关系，全都没有墨线，画面就会糊成一坨同色块。真正的赛璐珞动画里
 * 这些线是画师一根根勾的；在实时渲染里对应的做法就是屏幕空间边缘检测。
 *
 * 管线（两趟几何 + 一趟合成）：
 *  1. **几何缓冲趟**：`scene.overrideMaterial` 换成法线/深度材质，把
 *     view-space 法线写进 RGB、线性视深度（归一化到 far）写进 A。
 *     所有"不该产生墨线"的东西（天穹、尘霭、粒子、扫描波、丝带、外壳描边副本）
 *     统一放在 **layer 1**，这一趟把相机切到 `layers.set(0)` 直接跳过，
 *     零遍历开销。
 *  2. **主渲染趟**：正常渲染到 HalfFloat 颜色 RT（线性空间，避免 8bit 暗部断层）。
 *  3. **合成趟**：全屏三角上做 3×3 Sobel，法线差与深度差取大者，
 *     再**硬阈值量化成两档墨线**（不是柔和渐变——柔和渐变会立刻把画面
 *     拉回"3D 渲染"的观感，赛璐珞要的是硬边）。
 *
 * 画质分级：high 走法线+深度双通道；medium 只留深度（省一半 Sobel 权重计算，
 * 且不会在低 LOD 地形上抖）；low 整个后处理关掉，直接渲染到屏幕。
 *
 * 颜色空间：主渲染趟输出到 RT 时 three 的 `<colorspace_fragment>` 是 no-op
 * （工作空间＝线性），所以 RT 里存的是线性值；合成趟渲染到默认帧缓冲，
 * 由合成着色器里的 `<colorspace_fragment>` 统一做一次线性→sRGB。
 */
import {
  Color,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NoColorSpace,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type Object3D,
  type PerspectiveCamera,
  type WebGLRenderer,
} from 'three'
import { PALETTE, hexToLinearRgb } from './palette'

/** 完全不参与几何缓冲趟的对象所在图层。相机在几何趟不渲染这一层。 */
export const NO_EDGE_LAYER = 1

/**
 * 会写进几何缓冲、但**法线恒定**的图层：用于"要保留深度，但不要 Sobel 勾内部线"的对象。
 *
 * 为什么需要它（2026-09-03 修透明 bug）：
 * 之前把矿石/样本站/主基地/NPC/火星车/采集车整组挪到 `NO_EDGE_LAYER`（完全不进几何缓冲），
 * 结果合成趟拿到的那些像素深度是**被它们挡住的远景深度**。平视时远景归一化深度可达
 * 0.1~0.3，超过 `uHazeStart=0.05`，于是大气透视把建筑颜色向尘霭色混合最多 85%，
 * 看起来像"建筑变透明、能看穿到背后的远景"。
 *
 * 这一层的对象照常写真实深度（haze 与遮挡都正确），但法线输出恒定值，
 * 于是 Sobel 的**法线**通道在它们内部处处相同 → 不勾内部线；
 * 而**深度**通道仍有跳变 → 对象与背景的轮廓照常被勾出来。
 */
export const NO_SOBEL_LAYER = 2

/** 把一棵子树整体挪到指定图层（layers 是逐对象判定的，必须递归）。 */
export function setLayerRecursive(root: Object3D, layer: number): void {
  root.traverse((o) => o.layers.set(layer))
}

export type PostFXQuality = 'high' | 'medium' | 'low'

export type PostFX = {
  /** 代替 `renderer.render(scene, camera)`。关闭时行为完全等价于直接渲染。 */
  render: (scene: Scene, camera: PerspectiveCamera) => void
  setSize: (width: number, height: number) => void
  setQuality: (level: PostFXQuality) => void
  /** 当前是否真的走了后处理（供调试/截图工装断言）。 */
  isActive: () => boolean
  dispose: () => void
}

const INK = hexToLinearRgb(PALETTE.ink)
const HAZE = hexToLinearRgb(PALETTE.hazeColor)

function createNormalDepthMaterial(cameraFar: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uCameraFar: { value: cameraFar },
    },
    vertexShader: /* glsl */ `
      #include <common>
      varying vec3 vViewNormal;
      varying float vViewDepth;
      void main() {
        #include <beginnormal_vertex>
        #include <defaultnormal_vertex>
        #include <begin_vertex>
        #include <project_vertex>
        vViewNormal = normalize(transformedNormal);
        vViewDepth = -mvPosition.z;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uCameraFar;
      varying vec3 vViewNormal;
      varying float vViewDepth;
      void main() {
        // RGB = 视空间法线（[-1,1] → [0,1]），A = 归一化线性视深度
        vec3 n = normalize(vViewNormal) * 0.5 + 0.5;
        gl_FragColor = vec4(n, clamp(vViewDepth / uCameraFar, 0.0, 1.0));
      }
    `,
  })
}

/**
 * 与 createNormalDepthMaterial 配套：深度照常写，但法线输出恒定值。
 * 用在 `NO_SOBEL_LAYER`（= 2）的对象上——它们的"法线 Sobel 差"为 0，深度仍真实。
 */
function createFlatNormalDepthMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {},
    vertexShader: /* glsl */ `
      #include <common>
      varying float vViewDepth;
      void main() {
        #include <begin_vertex>
        #include <project_vertex>
        vViewDepth = -mvPosition.z;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying float vViewDepth;
      void main() {
        // 恒定法线 (0,0,1) 编码到 [0,1]：Sobel 法线通道无差异，
        // 但深度仍来自真实位置 → 大气透视与遮挡都正确。
        vec3 n = vec3(0.5, 0.5, 1.0);
        gl_FragColor = vec4(n, clamp(vViewDepth, 0.0, 1.0));
      }
    `,
  })
}

function createComposeMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      tColor: { value: null },
      tGeom: { value: null },
      uTexel: { value: new Vector2(1 / 1280, 1 / 720) },
      uInk: { value: new Color(INK[0], INK[1], INK[2]) },
      /** 墨线随深度变化：近景粗、远景细（业界称 Truck Factor / depth-mask width）。
       *  行业共识用"深度/Z"驱动，不用 facing ratio（角度驱动会发飘、不规则）。 */
      uThicknessNear: { value: 1.0 },
      /** 远景（c.a ≥ uThicknessRange）的墨线采样半径（像素）。 */
      uThicknessFar: { value: 0.5 },
      /** 归一化线性视深达到该值即完成"近→远"过渡（0.05 × far ≈ 150m @far3000）。 */
      uThicknessRange: { value: 0.05 },
      /** 法线差权重。0 = 只用深度（medium 画质）。 */
      uNormalScale: { value: 1.0 },
      /** 深度差权重。 */
      uDepthScale: { value: 1.0 },
      /** 墨线不透明度上限，避免近景黑得发死。 */
      uInkStrength: { value: 0.9 },
      /** 大气透视（火星尘霭）：远景向该色偏移，制造纵深。走线性空间。 */
      uHaze: { value: new Color(HAZE[0], HAZE[1], HAZE[2]) },
      /** 尘霭起始/结束的归一化视深（0.05×far≈150m，0.28×far≈840m）。 */
      uHazeStart: { value: 0.05 },
      uHazeEnd: { value: 0.28 },
      /** 尘霭强度上限，避免远景点被完全糊成单色。 */
      uHazeStrength: { value: 0.85 },
    },
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D tColor;
      uniform sampler2D tGeom;
      uniform vec2 uTexel;
      uniform vec3 uInk;
      uniform float uThicknessNear;
      uniform float uThicknessFar;
      uniform float uThicknessRange;
      uniform float uNormalScale;
      uniform float uDepthScale;
      uniform float uInkStrength;
      uniform vec3 uHaze;
      uniform float uHazeStart;
      uniform float uHazeEnd;
      uniform float uHazeStrength;
      varying vec2 vUv;

      vec4 tap(vec2 off, float t) {
        return texture2D(tGeom, vUv + off * uTexel * t);
      }

      void main() {
        vec3 col = texture2D(tColor, vUv).rgb;

        vec4 c  = tap(vec2( 0.0,  0.0), 1.0);
        // 以中心像素的归一化视深驱动墨线粗细：近景（c.a 小）粗、远景（c.a 大）细。
        // 这是赛璐珞后处理描边的标准做法（Truck Factor / depth-mask width）。
        float t = mix(uThicknessNear, uThicknessFar, smoothstep(0.0, uThicknessRange, c.a));
        vec4 tl = tap(vec2(-1.0,  1.0), t);
        vec4 tc = tap(vec2( 0.0,  1.0), t);
        vec4 tr = tap(vec2( 1.0,  1.0), t);
        vec4 ml = tap(vec2(-1.0,  0.0), t);
        vec4 mr = tap(vec2( 1.0,  0.0), t);
        vec4 bl = tap(vec2(-1.0, -1.0), t);
        vec4 bc = tap(vec2( 0.0, -1.0), t);
        vec4 br = tap(vec2( 1.0, -1.0), t);

        // --- Sobel（深度通道）。用相对差，保证远近墨线粗细观感一致
        float gxD = (tl.a + 2.0 * ml.a + bl.a) - (tr.a + 2.0 * mr.a + br.a);
        float gyD = (tl.a + 2.0 * tc.a + tr.a) - (bl.a + 2.0 * bc.a + br.a);
        float depthEdge = length(vec2(gxD, gyD)) / max(c.a, 0.0015);

        // --- Sobel（法线通道）。三分量各做一次，取长度
        vec3 gxN = (tl.rgb + 2.0 * ml.rgb + bl.rgb) - (tr.rgb + 2.0 * mr.rgb + br.rgb);
        vec3 gyN = (tl.rgb + 2.0 * tc.rgb + tr.rgb) - (bl.rgb + 2.0 * bc.rgb + br.rgb);
        float normalEdge = length(gxN) + length(gyN);

        float e = max(depthEdge * uDepthScale, normalEdge * uNormalScale);

        // 远处 LOD 会让法线抖动，墨线跟着闪；450m 之后线性淡出（far = 3000）
        float fade = 1.0 - smoothstep(0.14, 0.30, c.a);

        // 硬阈值量化成两档：主线 + 半调副线。这是"手绘感"的关键，不做柔和渐变。
        float ink = e > 0.8 ? 1.0 : (e > 0.40 ? 0.42 : 0.0);
        ink *= fade * uInkStrength;

        // 大气透视：远景向火星尘霭色偏移，制造纵深。几何缓冲趟清成 a=1.0 的是天穹/背景，
        // 用 isBg 屏蔽，避免把渐变天空也糊成单色尘霭。
        float isBg = step(0.999, c.a);
        float haze = smoothstep(uHazeStart, uHazeEnd, c.a) * (1.0 - isBg);
        col = mix(col, uHaze, haze * uHazeStrength);
        col = mix(col, uInk, ink);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
  })
}

export function createPostFX(renderer: WebGLRenderer, cameraFar = 3000): PostFX {
  // WebGLRenderTarget 只是描述对象，构造本身不需要 GL 上下文；
  // 但为稳妥起见把创建包在 try 里：任何异常都退回"直连渲染"，画面照常出。
  let colorRT: WebGLRenderTarget | null = null
  let geomRT: WebGLRenderTarget | null = null
  let ok = true

  try {
    const opts = {
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
    }
    colorRT = new WebGLRenderTarget(1280, 720, opts)
    colorRT.texture.colorSpace = NoColorSpace
    geomRT = new WebGLRenderTarget(1280, 720, opts)
    geomRT.texture.colorSpace = NoColorSpace
  } catch {
    ok = false
  }

  const geomMat = createNormalDepthMaterial(cameraFar)
  const geomFlatMat = createFlatNormalDepthMaterial()
  const composeMat = createComposeMaterial()
  const quadScene = new Scene()
  const quadCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const quadGeo = new PlaneGeometry(2, 2)
  const quad = new Mesh(quadGeo, composeMat)
  quad.frustumCulled = false
  quadScene.add(quad)

  let quality: PostFXQuality = 'high'
  let width = 1280
  let height = 720
  const savedClear = new Color()

  const active = () => ok && quality !== 'low' && Boolean(colorRT && geomRT)

  const applyQuality = () => {
    // medium 关掉法线通道：低 LOD 地形的法线在远处会抖，只留深度更稳
    // high 采样半径 0.85，保证近景车体/角色的内部结构线不过粗；medium 适当加粗补偿深度-only。
    composeMat.uniforms.uNormalScale.value = quality === 'high' ? 1.0 : 0.0
    composeMat.uniforms.uDepthScale.value = quality === 'high' ? 1.0 : 0.85
    // 近景墨线：high 略收（避免车体过粗），medium 因只走深度通道需更粗兜底
    composeMat.uniforms.uThicknessNear.value = quality === 'high' ? 1.0 : 1.7
    composeMat.uniforms.uThicknessFar.value = quality === 'high' ? 0.5 : 0.6
    composeMat.uniforms.uThicknessRange.value = 0.05
  }
  applyQuality()

  const setSize = (w: number, h: number) => {
    width = Math.max(1, Math.floor(w))
    height = Math.max(1, Math.floor(h))
    colorRT?.setSize(width, height)
    geomRT?.setSize(width, height)
    composeMat.uniforms.uTexel.value.set(1 / width, 1 / height)
  }

  const render = (scene: Scene, camera: PerspectiveCamera) => {
    if (!active() || !colorRT || !geomRT) {
      renderer.setRenderTarget(null)
      renderer.render(scene, camera)
      return
    }

    geomMat.uniforms.uCameraFar.value = camera.far

    // --- 1. 几何缓冲趟：layer 0 正常法线（参与 Sobel）
    const prevMask = camera.layers.mask
    const prevOverride = scene.overrideMaterial
    renderer.getClearColor(savedClear)
    const savedAlpha = renderer.getClearAlpha()

    camera.layers.set(0)
    scene.overrideMaterial = geomMat
    renderer.setRenderTarget(geomRT)
    // 清成 (0,0,0,1)：背景法线无效、深度＝far，天际线自然被 Sobel 逮到
    renderer.setClearColor(0x000000, 1)
    renderer.clear(true, true, false)
    renderer.render(scene, camera)

    // --- 1b. 几何缓冲趟（续）：NO_SOBEL_LAYER（= 2）只写深度、法线恒定。
    // 不清色/深度（直接叠加）：让这些对象补上"自己的真实深度"，
    // 否则合成趟拿到的深度是它们背后的远景深度，会算出过强的大气透视，
    // 把对象糊成半透明背景色（2026-09-03 修过这一坑）。
    // 用恒定法线（(0,0,1) 编码到 (0.5,0.5,1.0)）让 Sobel 法线通道无差异，
    // 内部面之间不勾线；深度仍有跳变 → 对象与背景的轮廓照常被 Sobel 逮到。
    camera.layers.set(NO_SOBEL_LAYER)
    scene.overrideMaterial = geomFlatMat
    renderer.render(scene, camera)

    scene.overrideMaterial = prevOverride
    camera.layers.mask = prevMask
    renderer.setClearColor(savedClear, savedAlpha)

    // --- 2. 主渲染趟
    renderer.setRenderTarget(colorRT)
    renderer.clear(true, true, false)
    renderer.render(scene, camera)

    // --- 3. 合成趟
    composeMat.uniforms.tColor.value = colorRT.texture
    composeMat.uniforms.tGeom.value = geomRT.texture
    renderer.setRenderTarget(null)
    renderer.render(quadScene, quadCam)
  }

  return {
    render,
    setSize,
    setQuality: (level) => {
      quality = level
      applyQuality()
    },
    isActive: active,
    dispose: () => {
      colorRT?.dispose()
      geomRT?.dispose()
      geomMat.dispose()
      geomFlatMat.dispose()
      composeMat.dispose()
      quadGeo.dispose()
    },
  }
}
