/**
 * 把探测置信度场包成一张 GPU 纹理。
 *
 * 只做搬运，不做任何逻辑：地图上看到的"已探明区"必须与规划器读到的
 * 是同一份 `KnowledgeField.data`，中间不允许有第二套采样或平滑。
 */
import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  RedFormat,
  UnsignedByteType,
} from 'three'
import type { KnowledgeField } from '../core/knowledge'

export type KnowledgeTexture = {
  texture: DataTexture
  /** 每帧调用；置信度场变了才真正重传 */
  sync: () => void
  dispose: () => void
}

export function createKnowledgeTexture(knowledge: KnowledgeField): KnowledgeTexture {
  const texture = new DataTexture(
    knowledge.data,
    knowledge.res,
    knowledge.res,
    RedFormat,
    UnsignedByteType,
  )
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.wrapS = ClampToEdgeWrapping
  texture.wrapT = ClampToEdgeWrapping
  texture.generateMipmaps = false
  // Red + 单字节：行宽不一定是 4 的倍数，必须显式放宽对齐
  texture.unpackAlignment = 1
  texture.needsUpdate = true

  let lastVersion = -1

  return {
    texture,
    sync: () => {
      if (knowledge.version === lastVersion) return
      lastVersion = knowledge.version
      texture.needsUpdate = true
    },
    dispose: () => texture.dispose(),
  }
}
