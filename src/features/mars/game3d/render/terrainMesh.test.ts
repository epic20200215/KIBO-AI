/**
 * 分块 LOD 地形：低端机 setMinLod 强制更粗下限的回归测试。
 * 不依赖 WebGL（只构造几何体 + 数三角形）。
 */
import { Mesh } from 'three'
import { BASIN_SIZE, createHeightField } from '../core/heightField'
import { createRampTexture } from './ramp'
import { createTerrainRenderer } from './terrainMesh'

const HALF = BASIN_SIZE / 2

test('setMinLod(2) 把近处地形强制压到 stride=4 的粗档', () => {
  const field = createHeightField('kibo-mars-basin-v1')
  const terrain = createTerrainRenderer(field, createRampTexture())

  // 聚焦到 chunk(0,0) 中心，距相机足够近 → 默认会选最细档（stride=1）
  const chunkWorld = BASIN_SIZE / 8
  const center0 = -HALF + 0.5 * chunkWorld
  terrain.updateLod(center0, center0)
  const before = (terrain.group.children.find((c) => c.name === 'chunk-0-0') as Mesh).geometry.getIndex()!.count / 3

  // 低端机锁定更粗下限
  terrain.setMinLod(2)
  terrain.updateLod(center0, center0)
  const after = (terrain.group.children.find((c) => c.name === 'chunk-0-0') as Mesh).geometry.getIndex()!.count / 3

  // stride=1: 48×48 主面 + 48×4 裙边 = 4992；stride=4: 12×12 主面 + 12×4 裙边 = 384
  expect(before).toBe(4992)
  expect(after).toBe(384)
  expect(after).toBeLessThan(before)

  terrain.dispose()
})

test('setMinLod(0) 恢复为按距离自适应（近处回到最细档）', () => {
  const field = createHeightField('kibo-mars-basin-v1')
  const terrain = createTerrainRenderer(field, createRampTexture())
  const chunkWorld = BASIN_SIZE / 8
  const center0 = -HALF + 0.5 * chunkWorld

  terrain.setMinLod(2)
  terrain.updateLod(center0, center0)
  terrain.setMinLod(0)
  terrain.updateLod(center0, center0)
  const tris = (terrain.group.children.find((c) => c.name === 'chunk-0-0') as Mesh).geometry.getIndex()!.count / 3

  expect(tris).toBe(4992)
  terrain.dispose()
})
