import { Object3D, Vector3 } from 'three'
import { forwardVector, headingToward, localYawToward, rightVector, worldToLocalDir } from './orientation'

/**
 * 这些测试锁死"模型正面为 +X"的朝向约定。
 *
 * 曾经 heading 用了 atan2(dx, dz)，漫游车恒定横着走 90°，而车辙系统按同样的
 * 错误约定反推轮距方向，两处错误互相抵消，靠肉眼看截图查不出来。
 * 所以这里不做数学自证，而是把角度真的交给 Three.js 的 Object3D 去转，
 * 再检查转出来的世界向量——任何一侧改了约定都会立刻红。
 */
function rotateLocalX(heading: number) {
  const o = new Object3D()
  o.rotation.set(0, heading, 0)
  o.updateMatrixWorld(true)
  return new Vector3(1, 0, 0).applyQuaternion(o.quaternion)
}

function rotateLocalZ(heading: number) {
  const o = new Object3D()
  o.rotation.set(0, heading, 0)
  o.updateMatrixWorld(true)
  return new Vector3(0, 0, 1).applyQuaternion(o.quaternion)
}

const DIRS: Array<[string, number, number]> = [
  ['正 +X', 1, 0],
  ['正 +Z', 0, 1],
  ['负 X', -1, 0],
  ['负 Z', 0, -1],
  ['东北', 1, 1],
  ['西南', -3, -4],
]

describe('朝向换算（模型正面为 +X）', () => {
  it.each(DIRS)('%s：headingToward 让本地 +X 真的指向目标方向', (_name, dx, dz) => {
    const h = headingToward(dx, dz)
    const f = rotateLocalX(h)
    const len = Math.hypot(dx, dz)
    // 与目标方向的夹角余弦必须是 1
    expect((f.x * dx + f.z * dz) / len).toBeCloseTo(1, 6)
  })

  it.each(DIRS)('%s：forwardVector 与 Three.js 实际旋转结果一致', (_name, dx, dz) => {
    const h = headingToward(dx, dz)
    const f = rotateLocalX(h)
    const v = forwardVector(h)
    expect(v.x).toBeCloseTo(f.x, 6)
    expect(v.z).toBeCloseTo(f.z, 6)
  })

  it.each(DIRS)('%s：rightVector 与本地 +Z 的实际旋转结果一致，且垂直于正面', (_name, dx, dz) => {
    const h = headingToward(dx, dz)
    const r = rightVector(h)
    const actual = rotateLocalZ(h)
    expect(r.x).toBeCloseTo(actual.x, 6)
    expect(r.z).toBeCloseTo(actual.z, 6)
    // 垂直于行进方向——车辙的左右轮偏移全靠这一条
    expect((r.x * dx + r.z * dz) / Math.hypot(dx, dz)).toBeCloseTo(0, 6)
  })

  it('worldToLocalDir 与 headingToward 互为逆运算：正前方的目标本地方向就是 +X', () => {
    for (const [, dx, dz] of DIRS) {
      const h = headingToward(dx, dz)
      const { lx, lz } = worldToLocalDir(dx, dz, h)
      expect(lz).toBeCloseTo(0, 6)
      expect(lx).toBeGreaterThan(0)
      // 正前方的目标不需要转头
      expect(localYawToward(lx, lz)).toBeCloseTo(0, 6)
    }
  })

  it('侧方目标会解出非零转头角，且转头后正面确实对上目标', () => {
    // 车头朝 +X，目标在正右方（世界 +Z）
    const h = headingToward(1, 0)
    const { lx, lz } = worldToLocalDir(0, 1, h)
    const yaw = localYawToward(lx, lz)
    expect(Math.abs(yaw)).toBeGreaterThan(0.5)
    // 车体朝向 + 头部转角合成后，头部正面应指向世界 +Z
    const f = rotateLocalX(h + yaw)
    expect(f.x).toBeCloseTo(0, 6)
    expect(f.z).toBeCloseTo(1, 6)
  })

  it('零向量不产生 NaN', () => {
    expect(headingToward(0, 0)).toBe(0)
    expect(localYawToward(0, 0)).toBe(0)
  })
})
