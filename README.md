# KIBO AI 素养探索基地

面向 10–12 岁学生的免费 AI 素养项目学习网站。

本仓库首次导入本地正式版本 **V1.4.3**，对应原开发仓库提交 `08dd5c7`。内容包括官网首页、任务探索舱、火星无人车任务及运行所需的图片与旁白音频。其他任务目前只展示介绍，不能开始体验；未提交的深海开发代码不在此次导入范围内。

## 本地运行

使用 Node.js 24 LTS 与 npm。

```sh
npm ci
npm run dev
```

## 检查和构建

```sh
npm run typecheck
npm test
npm run build
npm run preview
```

构建输出为 `dist/`。网站使用 React、TypeScript、Vite 与 Three.js；页面通过 URL hash 切换，任务进度保存在当前浏览器的 localStorage 中。

## 发布状态

网站地址为 https://epic20200215.github.io/KIBO-AI/ 。

GitHub Pages 使用 `.github/workflows/pages.yml` 构建和发布；推送到 `main` 后自动执行类型检查、测试和生产构建，全部通过后才部署。

Pages 构建命令为 `npm run build -- --mode github-pages`，使用 `/KIBO-AI/` base。组件图片、预加载资源与音频统一跟随 `import.meta.env.BASE_URL`；普通 `npm run dev` 和 `npm run build` 仍使用根路径 `/`。URL hash 路由可直接打开和刷新。

本地预览 Pages 构建时，使用 `npm run preview -- --mode github-pages`，再打开终端显示的 `/KIBO-AI/` 地址。构建与预览模式必须一致。

私钥、服务器部署配置、开发草稿、截图产物与日志不包含在本次上传中。素材生成记录见 `docs/素材清单与生成记录.md`。本仓库未授予额外的代码或素材再分发许可。
