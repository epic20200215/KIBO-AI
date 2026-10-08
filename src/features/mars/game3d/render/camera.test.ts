import { createCameraRig } from './camera'

/**
 * 自由轨道旋转（右键拖拽）的方位角不应被钳制。
 * 旧实现 nudgeAzimuth 在 orbitMode 下把 azimuth 夹到 ±π，导致"转满一圈就卡死"。
 * 这里验证连续大量 nudge 后方位角能持续变化、相机位置不卡在边界。
 */
describe('camera rig 自由旋转不钳制', () => {
  it('连续 nudgeAzimuth 远超 ±π 后仍能继续旋转（修复转满一圈卡死）', () => {
    const rig = createCameraRig()
    rig.setOrbitMode(true) // 进入自由轨道（右键拖拽即此模式）
    rig.setFocus(0, 0, 0)
    rig.update(0.016)
    const sx = rig.camera.position.x
    const sz = rig.camera.position.z

    // 连续右拖 200 次（每次 +0.05），累计 +10 rad，远超 ±π
    for (let i = 0; i < 200; i++) rig.nudgeAzimuth(0.05)
    rig.update(0.016)
    const afterManyX = rig.camera.position.x
    const afterManyZ = rig.camera.position.z
    const movedFromStart = Math.abs(afterManyX - sx) + Math.abs(afterManyZ - sz)
    expect(movedFromStart).toBeGreaterThan(0.1)

    // 再转一次：位置必须继续改变——证明没有被夹死在 ±π 边界
    const beforeX = afterManyX
    const beforeZ = afterManyZ
    rig.nudgeAzimuth(0.05)
    rig.update(0.016)
    const afterOneMoreX = rig.camera.position.x
    const afterOneMoreZ = rig.camera.position.z
    const movedAgain = Math.abs(afterOneMoreX - beforeX) + Math.abs(afterOneMoreZ - beforeZ)
    expect(movedAgain).toBeGreaterThan(1e-4)
  })
})
