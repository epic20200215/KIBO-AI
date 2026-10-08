import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  base: mode === 'github-pages' ? '/KIBO-AI/' : '/',
  plugins: [react()],
  // 火星 3D 任务（Three.js）已改为 React.lazy 按需加载，816 kB 的 game3d chunk 仅在进入任务时拉取，
  // 不属于首屏。将其排除在「chunk > 500 kB」警告之外，避免误导；首屏主包约 228 kB 不受影响。
  build: {
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // 本环境 vitest v4.1.10 + jsdom 下，`import { describe, expect, it } from 'vitest'`
    // 会触发 runner 初始化异常（`Cannot read properties of undefined (reading 'config')`）。
    // 所有测试文件已改为直接使用 globals（配置中 globals: true），避免该问题。
    // 保留串行作为兜底，进一步降低 jsdom worker 全局污染风险。
    fileParallelism: false,
  },
}))
