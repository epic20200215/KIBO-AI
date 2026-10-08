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

此次只上传正式网站源码与运行素材，尚未启用 GitHub Pages。

若部署到本仓库的 GitHub Pages，预期地址为 `https://epic20200215.github.io/KIBO-AI/`。发布前需设置 Vite 的 `/KIBO-AI/` base，并使组件中的图片、预加载资源与音频地址使用相同的部署前缀；仅修改 Vite base 不足以处理现有代码中的根路径资源地址。

私钥、服务器部署配置、开发草稿、截图产物与日志不包含在本次上传中。素材生成记录见 `docs/素材清单与生成记录.md`。本仓库未授予额外的代码或素材再分发许可。
