/**
 * 朝向换算的唯一来源。
 *
 * 本工程所有程序化模型（R-7、KIBO）都以 **+X 为正面**：
 * R-7 的鼻头在 x=+1.05、桅杆在 x=+0.78、机械臂在 x=+1.25；KIBO 的 visor 在 x=+0.4。
 *
 * Three.js 绕 Y 轴旋转 h 的矩阵是
 *
 *     | cos h   0   sin h |
 *     |   0     1     0   |
 *     | -sin h  0   cos h |
 *
 * 所以本地 +X 经旋转后指向世界 `(cos h, -sin h)`。要让正面对准世界方向 `(dx, dz)`，
 * 必须取 `h = atan2(-dz, dx)`。
 *
 * 曾经这里写成了直觉上很顺手的 `atan2(dx, dz)`——那个约定对应的是"正面为 +Z"的模型，
 * 用在 +X 正面的模型上会**恒定偏 90°**，表现为漫游车一路横着走。更麻烦的是
 * 车辙系统当时按错误朝向反推了轮距方向，两个错误互相抵消，画面上看不出来。
 * 所以换算必须集中在这一个文件里，并由单测锁死。
 */

/** 世界方向 (dx, dz) → 绕 Y 的朝向角（模型正面为 +X）。零向量返回 0。 */
export function headingToward(dx: number, dz: number): number {
  if (dx === 0 && dz === 0) return 0
  return Math.atan2(-dz, dx)
}

/** 朝向角 → 正面单位向量（世界 xz 平面）。 */
export function forwardVector(heading: number): { x: number; z: number } {
  return { x: Math.cos(heading), z: -Math.sin(heading) }
}

/**
 * 朝向角 → 右侧单位向量（模型本地 +Z 在世界的方向）。
 * 车辙的左右轮偏移、并排布置的部件都必须用这个，而不是正面向量。
 */
export function rightVector(heading: number): { x: number; z: number } {
  return { x: Math.sin(heading), z: Math.cos(heading) }
}

/**
 * 世界方向向量 → 以 heading 为正面的本地方向向量。
 * 用于桅杆相机注视、KIBO 指路这类"在本体坐标系里算转头角度"的场景。
 */
export function worldToLocalDir(
  dx: number,
  dz: number,
  heading: number,
): { lx: number; lz: number } {
  const c = Math.cos(heading)
  const s = Math.sin(heading)
  return { lx: dx * c - dz * s, lz: dx * s + dz * c }
}

/**
 * 本地方向 (lx, lz) → 子部件绕 Y 的转角（子部件正面同样是 +X）。
 * 与 headingToward 同一约定，单独命名只为在调用处读起来更清楚。
 */
export function localYawToward(lx: number, lz: number): number {
  if (lx === 0 && lz === 0) return 0
  return Math.atan2(-lz, lx)
}
