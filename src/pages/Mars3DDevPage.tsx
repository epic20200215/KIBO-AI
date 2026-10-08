/**
 * 3D 火星舞台的开发期检视页（`#dev/mars3d`）。
 *
 * 这个页面只有一个用途：让人和 Playwright 看到**同一组**固定机位的同一帧。
 * 它不是任务页，也不会进入生产路由——`App.tsx` 里用 `import.meta.env.DEV` 拦住。
 *
 * 调试面板 / 性能数据 / 机位条全部收进 HUD 的「GM」按钮里，
 * 普通玩家在主界面看不到任何开发者工具（对齐 UI/UX redesign 第四节）。
 */
import { MarsGame3D } from '../features/mars/game3d/MarsGame3D'

export type Mars3DDevPageProps = {
  onExit?: () => void
}

export function Mars3DDevPage({ onExit }: Mars3DDevPageProps) {
  /**
   * 支持 `#dev/mars3d?world=1` 切到火星二号，供截图工装验证二号资产
   * （三个样本站模型、崖壁层理、黄昏光环境）。
   *
   * 注意：这是 hash 路由，query 在 **hash 内部**（`window.location.search` 读不到），
   * 必须手工切 `#` 之后的 `?` 段。默认 0（火星一号），不传参时行为与改动前完全一致。
   */
  const hash = window.location.hash
  const q = hash.indexOf('?')
  const params = new URLSearchParams(q >= 0 ? hash.slice(q + 1) : '')
  const worldIndex = params.get('world') === '1' ? 1 : 0

  return (
    <main className="mars3d-devpage">
      {/*
        检视/截图通道关掉入场全景浏览：镜头会持续飞 9 秒，
        Playwright 截到的就不是固定机位了。玩家路线（探索舱进入）才开。
      */}
        {/* 2026-09-12 老大反馈：dev 检视页也要能看入场动画（此前为 QA 截帧关闭）；截图工装加载后自行调 skipIntroFlyover 跳过 */}
  <MarsGame3D showHud worldIndex={worldIndex} onExit={onExit} />
    </main>
  )
}
