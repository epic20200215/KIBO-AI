import * as THREE from 'three'
import { createHauler } from './hauler'
import type { HeightField } from '../core/heightField'

/**
 * 锁死 v1.3.3 两处修复：
 * - 矿石描边去掉（每个 ore mesh 设 userData.outline=false）
 * - getWheelWorldPositions 返回 6 轮世界坐标，且 [0]=左后/[3]=右后
 *
 * 整体目的是：未来谁要改 hauler 的内部构造，会被这两条断言挡下来，
 * 而不是悄悄退化回"矿石没采就有描边/烟雾又喷在车体中心"。
 */

const flatField = (): HeightField => ({
  heightAt: () => 0,
  width: 100,
  depth: 100,
  cellSize: 1,
  // 其余方法用不到，传空实现兜底
} as unknown as HeightField)

const fakeRamp = {} as THREE.Texture

describe('hauler (v1.3.3 锁死：矿石描边 + 轮位 API)', () => {
  it('矿石 mesh 都标了 outline=false，避免 BackSide 外壳在未采集时画出轮廓', () => {
    const h = createHauler(flatField(), fakeRamp)
    const ores: THREE.Mesh[] = []
    h.group.traverse((o) => {
      // 只挑矿石：父级是 oreCrate 的子项（oreCrate 命名空间唯一）
      if (
        o instanceof THREE.Mesh &&
        o.parent &&
        o.parent.name === '' &&
        // 用几何形状筛：矿石是 IcosahedronGeometry，半径较小（0.4~0.75）
        (o.geometry as THREE.BufferGeometry).type === 'IcosahedronGeometry'
      ) {
        ores.push(o)
      }
    })
    // createHauler 固定创建 5 块矿石
    expect(ores.length).toBe(5)
    for (const ore of ores) {
      expect(ore.userData.outline).toBe(false)
    }
    h.dispose()
  })

  it('getWheelWorldPositions 返回 6 个轮子世界坐标', () => {
    const h = createHauler(flatField(), fakeRamp)
    const wheels = h.getWheelWorldPositions()
    expect(wheels.length).toBe(6)
    for (const w of wheels) {
      expect(typeof w.x).toBe('number')
      expect(typeof w.y).toBe('number')
      expect(typeof w.z).toBe('number')
      expect(Number.isFinite(w.x)).toBe(true)
      expect(Number.isFinite(w.y)).toBe(true)
      expect(Number.isFinite(w.z)).toBe(true)
    }
    h.dispose()
  })

  it('轮子顺序：左后[0]、右后[3]，对应扬尘拖尾取这两枚', () => {
    const h = createHauler(flatField(), fakeRamp)
    // 制造位置 (10, 0, 5)，heading 朝 +Z（rotation.y = 0 → 车头朝 +Z、后轮在 -Z）
    h.group.position.set(10, 0, 5)
    h.group.rotation.y = 0
    const wheels = h.getWheelWorldPositions()
    // 本地坐标：左后 (-2.7, HR, -3.6) / 右后 (+2.7, HR, -3.6)
    // 世界坐标（heading=0）：左后 (10-2.7, HR-, 5-3.6) / 右后 (10+2.7, HR-, 5-3.6)
    expect(wheels[0].x).toBeCloseTo(10 - 2.7, 5)
    expect(wheels[0].z).toBeCloseTo(5 - 3.6, 5)
    expect(wheels[3].x).toBeCloseTo(10 + 2.7, 5)
    expect(wheels[3].z).toBeCloseTo(5 - 3.6, 5)
    // 左右轮 z 相同（都在车尾），x 镜像
    expect(wheels[0].z).toBeCloseTo(wheels[3].z, 5)
    h.dispose()
  })

  it('旋转后轮位跟随车体朝向（heading 变化时轮位会转）', () => {
    const h = createHauler(flatField(), fakeRamp)
    h.group.position.set(0, 0, 0)
    h.group.rotation.y = 0
    const w0 = h.getWheelWorldPositions()
    h.group.rotation.y = Math.PI / 2 // 车头朝 +X，后轮转到 -X
    const w90 = h.getWheelWorldPositions()
    // 左后本地 (-2.7, HR, -3.6)，heading=π/2 后世界坐标：
    // x = 0 + (-2.7)*cos(π/2) + (-3.6)*sin(π/2) = 0 + 0 + (-3.6) = -3.6
    // z = 0 + (-(-2.7))*sin(π/2) + (-3.6)*cos(π/2) = 0 + 2.7 + 0 = -3.6 + 2.7 = 2.7
    expect(w90[0].x).toBeCloseTo(-3.6, 5)
    expect(w90[0].z).toBeCloseTo(2.7, 5)
    expect(w0[0].x).not.toBeCloseTo(w90[0].x, 3)
    h.dispose()
  })

  it('v1.3.4：轮位 y 贴地（不是轮子中部）—— 扬尘从轮底卷起', () => {
    const h = createHauler(flatField(), fakeRamp)
    // 平地 y=0；group 摆到不同高度，轮位 y 都应只比地面高 0.05m
    for (const groundY of [0, 1.5, -0.5, 12.3]) {
      h.group.position.set(7, groundY, -3)
      h.group.rotation.y = 0.4
      const wheels = h.getWheelWorldPositions()
      for (const w of wheels) {
        expect(w.y).toBeCloseTo(groundY + 0.05, 5)
      }
    }
    // 反例：旧版 y ≈ groundY + HR (= 1.5)；新版本绝不允许 ≥ HR-0.5（明显在轮子中部）
    h.group.position.set(0, 0, 0)
    h.group.rotation.y = 0
    const wheels = h.getWheelWorldPositions()
    for (const w of wheels) {
      expect(w.y).toBeLessThan(0.5) // 贴地；旧的会 ≈ 1.5，会 > 0.5
    }
    h.dispose()
  })

  /**
   * v1.3.5 核心 bug 锁死：采集车回到基地"不渐隐、操控权不回玩家"。
   *
   * 根因在 stage.ts —— `if (haulerActive)` 块里每帧都调 `hauler.show(true)`，
   * 而 show(true) 会把 fadingOut=false / opacityMul=1 重置，
   * 等于每帧把 fadeOut() 设的渐隐状态冲掉，渐隐永远推不动，
   * finishHauler 回调永不触发 → haulerActive 一直 true → 相机一直跟采集车、
   * rover.group.visible 一直 false，玩家根本操控不了 R-7。
   *
   * 这两条把 hauler 的渐隐契约固化下来：
   *   ① 正常路径：fadeOut + update 推进 → 渐隐完成、隐藏、回调触发；
   *   ② 副作用契约：渐隐途中调 show(true) 会把渐隐打回原点
   *      （所以调用方——stage.ts——必须在渐隐期间避免 show(true)，已用 `if (!haulerFading)` 守住）。
   */
  it('v1.3.5：fadeOut 后 update 推进能渐隐到隐藏并触发回调', () => {
    const h = createHauler(flatField(), fakeRamp)
    h.show(true)
    expect(h.group.visible).toBe(true)

    let hidden = false
    h.fadeOut(() => {
      hidden = true
    })

    // 渐隐速率 dt * 1.25 / s，即约 0.8s 走完；这里推进 1.5s 留足余量
    for (let i = 0; i < 90; i += 1) h.update(1 / 60)

    expect(hidden).toBe(true)
    expect(h.group.visible).toBe(false)
    h.dispose()
  })

  it('v1.3.5：渐隐途中调 show(true) 会彻底取消渐隐（副作用契约，提醒调用方别在渐隐期调）', () => {
    const h = createHauler(flatField(), fakeRamp)
    h.show(true)

    let hidden = false
    h.fadeOut(() => {
      hidden = true
    })

    // 先推进一段（渐隐进行中，还没到 0）
    for (let i = 0; i < 20; i += 1) h.update(1 / 60)
    expect(hidden).toBe(false) // 还没结束

    // 此刻调 show(true) —— 内部把 fadingOut 置 false，渐隐被**彻底取消**
    // （不是"变慢"，是取消：update 的渐隐分支 `if (fadingOut && ...)` 再也不会进入）
    h.show(true)

    // 继续推进很久（5s），回调都不会触发——这正是"每帧 show(true)"时渐隐从没真正开始的原因
    for (let i = 0; i < 300; i += 1) h.update(1 / 60)
    expect(hidden).toBe(false)

    // 必须重新 fadeOut() 才会再渐隐（证明 show(true) 是取消而非暂停）
    h.fadeOut(() => {
      hidden = true
    })
    for (let i = 0; i < 90; i += 1) h.update(1 / 60)
    expect(hidden).toBe(true)
    expect(h.group.visible).toBe(false)
    h.dispose()
  })
})