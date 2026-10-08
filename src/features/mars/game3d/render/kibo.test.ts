/**
 * KIBO 建模回归测试。
 *
 * 背景（2026-09-01 全量重写）：旧模型脚底落在 local y ≈ -0.98，而 stage 的根节点
 * y = 地面高度 + 0.02，导致 KIBO 有近 1 个单位**陷在地里**，只剩上半身可见、比例失真。
 *
 * 本测试锁死重写后的纵向跨度契约，防止"陷地 / 悬空"回归：
 *  - 脚底 ≈ 0（贴地）
 *  - 头顶 ≈ 2.6（对齐 stage.ts 的 KIBO_HEAD_OFFSET，感叹号标记才会落在头顶）
 *  - 头高 ≈ 全高 1/3（chibi 比例）
 */
import { Box3, Mesh, type Object3D } from 'three'
import { createKibo } from './kibo'
import { createRampTexture } from './ramp'

/**
 * 计算**本体**包围盒：排除 addSilhouetteOutline 生成的描边外壳。
 * 描边是反向外壳（inverted hull），整体向外撑大一圈，会污染纵向跨度判定。
 */
function bodyBounds(root: Object3D): Box3 {
  root.updateMatrixWorld(true)
  const box = new Box3()
  root.traverse((o) => {
    const m = o as Mesh
    if (!m.isMesh) return
    if (m.name.endsWith('__silhouette')) return
    box.expandByObject(m)
  })
  return box
}

function makeKibo() {
  const ramp = createRampTexture()
  const kibo = createKibo(ramp)
  // 根节点落在 y=0，因此世界包围盒 == 本地包围盒
  kibo.setPose({ x: 0, y: 0, z: 0, heading: 0, bob: 0, mood: 'idle' })
  kibo.group.updateMatrixWorld(true)
  return kibo
}

describe('KIBO 建模纵向跨度（防陷地 / 悬空回归）', () => {
  it('脚底贴地（local y ≈ 0）：既不陷进地里，也不悬空', () => {
    const kibo = makeKibo()
    const box = bodyBounds(kibo.group)
    // 旧模型这里是 -0.98（陷地近 1 个单位），重写后必须回到 0 附近
    expect(box.min.y).toBeGreaterThan(-0.12)
    expect(box.min.y).toBeLessThan(0.12)
  })

  it('头顶 ≈ 2.2（用户 2026-09-02 反馈"头太大"后缩小，对应 stage 的 KIBO_HEAD_OFFSET）', () => {
    const kibo = makeKibo()
    const box = bodyBounds(kibo.group)
    expect(box.max.y).toBeGreaterThan(2.05)
    expect(box.max.y).toBeLessThan(2.35)
  })

  it('头高约占全高 1/2（2 头身矮胖 chibi 比例；头高 1.10）', () => {
    const kibo = makeKibo()
    const box = bodyBounds(kibo.group)
    const total = box.max.y - box.min.y
    // 头壳：headGroup y=1.65、半径 0.55 → 头顶 2.20、头底 1.10
    const headRatio = (2.2 - 1.1) / total
    expect(headRatio).toBeGreaterThan(0.46)
    expect(headRatio).toBeLessThan(0.56)
  })

  it('整体宽度合理（chibi 胖墩剪影，不会瘦长也不会过宽）', () => {
    const kibo = makeKibo()
    const box = bodyBounds(kibo.group)
    const width = box.max.x - box.min.x
    const height = box.max.y - box.min.y
    expect(width / height).toBeGreaterThan(0.25)
    expect(width / height).toBeLessThan(0.75)
  })
})
