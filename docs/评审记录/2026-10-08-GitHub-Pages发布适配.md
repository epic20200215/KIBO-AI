# GitHub Pages 发布适配评审

日期 2026-10-08。范围为正式 V1.4.3 网站的托管与资源路径适配，不修改任务玩法、教学数值或发布状态。

## 主策划审核

- 现象：网站需要从 `/KIBO-AI/` 进入，而首页、探索舱、任务由 hash 切换。若资源加载失败，学生会在进入任务时看到空页。
- 根因：项目原先按域名根目录部署，部分图片与音频使用根路径。
- 判定依据：正常启动任务必须进入真实的火星场景；hash 链接刷新必须可达，不能只验证首页按钮存在。
- 级别 P1。位置 `src/pages/`、`src/data/missions.ts`、`src/lib/onboardingVoice.ts`。
- 处置：资源使用 BASE_URL；本地生产构建中实际操作首页进入探索舱、切换任务、启动任务、进入火星场景，全部可达。未发布任务仍显示原正式版本的介绍和禁用按钮，不增加可体验内容。

## 主美术审核

- 现象：只设置构建 base 时，组件图片仍请求 `/assets/`，会丢失背景、壳体、KIBO 头像等正式素材。
- 根因：Vite 能处理 HTML 和 CSS 的静态引用，但不会自动重写任意 JavaScript 字符串。
- 判定依据：场景、角色和文本层级必须用真实截帧核对，不能根据构建成功推断图片正常。
- 级别 P1。位置 `HomePage.tsx`、`CabinPage.tsx`、`Brand.tsx`、火星任务引导与 KIBO 对话组件。
- 处置：动态地址补部署前缀；本地桌面截图复核首页和探索舱，正式图片全部加载，无横向溢出；CSS 转场背景在构建产物中已转换为 `/KIBO-AI/assets/`。

## 主程序审核

- 现象：根路径预加载、独立 Audio 实例和懒加载任务是容易漏检的三个入口；预览模式与构建模式不一致也会产生 404。
- 根因：这些资源不都以 DOM img 出现，且 Vite preview 的挂载路径由当前配置决定。
- 判定依据：必须查实际网络请求、音频 readyState 和 3D canvas，不能只扫可见图片。
- 级别 P1。位置 `src/lib/onboardingVoice.ts`、`MissionBoundary.tsx`、`HomePage.tsx`、`vite.config.ts`、`.github/workflows/pages.yml`。
- 处置：图片、预加载和音频统一使用 BASE_URL；github-pages 模式设置 base，默认模式仍为 `/`；部署工作流在类型检查、测试和构建通过后才发布，固定官方 Actions 提交。

## 本地验证

- `npm run typecheck` 通过。
- `npm test` 19 个测试文件、216 项测试通过。
- `npm run build -- --mode github-pages` 通过；脚本、CSS、favicon 使用 `/KIBO-AI/`。
- `npm run preview -- --mode github-pages --host 127.0.0.1 --port 49139 --strictPort` 为实际生产构建预览。
- 截图位于本地 `output/playwright/`，不上传构建产物与截图。

线上部署、移动视口与媒体偏好检查在发布后补录。本轮不声称重新完成火星任务的全部教学、确定性与硬件性能验收。
