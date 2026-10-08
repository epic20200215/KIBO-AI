/**
 * 天穹、火星尘霭与赛璐珞云幕。
 *
 * 全部程序化：一个内翻球体 + 一段渐变着色器 + 一张由种子化噪声生成的云噪贴图。
 * 云被硬阈值切成两个色调（亮面 / 暗面），不做柔和渐变——这是让天空读起来像
 * 动画背景板而不是 HDRI 的关键。太阳保持"图形化"：一个硬边小圆盘 + 两圈量化光晕，
 * 不做摄影式泛光。
 */
import {
  BackSide,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  LinearFilter,
  Mesh,
  RGBAFormat,
  RepeatWrapping,
  ShaderMaterial,
  SphereGeometry,
  UnsignedByteType,
  Vector3,
} from 'three'
import { createRng, seedFromString } from '../core/rng'
import { createValueNoise2D } from '../core/noise'
import { PALETTE, skyPaletteFor, sunDirectionFor } from './palette'

const CLOUD_TEX_SIZE = 256

/** 用种子化噪声烘一张云噪贴图。只影响观感，不参与任何模拟。 */
function createCloudTexture(): DataTexture {
  const noise = createValueNoise2D(createRng(seedFromString('kibo-sky-clouds')))
  const data = new Uint8Array(CLOUD_TEX_SIZE * CLOUD_TEX_SIZE * 4)
  for (let j = 0; j < CLOUD_TEX_SIZE; j += 1) {
    for (let i = 0; i < CLOUD_TEX_SIZE; i += 1) {
      // 用可平铺的双重采样避免接缝：沿两个方向各取一次并按位置混合
      const u = i / CLOUD_TEX_SIZE
      const v = j / CLOUD_TEX_SIZE
      const a = noise.fbm(u * 4, v * 4, 4)
      const b = noise.fbm((u - 1) * 4, v * 4, 4)
      const c = noise.fbm(u * 4, (v - 1) * 4, 4)
      const d = noise.fbm((u - 1) * 4, (v - 1) * 4, 4)
      const value =
        (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v
      const byte = Math.max(0, Math.min(255, Math.round((value * 0.5 + 0.5) * 255)))
      const idx = (j * CLOUD_TEX_SIZE + i) * 4
      data[idx] = byte
      data[idx + 1] = byte
      data[idx + 2] = byte
      data[idx + 3] = 255
    }
  }
  const tex = new DataTexture(data, CLOUD_TEX_SIZE, CLOUD_TEX_SIZE, RGBAFormat, UnsignedByteType)
  tex.wrapS = RepeatWrapping
  tex.wrapT = ClampToEdgeWrapping
  tex.magFilter = LinearFilter
  tex.minFilter = LinearFilter
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return tex
}

export type SkyDome = {
  mesh: Mesh
  setTime: (t: number) => void
  /** 沙尘暴强度 0..1：>0 时天空泛黄、压暗，模拟乌云压顶。 */
  setStorm: (intensity: number) => void
  dispose: () => void
}

export function createSkyDome(worldIndex = 0, radius = 1800): SkyDome {
  // new Color(hex) 自动把 sRGB hex 解析为线性 Color，避免 sky 颜色过曝。
  const c = (hex: string) => new Color(hex)
  const cloudTex = createCloudTexture()
  // 天穹/尘霭配色与太阳方向按地图取用。worldIndex 缺省为 0（火星一号），
  // 取值与改动前的 PALETTE 常量完全一致，因此一号观感不变。
  const skyPal = skyPaletteFor(worldIndex)
  const sunDir = sunDirectionFor(worldIndex)

  const material = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uStorm: { value: 0 },
      uZenith: { value: c(skyPal.zenith) },
      uMid: { value: c(skyPal.mid) },
      uHorizon: { value: c(skyPal.horizon) },
      uHaze: { value: c(skyPal.haze) },
      uStormTint: { value: c(PALETTE.stormTint) },
      uSunCore: { value: c(PALETTE.sunCore) },
      uSunHalo: { value: c(PALETTE.sunHalo) },
      uCloudLight: { value: c(PALETTE.cloudLight) },
      uCloudDark: { value: c(PALETTE.cloudDark) },
      uSunDir: { value: new Vector3(sunDir.x, sunDir.y, sunDir.z).normalize() },
      uCloudTex: { value: cloudTex },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uTime;
      uniform vec3 uZenith;
      uniform vec3 uMid;
      uniform vec3 uHorizon;
      uniform vec3 uHaze;
      uniform vec3 uSunCore;
      uniform vec3 uSunHalo;
      uniform vec3 uCloudLight;
      uniform vec3 uCloudDark;
      uniform vec3 uSunDir;
      uniform sampler2D uCloudTex;
      uniform float uStorm;
      uniform vec3 uStormTint;
      varying vec3 vDir;

      void main() {
        vec3 dir = normalize(vDir);
        float h = clamp(dir.y, -1.0, 1.0);

        // --- 三段渐变天穹：地平线暖黄粉 → 中段赭 → 天顶冷灰蓝
        float tLow = smoothstep(-0.04, 0.26, h);
        float tHigh = smoothstep(0.20, 0.78, h);
        vec3 sky = mix(uHorizon, uMid, tLow);
        sky = mix(sky, uZenith, tHigh);

        // --- 近地平线尘霭：火星特有的低角度悬浮尘
        float haze = 1.0 - smoothstep(-0.08, 0.20, h);
        sky = mix(sky, uHaze, haze * 0.62);

        // --- 赛璐珞云幕：硬阈值切成亮暗两档，水平飘移
        float cloudFade = smoothstep(0.02, 0.22, h) * (1.0 - smoothstep(0.45, 0.9, h));
        if (cloudFade > 0.001) {
          vec2 cuv = vec2(atan(dir.z, dir.x) * 0.1591 + uTime * 0.004, (h - 0.02) * 2.4);
          float n = texture(uCloudTex, cuv).r;
          float n2 = texture(uCloudTex, cuv * 2.1 + vec2(uTime * 0.007, 0.31)).r;
          float density = n * 0.68 + n2 * 0.32;
          // 两级硬边：外形一档，内部亮面一档
          float shape = step(0.56, density);
          float core = step(0.66, density);
          vec3 cloud = mix(uCloudDark, uCloudLight, core);
          sky = mix(sky, cloud, shape * cloudFade * 0.78);
        }

        // --- 太阳：硬边小日面（保持赛璐珞图形感）+ **单层柔和光晕**
        //     2026-09-10 老大反馈「天空中像太阳一样的多轮光圈，效果太差」：
        //     原来是 step() 做出的**两圈独立硬边光晕 + 核心**，三层同心圆叠在一起，
        //     像廉价镜头光晕。一号太阳高（y=0.58）基本不在视野内看不出来，
        //     二号太阳低垂（≈11°）正对相机，光圈就非常扎眼。
        //     改为：光晕用 smoothstep 平滑衰减（单层、无硬边环），日面仍用 step 保硬边。
        float sd = dot(dir, normalize(uSunDir));
        // 外圈光晕：平滑衰减
        float halo = smoothstep(0.9960, 0.9995, sd) * 0.55;
        // 内圈日面：2026-09-11 老大反馈「外圈已模糊，但内圈还是一层锐利的面片状」。
        // 原本用 step() 硬边，切出一个**锐利圆盘面片**；改为窄范围 smoothstep 柔化边缘
        // （范围很窄，保留"日面"的形状与亮度核心，只把边界做软）。
        float core = smoothstep(0.99965, 0.99988, sd);
        sky = mix(sky, uSunHalo, halo);
        sky = mix(sky, uSunCore, core);

        // --- 沙尘暴：乌云压顶时整片天空泛黄、压暗，太阳被尘幕遮蔽。
        // 2026-09-01 修复：从风暴内部往外看时，天顶/地平残留的冷青会被读成"青色场景"，
        // 因此风暴中先按亮度部分去饱和（压掉蓝青），再叠更浓的赭红天幕，并压暗更多。
        if (uStorm > 0.001) {
          float luma = dot(sky, vec3(0.299, 0.587, 0.114));
          sky = mix(sky, vec3(luma), uStorm * 0.45);
          sky = mix(sky, uStormTint, uStorm * 0.92);
          sky *= (1.0 - uStorm * 0.42);
          // 太阳在风暴里几乎被吃掉
          float sunVis = max(0.0, 1.0 - uStorm * 2.1);
          sky = mix(sky, uStormTint * 0.9, (1.0 - sunVis) * 0.5);
        }

        gl_FragColor = vec4(sky, 1.0);
        #include <colorspace_fragment>
      }
    `,
  })

  const mesh = new Mesh(new SphereGeometry(radius, 40, 24), material)
  mesh.name = 'SkyDome'
  mesh.frustumCulled = false
  mesh.renderOrder = -1

  return {
    mesh,
    setTime: (t) => {
      material.uniforms.uTime.value = t
    },
    setStorm: (intensity: number) => {
      material.uniforms.uStorm.value = Math.max(0, Math.min(1, intensity))
    },
    dispose: () => {
      mesh.geometry.dispose()
      material.dispose()
      cloudTex.dispose()
    },
  }
}
