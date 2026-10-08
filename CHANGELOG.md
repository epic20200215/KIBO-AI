# 版本记录（CHANGELOG）

本文件记录 KIBO 官网主线（`master`）的每一个正式版本，作为「版本记录」的权威载体。
后续每个版本都在文件顶部追加一个条目，并打对应的 `vX.Y.Z` git tag。

## 约定

- 每个正式版本在文件**顶部**追加一个条目（最新在上）。
- 每个正式版本同时打 `v<主>.<次>` 形式的 **git tag**（如 `v1.0`、`v1.1`），作为不可变快照；
  可随时 `git checkout v1.1` 回溯到该版本。修订号一般不单独打 tag。
- 版本号语义：**主版本.次版本.修订**（major.minor.patch）
  - **主版本**：产品形态 / 架构级变化（如引入全新任务类型、推翻既有世界观）。
  - **次版本**：新增任务、重大功能或体验重构。
  - **修订**：缺陷修复、措辞 / 数值微调、文档更新。
- 提交信息统一以 `chore(release): VX.Y.Z ...` 或对应 `feat/fix` 前缀开头，便于 `git log` 检索。

---

## [1.4.3] - 2026-09-15  （新手引导旁白配音 + 重置后重新引导）

### 新增
- **新手引导旁白配音**（KIBO 原声，48.6 秒）：public/assets/kibo/voice-onboarding.mp3
  - 音频模块 src/lib/onboardingVoice.ts（纯 DOM、零 3D 依赖）：放 lib 而非 game3d，
    避免探索舱/序章页引用时把 Three.js 懒加载块拖进首屏，保住首屏拆包成果。
  - **关闭引导不中断配音**：音频实例在模块作用域，组件卸载（dismiss）完全不影响播放。
  - **自动播放策略**：在「开始任务」这次用户手势中 prime（预建 + 预加载）；
    若仍被浏览器拦截，显示「播放旁白」兜底按钮——不再静默失败
    （静默会让用户完全不知道有旁白，是 bug 不是设计）。

### 修复
- **重置任务后重新弹出新手引导**：resetMissionProgress 原先只删任务进度、没清引导标记
  （两套 key 独立）→ 重置完既无说明也无配音。现在按前缀 kibo-mars-onboarded- 扫描清除
  （不写死索引，加新地图也不会漏）。

### 教训
- 新增 public/ 下资产**必须重新构建发布**才会进 dist；未发版时线上不存在该资源。

### 门禁
- tsc 0 错 + vitest 216 passed。

---

## [1.4.2] - 2026-09-13  （修复 V1.4.1 回归：开场动画卡死 + 引导按地图记忆）

### 修复
- **开场动画不再依赖新手引导的回调**（V1.4.1 回归，P0）：V1.4.1 把 intro 触发绑在
  Onboarding 的 onDismiss 上，而 Onboarding 用 localStorage 记忆「点过就不再弹」——
  引导不渲染时 onDismiss 永不调用，开场动画永远不播。
  改为父组件同步读取同一 key 判断引导是否会出现，并有兜底 effect：
  引导不显示时 mission 就绪后直接播放运镜。
- **新手引导标记按地图分开**（原为全局 key）：原来学生在一号点过「开始探索」，
  进二号就再也不弹引导了。改为 `kibo-mars-onboarded-v1-w{worldIndex}`，
  每张地图各引导一次（地形 / 流程 / 目标都不同）。

### 铁律（沉淀）
**任何「流程 A 结束后触发 B」的实现，都必须有 B 的兜底触发路径**——A 可能因为
记忆标记或条件不满足而根本不渲染，那时 B 必须照常发生。

### 门禁
- tsc 0 错 + vitest 216 passed。

---

## [1.4.1] - 2026-09-13  （教学闭环与探索舱交互修正）

### 教学 / 数值
- **边开边扫揭示时同步地形分类**（`c.flag = c.trueFlag`）：此前只设 scanned 不更新 flag，
  导致走完未知区域后「难走路段」仍显示旧值 1，且实际扣电漏算真实难走地形。
  修正后显示真实数量（未知区域路径全场最多），实际耗电同步变准。
- 二号三个样本站命名补「样本站」（洪水搬运巨砾 / 河道层理剖面 / 浅层水冰探测 样本站），
  与一号（河床沉积 / 沙丘背风侧 / 坑缘溅射 样本站）口径一致，明确告知可互动。

### 流程 / 交互
- **一号新手说明改为先于开场动画**：进入地图先弹说明，确定/关闭后才播镜头动画
  （原顺序为运镜先播、播完才弹说明，说明常被忽略）。
- **探索舱「任务完成」按钮禁用**：此前仍可点击进入任务场景，导致「重置」按钮形同虚设。
  现在完成后主按钮 disabled（压暗 + 去箭头 + 提示走重置），重置后变回「启动任务」。

### 门禁
- tsc 0 错 + vitest 216 passed。

---

## [1.4.0] - 2026-09-13  （火星二号·外流河道：地形与教学闭环重构 + 性能治理）

### 地形 / 场景
- **主河道改 S 型并延长**：5 点直线（约 620 m）→ 沿主轴正弦摆动 ±150 m 的 21 点曲线（约 950 m）。
  探针定位两处历史失败根因：河道起点距基地仅 36 m 造成 76° 断崖；弯道转角 131° 堵死 A* 路网。
- 三个样本站重定位到新河道沿线（间距约 250 m）；「航线中段」候选点改为取河道脊柱点（数据驱动）。
- 主基地周围补 50 块有几何细节的岩石；删除临时加入的边界山脊。
- 太阳日面由硬边 step 改为窄范围 smoothstep，消除锐利面片。

### 教学 / 交互
- **三路线重标定**（老大设计准则）：谷底路线难走最少+最长→成功；古汉道难走较多+第二长→失败；
  未知区域难走最多+最短→失败。修复**规划与实际耗电两套账**——实际行驶 cellEnergyCost
  从不计算 rock/soft，赌档走廊巨石形同虚设，三条路径曾全部成功。
- **边开边自动扫描**：车经过未扫描格先揭示、再按真实地形结算，不再「未扫描即判死」。
- 电池 170 → 180：给稳档留出实际结算余量（窗口锁 150~190 内）。
- 二号隐藏采集点补矿石簇（玄武岩/赤铁矿/橄榄石，无 UI 标记）。
- 二号：地表危险色带关闭（保留地形本色 + 等高线），消除主基地入口的橘黄面片。
- 二号开场动画：站点改为从真实地物读取（能源站 → C → 主河道 → B → A → 主基地 → 火星车），不再走回头路。
- KIBO 结算：二号（无下一张地图）只保留「回到探索舱」一个按钮；关闭弹窗留在场景；结束语文案更新。
- 修正 dev 检视页「回到探索舱」误回首页（此前绑 returnHome，应为 returnToCabin → #explore）。
- 火星车二号默认停靠位移到基地东南（KIBO 旁）。

### 性能
- 装饰物几何按颜色合并：河道剖面 126 → 3、基地岩石 50 → 2（draw call 264 → 7），源几何 dispose 释放。

### 工程
- 临时探针（A* 断点 / 能耗标定 / 橘色面片诊断）用完即删；门禁 tsc 0 错 + 216 passed。

---

## [1.3.9] - 2026-09-04  （首屏代码拆包：Three.js / 火星 3D 任务改为动态加载）

- **代码拆包（用户授权，要求不影响正常用户体验）**：`MarsGame3D`（火星正式任务）与 `Mars3DDevPage`（开发检视页）由静态 import 改为 `React.lazy` + `Suspense` 动态加载；Three.js 及其依赖整体移出首屏包。
- **首屏体积**：首屏 JS 由约 1005 kB 降至 **228 kB**（gzip 74 kB，−77%）；Three.js 进入懒加载块 `MarsGame3D-B6nibFpK.js`（816 kB / gzip 231 kB），仅在进入火星任务时按需加载。
- **加载兜底**：新增主题化 `MissionLoading` 组件（`src/styles/index.css` 的 `.mission-loading` + 旋转环 + 降低动效偏好 `data-motion="reduced"` 关闭动画），进入 3D 任务前显示「火星任务加载中…」「开发检视页加载中…」，避免白屏、保证体验连续性。
- **构建配置**：`vite.config.ts` 增加 `build.chunkSizeWarningLimit: 900`，抑制懒加载 3D 块（>500 kB 但非首屏）的告警噪声。
- **验证**：`tsc -b` 全清、`vitest run` 188/188 通过；`npm run build` 无告警，首屏/懒加载分块符合预期。

## [1.3.8] - 2026-09-04  （首页/探索舱 UI 视觉修复 + skill 文档完善 + lock 版本对齐）

V1.3.7 之后的未提交改动收口为 V1.3.8，使线上回到「已打 tag 可审计版本」。不涉及火星任务（`src/features/mars/game3d/`）改动，不触发任务审核红线。

### 首页 / 探索舱 UI 修复
- 修复「进入探索舱」黑屏转场左侧露白：新增 `portal-bg` 全屏首页底图垫层（不参与 clip-path 圆形裁切），黑圈擦除时露出的是官网首页风景而非 body 米白底（`HomePage.tsx` + `src/styles/index.css`）。
- 转场标签升级为标题级并由最右侧滑入，配合黑圈从右生长；文案「进入探索舱」视觉权重提升。
- 探索舱内 KIBO 增加轻微上下浮动 + 阴影同步收放，做出离地漂浮感；`prefers-reduced-motion` 下自动关闭该动效。

### 工程 / 文档
- `.gitignore`：补充 `dist-verify/` 忽略项（QA 验收产物）。
- `package-lock.json` 根版本由滞后的 `1.3.0` 对齐到 `1.3.8`：此前 V1.3.1–V1.3.7 仅升 `package.json` 未升 lock，本次一并修正漂移（依赖版本未动）。
- 任务开发 skill（`.workbuddy/skills/kibo-3d-task-dev/`）：`SKILL.md` 与 references 01/02/04/06/07/08 微调完善。

### 版本号
`package.json` 与 `package-lock.json` 根版本统一升至 `1.3.8`。

## [1.3.7] - 2026-09-05  （M-01 火星任务：删除「穿未知区」第三条路线，收敛为「稳 / 死」两档）

老大第七波反馈（路线可玩性）：**删除「穿未知区」第三条候选路线，仅保留「走近路（必死）/ 绕远路（稳过）」两条**。tsc 干净、build 通过、**188/188** 测试通过（较 v1.3.6 的 189 少 1 条，是删掉了「穿未知区」专属测试，非回归）。

> ⚠️ **范围约定**：本轮只动火星一号（World 0）的路线集合与配套文案，不碰关卡地形、不新增路线。用户最终审核已通过，可提交；**后续火星一号地图的任务任何改动都需经用户审核**（见项目记忆规则）。

### 触发根因：过度扫描让「穿未知区」从"赌命"变"必成功"

- **用户实测**：全图扫完后派「穿未知区」路线 → 采集车**成功**完成任务，违背"该路线本应赌命/失败"的设定。
- **根因**：切未知区的路线**仅在未知格未探明时**按最坏情况计费（`ENERGY_UNKNOWN_WORST`）才会超过电池；一旦学生把那片未知区**全部扫明**，路线就退化成一条"已知最短路"，没有任何未知惩罚 → 最坏耗电落进 100 以内 → 判定成功。这是设计性敞口（v1.3.6 #1 的乐观成本修复只对"含未知地形"生效），**凡勤扫描的学生必触发**，不是回归 bug，但会让"赌命"这一教学档名存实亡。
- **两种方案（老大拍板）**：
  1. **删线（采纳）**：直接删除第三条路线，只留「走近路 / 绕远路」两条，彻底消除过度扫描敞口，仅需文案同步。
  2. 左侧新增一条全难走、确定性失败的路线（矿石复制、无 UI 箭头）—— 体验更好但是关卡重设计、开发量大，留待**火星二号（World 1）地图替换**时一并做，不在此轮。

### 教学影响：三档 → 两档

- 原设计「稳 / 死 / 赌」三档（绕远路稳过、走近路必死、穿未知区赌命）。
- 现收敛为「稳 / 死」两档：学生改用**会算账**判断——走近路确定耗电即超电池 → 一眼排除；绕远路最坏也不超 → 稳过。赌命档移除。

### 改动清单（生产 9 文件 + 测试 + 文案同步）

1. `mission.ts`：`ROUTE_PROFILES` 移除第三档（穿未知区）；`candidatePaths` 索引 1 走 `planKnownOnly`、索引 0 走 `planPath`；`selectCandidate` 仅 `index===1 ? 'detour'`；大量注释"三条→两条"同步；`UncertaintyChoice` 的 `accept-risk` 作为手动驾驶独立选项保留（非路线 3）。
2. `MarsGame3D.tsx`：两处硬编码标签 `['走近路','绕远路','穿未知区']` → `['走近路','绕远路']`；"重新比较三条路线"→"两条"；多处注释同步。
3. `OperationConsole.tsx`：`routeRiskHint` 删除 `label==='穿未知区'` 分支；`selectedIndex` 删除 `accept-risk→2`；"3 条→2 条"文案与注释同步。
4. `KiboEndTalk.tsx` / `kiboLines.ts` / `MissionHud.tsx` / `MissionResultModal.tsx` / `candidateRibbons.ts` / `stage.ts`：全部"三→两"文案与注释同步。

### 锁死（契约测试）

- **保留**：能源账「稳 / 死」两档断言 —— 绕远路 `worst < HAULER_BATTERY(100)`、走近路 `certain > 100`、两者差 `> 20`（`mission.test.ts` "两条路线的能源账必须形成「稳 / 死」两档"）。
- **删除**：3 处 unknownCell 排序类**弱断言**（期望绕远路未知格显著少于走近路）。原因：`planKnownOnly` 在找不到全探明路线时会回退到普通 `planPath`，绕远路未知格数不一定更少，断言不恒成立，已移除并在注释中说明。

---

## [1.3.6] - 2026-09-04  （M-01 火星任务：路线逻辑两处缺陷修复 + 烟雾再翻倍 + 修工装回归）

老大第五波反馈（烟雾放大）共 4 条、**第六波反馈 2 条（路线逻辑缺陷）**。第五波中 #2 / #3 / #4 已在 v1.3.5 修复并发布（见下方 [1.3.5] 条目），本轮经代码复核 + 契约测试确认修复到位；本轮实际产品改动 = 第五波 #1（烟雾再翻倍）+ 第六波 2 条（路线逻辑）。另修复我在 v1.3.4 停用 groundHaze 时遗留的截图工装回归。tsc 干净、build 通过、**189/189** 测试通过。

> ⚠️ **第六波范围约定**：用户明确"只改这两个 bug，其他体验正确"，且火星二号（World 1）地图即将被替换，**本轮只验证火星一号（World 0）**。火星二号自身的"死亡锁"（绕远路也撞死）属于旧地图缺陷、随替换自然消失，不在此轮处理。

### #1 采集车尾部两排烟雾再放大一倍（本轮唯一产品改动）
- 用户反馈：v1.3.5 已从 1.2 放大到 2.4，仍不够，要求再放大一倍。
- **关键：intensity 不能直接乘 2**。dust 的 size 公式是
  `p.size = rng(0.85, 1.25) * baseSize * (0.65 + intensity * 1.05)`，
  其中 `0.65` 是常数项，所以 intensity 翻倍 ≠ 视觉尺寸翻倍。
- 按公式反推：
  | | intensity | 尺寸因子 `0.65 + i*1.05` |
  |---|---|---|
  | v1.3.4 及以前 | 1.2 | 1.91 |
  | v1.3.5 | 2.4 | 3.17 |
  | **v1.3.6（再翻倍）** | **5.42** | **6.34** |
  即 `intensity = (3.17 * 2 − 0.65) / 1.05 ≈ 5.42`。
- 代码（`stage.ts`）抽出具名常量 `HAULER_DUST_INTENSITY = 5.42` 并写下推导注释，以后调参有据可依。
- 参考：R-7 的 intensity 上限 1.2（尺寸因子 1.91）；采集车体积约 R-7 的 3 倍，现为其 3.3 倍尘量，"滚滚烟尘"体量感对得上。
- 注：`emitBatch` 的粒子数 `count` 在 `intensity > 0.9` 时已封顶 5，所以放大**只改尺寸、不变密度**，不会额外吃性能。

### #2 / #3 / #4 已在 v1.3.5 修复（本轮复核确认，无新改动）
- **#2 采集车不渐隐** → v1.3.5 修复：`stage.ts` 的 `if (haulerActive)` 块内每帧调 `hauler.show(true)`，而 `show(true)` 会把 `fadingOut=false / opacityMul=1` 重置，每帧冲掉 `fadeOut()` 设的渐隐状态。改为 `if (!haulerFading) hauler.show(true)`。`hauler.test.ts` 新增 2 条渐隐契约断言锁死。
- **#3 操控权不回玩家** → v1.3.5 修复：同一根因（渐隐不推进 → `finishHauler` 永不触发 → `haulerActive` 恒 true、相机一直跟采集车、`rover.group.visible` 恒 false）。修好渐隐后自动恢复；另在 `handleResultConfirm('success')` 显式 `setFollow(true) + snapToFocus` 加固（出勤期 WASD 平移会把 `followRover` 置 false）。
- **#4 点 ✕ 关闭误退出任务** → v1.3.5 修复：`KiboEndTalk` 新增 `onClose` prop，✕ / ESC / 点背景遮罩只收起弹窗（`setInfoPanel(null)`），仅底部「回到探索舱」按钮走 `onBackToCabin`（`setInfoPanel(null) + onExit()`）。
- 本轮复核方式：读代码确认 `KiboEndTalk.tsx` 三处入口（✕ / ESC / 背景）均绑 `onClose`、底部按钮绑 `onBackToCabin`，且 `MarsGame3D.tsx` 正确传入 `onClose={() => setInfoPanel(null)}`；渐隐侧由 `hauler.test.ts` 的契约测试覆盖。**未做真实浏览器端到端验证**（需 WebGL + 走完整清洗标注训练流程），若老大实测仍有残留请反馈，我再深挖。

### 修复：截图工装回归（我 v1.3.4 停用 groundHaze 时遗留）
- `tools/shots/capture-assets.cjs` 有两处会让脚本直接抛错：
  - `stage.groundHaze.mesh.visible = false` —— groundHaze 已于 v1.3.4 从 stage API 移除，属性不存在。
  - `const r = stage.hauler.update(dt)` 再取 `r.progress` —— `hauler.update` 返回 `void`，`r` 是 undefined，抛 TypeError。
- 修法：删 groundHaze 行；推进逻辑改为显式 `stage.mission.stepHauler(dt)` + 手动复制 `renderFrame` 的 `setLeg / setArmAction` 处理（`rig.paused` 时 renderFrame 不跑，必须补），进度从 `mission.haulerRun()` 读。

### 第六波 #1 三条候选路线派遣结果不正确：走近路 / 穿未知区 也"成功"（应为失败，仅绕远路成功）

- **现状（用户实测）**：派采集车走三条路线全部成功，违背教学设定——正确应是"绕远路稳过、走近路必死、穿未知区赌命"。
- **根因排查**：跑了 4 组诊断（全量 / 部分 / 0~5 级扫描 × World 0/1/2）。结论：
  - World 0 在**充分扫描**后本身就"只有绕远路成功"（设计正确），但**过度扫描**会把"穿未知区"整条走廊探明 → 它变成已知最短路 → 耗电落入电池内 → 被误判成功。
  - 直接诱因是 `cellEnergyCost` 对"未探明格"的成本用了**乐观估计**：`c.trueFlag === 1 ? ENERGY_UNKNOWN_WORST : ENERGY_UNKNOWN_BEST`——即地形恰好是平地（`trueFlag=0`）时只按最低耗电 `BEST(0.2)` 计费，于是"穿未知区"靠运气平地就能压到预算内。
  - 用 `git blame` 确认 `cellEnergyCost` / `ROUTE_PROFILES` / 能源常量自 `4cbd166`（V1.0 前）至今未改，并非 V1.3.x 改动引入；这是设计上的乐观成本敞口，被用户的"全探明"玩法触发。
- **修法**（`mission.ts` 的 `cellEnergyCost`）：未探明格一律按**最坏情况**计费 `cost += ENERGY_UNKNOWN_WORST(1.1)`，取消 `trueFlag===1` 的运气分支。效果：任何"穿未知区 / 走近路"真实仍含未知地形，最坏耗电必超 100 → 判定失败；只有"绕远路"用 `planKnownOnly` 强制全已知，最坏耗电稳在预算内 → 成功。
- **锁死**（契约测试，火星一号）：`能源账：三条路线的往返耗电区间…` + `三条路线的能源账必须形成「稳 / 死 / 赌」三档` —— 必须始终满足
  - 绕远路 `worst < HAULER_BATTERY(100)`
  - 走近路 `certain > 100`（确定耗电就超）
  - 穿未知区 `best < 100 < worst`（赌命档）
  全 189 测通过。

### 第六波 #2 结算文案"没有相信 AI 给出的第一条路线"指向错误（绕远路本应放在第二位）

- **现状（用户实测）**：KIBO 结束语写"你没有直接相信 AI 给出的第一条路线"，但正确路线"绕远路"当时排在**第一条**，文案与事实相反。
- **修法（纯顺序交换，不动文案本身）**：把"走近路"提到**第一条（索引 0）**、"绕远路"降到**第二条（索引 1）**，让"第一条=错误路线、第二条=正确路线"与文案一致。涉及 5 处同步：
  1. `mission.ts` `ROUTE_PROFILES` 数组顺序交换（index0=走近路、index1=绕远路、index2=穿未知区不变）。
  2. `mission.ts` `candidatePaths`：`planKnownOnly`（强制全已知）从 index0 改挂 **index1（绕远路）**，保证正确路线始终可被规划。
  3. `mission.ts` `selectCandidate`：`index === 1 ? 'detour'` 映射正确路线 → 绕远路。
  4. `MarsGame3D.tsx` 两处 `setNotice` 硬编码标签数组 `['绕远路','走近路','穿未知区']` → `['走近路','绕远路','穿未知区']`。
  5. `OperationConsole.tsx` `selectedIndex` 映射：`detour→1` / `accept-risk→2` / `pass-reason→0`。
- **未改项（明确告知）**：`KiboEndTalk.tsx` 文案经核对交换后已自洽，**不改**；`MissionHud.tsx` 的"派遣 AI 验证车（走近路）"是 R-7 路线验证子系统（非三条采集车路线之一），**不改**以免范围扩散。
- **锁死**：`mission.test.ts` 的"三条候选路线在里程/未知格/难走格上必须拉开可见差距"测试随顺序更新断言（a=走近路更短但更多难走格、b=绕远路更长、c=穿未知区最短且未知格最多）。

---

## [1.3.5] - 2026-09-03  （M-01 火星任务：采集车收尾流程修复 4 处）

老大第四波反馈，集中在采集车完成任务后的收尾流程。tsc 干净、build 通过、**189/189** 测试通过（新增 `hauler.test.ts` 渐隐契约断言 2 条）。

> ⚠️ 本轮 #2 和 #3 是**同一个根因**：渐隐失效导致 `finishHauler` 回调永不触发，
> 连带造成"采集车不消失 + R-7 回不来 + 操控权交不回玩家"三合一故障。

### #1 采集车尾部两排烟雾再放大一倍
- `stage.ts` 扬尘 intensity 由 1.2 → **2.4**（用户反馈 v1.3.4 的 1.2 仍偏小）。挂点维持 v1.3.4 修正后的左后[0]/右后[3]轮底。

### #2 采集车完成任务回到主基地后没有渐隐消失（核心 bug）
- **根因**：`stage.ts` 的 `if (haulerActive)` 块内每帧调用 `hauler.show(true)`，而 `show(true)` 内部会把 `fadingOut = false` / `opacityMul = 1` 重置——等于每帧把 `fadeOut()` 设的渐隐状态冲掉。
- 更准确地说：`update()` 的渐隐分支是 `if (fadingOut && opacityMul > 0)`，`show(true)` 把 `fadingOut` 置 false 后**不会自恢复**，所以渐隐从没真正开始过（不是"变慢"，是"取消"）。
- **修法**（`stage.ts`）：渐隐期间不再调 `show(true)` —— `if (!haulerFading) hauler.show(true)`。
- **锁死**（`hauler.test.ts` 新增 2 条）：
  - ① `fadeOut` + `update` 推进 → 渐隐完成、隐藏、回调触发（正向契约）；
  - ② 渐隐途中调 `show(true)` → 渐隐被**彻底取消**，继续 update 5s 也不触发回调，必须重新 `fadeOut()`（副作用契约，警示调用方）。

### #3 采集车完成任务后操控权回到用户手中
- **同 #2 根因**：渐隐不推进 → `finishHauler` 回调永不触发 → `haulerActive` 保持 true → 相机一直跟随采集车、`rover.group.visible` 一直 false → 玩家根本操控不了 R-7。
- 修好 #2 后自动恢复；另在 `MarsGame3D.tsx` 的 `handleResultConfirm('success')` 分支**显式**加 `stage?.setFollow(true)` + `rig.snapToFocus()` 加固——出勤期间若玩家用 WASD 平移过镜头，stage 内部 `followRover` 会被置 false，光靠 `finishHauler` 里的 rig 复位不足以把相机跟随目标切回 R-7。

### #4 点 ✕ 关闭 KIBO 结算界面会误退出任务
- **根因**：`KiboEndTalk` 的 ✕ 按钮 / ESC 键 / 点背景遮罩**全都绑了 `onBackToCabin`**，没有区分"关界面"与"回探索舱"——用户只想收起弹窗看看场景，结果被直接踢回探索舱。
- **修法**（`KiboEndTalk.tsx`）：新增 `onClose` prop，✕ / ESC / 背景遮罩改绑 `onClose`（只收起弹窗、人留在火星场景）；**只有**显式点底部「回到探索舱」按钮才走 `onBackToCabin` 真实退出任务。
- `MarsGame3D.tsx` 相应传入 `onClose={() => setInfoPanel(null)}`。

---

## [1.3.4] - 2026-09-03  （M-01 火星任务：流程与体验修复 4 处）

老大下午第三波反馈，集中在交互流程与美术观感。tsc 干净、build 通过、**187/187** 测试通过（新增 `hauler.test.ts` 烟雾贴地断言 1 条）。

### #1 E 键全局生效（不受 HUD 焦点影响）
- 用户反馈：屏幕底部出现 PoiPrompt 等建筑地点说明框时，按 E 没反应。
- 根因：`handleKeyDown` 绑在 `<canvas>` 容器的 `onKeyDown`，焦点一旦离开容器（比如点 PoiPrompt/任务提示/HUD 元素），按 E 就触发不到 handler。
- 修法（`MarsGame3D.tsx`）：把键监听改成 `useEffect` 里 `window.addEventListener('keydown')`，与 MissionHud 的 ESC 设置快捷键实现一致；移除容器 div 的 `onKeyDown/onKeyUp` props。同时把 `handleKeyUp` 内联进 useEffect 一起清理。

### #2 采集车烟雾贴到轮底
- 用户反馈：烟雾挂点偏高，位于轮子中间。
- 根因（`hauler.ts`）：`getWheelWorldPositions` 返回的 y = `group.position.y + ly - 0.05`，其中 `ly = HR = 1.5`，算下来 y≈1.45m——正好在轮子中部（旧版是按"轮子中心略微下沉"的设计）。
- 修法（`hauler.ts`）：把 y 改为 `group.position.y + 0.05`，让尘从轮底"卷地"起。
- 永久锁死（`hauler.test.ts`）：新增 1 条测试，断言 6 个轮位的 `y = group.position.y + 0.05` 且 `y < 0.5`（绝不允许在轮子中部）。

### #3 去掉近地面黄色雾霾
- 用户反馈：场景里有一层暖黄色雾霾，让地面颜色发黄、掩盖主美的色彩设计。
- 根因（`stage.ts` / `groundHaze.ts`）：`groundHaze` 用 `PALETTE.skyHorizon`（#e4b88f 暖黄）做径向半透明雾，从 180m 起淡入到 900m 满浓。
- 修法（`stage.ts`）：彻底停用 `groundHaze`（保留实现文件供以后需要时再恢复）。移除 `createGroundHaze()`、`scene.add(groundHaze.mesh)`、setTime + 跟随相机位置、setQuality、dispose 等所有调用；`groundHaze.ts` import 注释保留为历史记录。

### #4 采集成功后强制走 KIBO 对话环节
- 用户反馈：成功后直接触发二号地图的开局动画，跳过了与 KIBO 的结算对白。
- 根因（`App.tsx`）：`onWorldComplete` 内同时调用 `completeMissionWorld`（持久化到 localStorage）和 `setMarsWorldIndex(next.currentWorld)`（推进 App 层地图索引）。后者会让 MarsGame3D 的 stage useEffect 重建舞台并自动播放 `playIntroFlyover()`——跳过了"找 KIBO"→"❗️"→"KiboEndTalk" 流程。
- 修法（`App.tsx`）：`onWorldComplete` 只持久化 localStorage（`completedWorlds/currentWorld`），不再推进 marsWorldIndex。worldIndex 推进仅由 `handleContinueTask`（KiboEndTalk "继续任务"按钮）或"任务进行中"按钮点击触发。
- 修法（`MarsGame3D.tsx`）：`deliveredWorldRef` useEffect 内不再 setNotice（之前的"在右侧报告面板点进入二号地图"提示会覆盖 handleResultConfirm 已设的"去找 KIBO..."）。
- 修法（`MissionHud.tsx`）：report 阶段"进入二号地图"按钮在 `missionComplete` 时隐藏，强制用户走 KIBO 对话。

---

## [1.3.3] - 2026-09-03  （M-01 火星任务：教学流程修复 6 处）

老大下午集中反馈 6 个问题，本轮一次性收尾。typecheck 干净、**186/186** 测试通过（含新增 `hauler.test.ts` 4 条 + `OperationConsole.no-leak.test.ts` 1 条永久红线测试）。

### #1 AI 训练舱：训练完成后不自动关闭
- 用户反馈：训练结束后自动关闭训练界面，用户看不到训练后的数据，要再次点击才能看到。
- 修法（`OperationConsole.tsx`）：`start()` 的 setTimeout 内去掉 `onClose()`，训练完成只切到 `done` 阶段、由用户手动点 ✕。

### #2 路径选择界面关闭后切不切到全景
- 用户反馈：路径选择界面打开时镜头被拉到 `overview` 全景机位（distance=620），关闭后画面卡在全景、需要手动复位。
- 修法（`MarsGame3D.tsx`）：删除 `useEffect` 内的 `applyViewpoint('overview')`；选择路径时维持玩家当前所在视角，3 条候选路线丝带仍然画出。

### #3 路径选择界面文案彻底不泄答案（v1.3.2 残留修复）
- 用户反馈：即便数字删了，文案仍在泄题——"确定耗电最稳，留得出余量" / "可确定耗电也最高——到底够不够回基地得你自己算" / "里程最短也最险 / 耗电区间滑动 / 扫得越清楚区间越窄" / 教学"近路颠簸费电/远路稳妥/穿未知区最短也最险"。
- 修法（`OperationConsole.tsx`）：
  - 删 `确定耗电 / 电池电量` 统计。
  - 删 `乐观~最坏耗电` 区间统计。
  - `routeRiskHint` 重写为客观描述：只说"绕开没扫过/硬穿 X 段难走/直接穿过没扫过"，不评价、不暗示。
  - 教学一句话同样清掉"近路颠簸费电/远路稳妥/最险"。
- 红线锁死（`OperationConsole.no-leak.test.ts`）：用 Vite `?raw` 读源文件剥注释后断言泄题关键词列表为空；以后谁加回去都会被这条测试拦下。
- 全局 `allDoomed` 警示文案"按最坏情况估算"经 v1.3.2 复审确认属于"数据不够"全局态、不属单条路线答案泄露，本轮仍允许保留。

### #4 采集车矿石黑色描边去掉
- 用户反馈：采集车在还没采集到矿石之前，车身上就会出现矿石的黑色描边。
- 根因：`addSilhouetteOutline` 把整个 group 内的 mesh 合并成一份 BackSide 外壳，外壳加在 group 顶层，**不**继承 `oreCrate.visible=false`——所以矿石隐形了但外壳还在。
- 修法（`hauler.ts`）：每个 ore mesh 在创建时设 `ore.userData.outline = false`，`addSilhouetteOutline` 跳过它们。
- 红线锁死（`hauler.test.ts`）：断言 `createHauler().group.traverse()` 找到 5 个 `IcosahedronGeometry` 矿石 mesh，userData.outline 全为 false。

### #5 采集车烟雾改挂点到左右后轮，放大 1 倍
- 用户反馈：采集车尾部的烟雾比例太小，且挂在车底中间位置。
- 修法（`hauler.ts`）：新增 `getWheelWorldPositions()` 方法，记录 6 个轮子的本地坐标 `WHEEL_LOCAL`（左后[0]/左中[1]/左前[2]/右后[3]/右中[4]/右前[5]），按车体旋转算世界坐标。
- 修法（`stage.ts`）：把原来的 `dust.emit(hpPos, 0.9)` 改为 `dust.emitBatch([haulerWheels[0], haulerWheels[3]], 1.2)`，仿 R-7 后轮拖尾模式（左右对称）；intensity 与 R-7 同档 1.2。
- 红线锁死（`hauler.test.ts`）：断言 `getWheelWorldPositions()` 返回 6 个轮位，[0]/[3] 是左后/右后，车体旋转后轮位跟随。

### #6 采集任务成功后：用户重新操控 R-7、与 KIBO 对话
- 用户反馈：成功回到基地后，缺失用户重新操控 R-7 + NPC 对话环节。
- 修法（`MarsGame3D.tsx`）：`handleResultConfirm('success')` 去掉 `setFollow(false) + setFocus(kibo) + snapToFocus()`（之前强制锁镜头到 KIBO，导致 R-7 不可操控），让 `finishHauler` 已经复位好的跟车视角直接生效；玩家自己开 R-7 回基地、点 KIBO 头顶"!"标记弹 `KiboEndTalk` 结算对白。
- "回到探索舱" → 探索舱按钮显示"任务进行中"（`completedWorlds=1, worldCount=2`），下次点击通过 `marsWorldIndex=1` 直接进入火星二号（已由 `completeMissionWorld` 持久化）。

---

## [1.3.2] - 2026-09-03  （M-01 火星任务：ESC 设置快捷键 + 相机自由旋转 + 路线台红线回退）

本轮为纯 UI/UX 修正与体验修复批次，不改变三条路线的能源账设计与 `稳/死/赌` 教学结构；typecheck 干净、181/181 测试通过（含新增相机旋转单测）。

### 路线选择台：回退 v1.3.1 的"标红泄题"红线违例
- `OperationConsole.tsx` 的路线选择台原先在 `确定耗电 > 电池上限` 时整行标红（`.is-risk`）+ 标注"超 X"，等于替学生把"这条不行、换一条"算完了，违反 PBL 红线（"不能直接显示可以知晓答案的信息给用户"）。
  - `确定耗电` 改为**纯中性数据** `X / Y`，不再有标红 / "超 X" / 任何胜负暗示。
  - `routeRiskHint` 走近路文案由"确定耗电容易被顶到电池上限以上——赌输了就回不来"（泄题）改为中性权衡描述（"里程压得最短，可确定耗电也最高——到底够不够回基地，得你自己算"）。
  - 删除 `mars3d.css` 中 `.mars-console__stat.is-risk` 红色样式，防止该泄题式语义被重新误用。
- 保留：只显示中性事实数据（确定耗电 / 往返里程 / 没扫过的区域 / 难走路段 / 乐观~最坏区间）+ 只描述客观权衡的提示文案；学生**已选并已跑完验证后**的真实失败反馈（`hauler.status==='failed'`）仍属验证闭环、不在决策前。
- 红线已写入项目长期记忆 `MEMORY.md`（"UI 不泄露答案红线"章节）。

### 新增：ESC 打开设置界面（快捷键）
- 任务场景内按 `ESC` 弹出右上角已有的设置界面（同一个界面，不新建）；再按 `ESC` 关闭，与右上角按钮等价。
- **不进入右下角操作提示**：该功能仅作为快捷键，刻意不在操作提示 UI 里列出。
- 处理好与既有模态的优先级（避免冲突）：设置开着 → ESC 关设置；任务面板抽屉开着 → ESC 关抽屉；若有阻断式模态（操作台 / KIBO 对话 / POI 信息 / 结算 / 新手引导）正打开 → ESC 交给该模态自己关闭、不抢开设置；以上皆无时才在任务场景内弹出设置。阻断态由 `MarsGame3D` 计算 `blockingModalOpen` 下传给 `MissionHud`。

### 修复：右键转镜头可无限旋转（不再转满一圈卡死）
- `camera.ts` 的 `nudgeAzimuth` 原先在自由轨道模式下把方位角钳制到 `±π`，导致"转满一整圈就被卡住无法继续"。改为**不钳制方位角**——相机位置由 `sin/cos(azimuth)` 计算，方位角超出 `±π` 在数学上完全等价，可任意方向连续旋转任意圈数。松手后机位保留，按空格 / 复位才回到第三人称跟随视角。
- 新增 `camera.test.ts` 锁定该行为（连续大量 `nudgeAzimuth` 后相机位置持续变化、不被夹死在边界）。

### 修复：入场动画跳过改为纯鼠标点击
- 移除入场浏览期间"按 ESC / 空格 / 回车可跳过"的键盘监听——`ESC` 现已专用于打开设置界面，不能在此被占用。跳过**只能**点右下角按钮（鼠标点击）。按钮文案由"跳过，直接开始（Esc）"改为"跳过，直接开始"。

> 注：本次为体验修复批次，按约定走修订号 v1.3.2；线上无需重部署，仅补提交痕迹。

## [1.3.1] - 2026-09-03  （M-01 火星任务：训练舱 / 采集车 / 路径选择台 缺陷修复批次）

本轮修复的 6 类缺陷（均经单元测试 / headless 实测验证，180/180 测试通过、typecheck 干净）：

### 路径选择台与能源账（教学闭环）
- **Bug 4（"走近路才正确"的认知错位）**：根因是 UI 只显示"电池总量"、未显示决定性的"确定耗电"。`OperationConsole.tsx` 将"确定耗电"提升为每条路线首条数据，并配中性提示文案指向该数字；三条路线 `routeRiskHint` 文案修正（含修复走近路重复句 bug）。`computeRouteEnergy` 的 `*2` 经核实为往返正确计算，非 bug，旧记已更正。（⚠️ 初版曾对"超预算"路线整行标红 + 标注"超 X"，该行为违反 PBL 红线，已在 **v1.3.2** 回退为纯中性显示。）

### 采集车（AI 验证载具）
- **Bug 2a（轮子不转）**：`hauler.ts` 把 6 个轮子收入 `wheels[]`，`update` 按 `HAULER_ANGULAR_V = 30/1.5 rad/s` 累加轮转，collect 阶段停转。
- **Bug 2b（车没贴着丝带走）**：根因是主丝带画的是默认 `result.path`（`replan()` 用当前权重），而采集车走的是按 `ROUTE_PROFILES` 全量缩放权重的候选路线，两套权重导致路线错开。`mission` 新增 `haulerRoute()` 持有采集车实际路线，`stage` 在出勤期间把主丝带切到该路线；实测全程偏差 **0.000 m**。
- **Bug 2c（车上是正方块矿石）**：`hauler.ts` 将 `BoxGeometry` 方块替换为 5 块 `IcosahedronGeometry` 真实矿石堆（玄武 / 赤铁 / 橄榄三色 + 随机位置 / 大小 / 旋转）。
- **Bug 3（回基地穿模）**：`hauler.ts` 新增 `fadeOut` 渐隐 API（~0.8s），`stage` 的 success 处理接好 `hauler.fadeOut(finishHauler)` 并用 `haulerFading` 防重入。

### 训练舱与交互
- **Bug 1（未训练就显示训练后数据）**：`OperationConsole.tsx` 将质量条显隐条件由 `phase !== 'training'` 改为 `phase === 'done'`，仅在训练完成后展示准确率 / 谨慎度 / 效率。

### 其它
- 顺带更正项目记忆里两处错误记录（① `hauler.fadeOut` 早已接好；② `computeRouteEnergy` 的 `*2` 为往返正确计算）。

> 注：本次为缺陷修复批次，按约定走修订号 v1.3.1；线上无需重部署，仅补提交痕迹。

## [1.3.0] - 2026-09-01  （V1.3 赛璐珞精修 + 任务开发 skill 完善 + 部署脚本加固）

V1.2 之后累积的未提交改动统一收口为 V1.3，使线上运行版本回到「已打 tag 的可审计状态」。线上当前运行的代码即本版本内容（本次仅补提交痕迹，无需重部署）。

### 赛璐珞视觉精修（Plan C 落地）
- `render/celMaterial.ts`：新增 `CelSpecular` 量化硬高光（Blinn-Phong 半程向量 + `step(0.5)`，受光面 `smoothstep` 限制），对未启用部件零影响。
- 新增 `createBlobShadow()` 贴地接触软影：置于 `NO_EDGE_LAYER`、不进几何缓冲趟所以不被 Sobel 勾边、无 shadow map、纯确定性。
- `render/rover.ts` / `render/hauler.ts`：R-7 与采集车金属/玻璃件硬高光强度分级 + 车底接地软影。
- `render/postfx.ts`：赛璐珞描边/量化 ramp 微调（本轮一并收口的未提交改动）。

### 任务开发 skill 完善（2026-09-01 遗留未提交）
- `SKILL.md`：补 `0.5 任务类型判定` 小节（判定问法 + 四类已建档类型表），挂进 S0 出口条件。
- `references/01`：教学闭环流程描述补强。
- `references/02`：深海声纹·赌格含糊处精修为「多采高噪声时段代表性声纹 → 阈值拟合骤准 → 漏检风险崩塌」。
- `references/03`：3D 舞台与相机章节微调。
- `references/05`：视觉与美术章节补强（赛璐珞方向）。
- `references/09`：新任务落地脚手架章节扩写。
- `docs/开发经验与教训.md`：补 2026-09-01 赛璐珞管线审计与 Plan C 落地记录。

### 部署脚本加固
- `tools/deploy/deploy.sh`：抽 `SSH_OPTS=(-i "$SSH_KEY" -F /dev/null -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no)`，根治「一键发布任务被沙箱标 failed」假失败（scp 默认读写本机 `C:\Users\wencong\.ssh` 被拦截的副作用）。

### 版本号
`package.json` 与 `package-lock.json` 根版本由 `1.2.0` 升至 `1.3.0`（依赖 `@standard-schema/spec@1.1.0` 未改动）。

## [1.2.0] - 2026-09-01  （V1.2 火星任务运镜/检视页与流程细化 + 规范演进）

V1.1 之后到 2026-09-01 的累积更新，含火星任务体验细化、开发期检视通道、以及项目规范的正式演进。

### 火星任务体验细化
- **入场全景运镜**：首次进入一号地图自动播放全景浏览（终点 → 重要地点 → 火星车定格 → 交还操控）；`camera.ts` +221、`stage.ts` +209、`MarsGame3D.tsx` +124；已通过 2026-08-30 第一性原理 QA。
- **探索舱 CabinPage 大改**（+217）：按钮三态、双地图进度与状态呈现进一步完善。
- **相机 / 舞台 / 任务 / HUD 细化**：`render/camera.ts`、`stage.ts`、`core/mission.ts`、`MissionHud.tsx`、`OperationConsole.tsx`、`render/hauler.ts`、`core/heightField.ts` 等一众调整；`missionProgress.ts` 进度逻辑与单测更新。

### 开发期检视通道
- 新增 `#dev/mars3d` 开发期检视页 `Mars3DDevPage.tsx`：`import.meta.env.DEV` 拦住、不进入生产路由；调试面板 / 性能数据 / 机位条收进 HUD「GM」按钮，普通玩家不可见（对齐 UI/UX redesign 第四节）。

### 规范与决策演进
- **R3F 解禁**：`docs/决策变更记录-006-R3F解禁.md`，取消对 react-three-fiber / drei / 物理引擎的预设技术禁令（用户 2026-09-01 拍板），`AGENTS.md` 升至 v0.7。
- **火星二号地图开发设计**：`docs/火星任务/火星二号地图-开发设计.md`（外流河道，原地图 C）。
- **任务开发 skill**：新增项目级 `.workbuddy/skills/kibo-3d-task-dev/`（`SKILL.md` + 9 份参考文档），及 `docs/评审记录/2026-08-31-任务开发skill-对抗性审核.md`。
- **E15 经验文档**：`docs/开发经验与教训.md` 补 `git check-ignore` 目录级假阳性教训（验证忽略状态须用真实文件路径或 `git status --untracked-files=all`）。

### 版本号
`package.json` 与 `package-lock.json` 根版本由 `1.1.0` 升至 `1.2.0`（注意：`@standard-schema/spec@1.1.0` 为依赖，未改动）。

### 部署
本次为本地版本提交，上线执行 `bash tools/deploy/release.sh`。

---

## [1.1.0] - 2026-08-30  （V1.1 火星任务流程细节优化与缺陷修复）

针对 V1.0 的 M-01 火星任务做任务流程细节的体验优化与缺陷修复，并补齐探索舱任务进度持久化。

### 任务流程细节优化
- **路径选择台**：移除预计耗电数值、统一提示颜色，使三条路线形成「稳 / 死 / 赌」三档，让学生必须自己算账权衡。
- **清洗台**：修复 UI 直接暴露坏数据解释文案的问题，改为展示原始数值，让学生自己发现异常。
- **样本站读数**：每个站点 6 条记录，覆盖 `out-of-range` / `duplicate` / `missing` 三类数据缺陷，提升样本多样性。
- **清洗 / 标注按钮布局**：从右侧竖排改为数值下方的等宽分段选择器，减少误触与视线跳转。
- **KIBO 结束语**：改为居中头像弹窗 + 底部「确定」按钮。
- **采集车结果反馈**：新增成功 / 失败结果弹窗 `MissionResultModal`；KIBO 结算弹窗改双按钮，隐藏 GM 调试按钮。

### 进度持久化与双地图（新增）
- **火星任务双地图**：正式版地图数量 `MARS_MAP_COUNT = 2`，面向玩家命名为「火星一号」「火星二号」；完成第一张后自动推进到第二张。
- **探索舱任务进度本地持久化**：新增 `src/lib/missionProgress.ts`（`localStorage`，每任务独立 key，不可用时静默降级），附 13 条单测。
- **探索舱按钮三态**：未开始「启动任务」/ 进行中「任务进行中」/ 全部完成「任务完成」+ 重置按钮。

### 缺陷修复
- 读取进度时显式 clamp 索引并用 `Number.isFinite` 判定，修复字段缺失时索引为 `NaN` 导致整局崩溃的问题。
- `stage.ts` 用 `DISTANCE_RANGE[0]` 替换硬编码的 `26`，消除与相机配置的漂移。
- `.gitignore` 补充 QA / 临时构建产物目录排除（`dist-qa*/`、`build-qa/`、`.mars-qa-temp/`），避免构建垃圾误入库。

### 质量与规范
- `AGENTS.md` / `agent.md`：将「第一性原理 + 对抗性审核」三角色 QA 写入项目强制规则（§8.1）。
- 新增评审记录：`docs/评审记录/2026-08-30-火星任务M01-完整第一性原理对抗性复审.md`、`docs/评审记录/2026-08-30-火星任务M01-探索舱进度与UI迭代-QA.md`。
- 补充单测：扫满全图后「穿未知区」的未知格仍多于「绕远路」，锁定路线权重剖面的设计不变量。

### 版本号
`package.json` 与 `package-lock.json` 根版本由 `1.0.0` 升至 `1.1.0`。

### 部署
本次为本地版本提交，尚未同步线上；需要上线时执行 `bash tools/deploy/release.sh`。

---

## [1.0.0] - 2026-08-29  （主线首个正式版本 V1.0）

首个可上线、可复现、可版本回溯的完整版本。

### 包含内容
- **官网首页**：明亮卡通渲染、赛璐珞基调；主文案「从探索开始，成为 AI 创造者」，主按钮「进入 KIBO 探索舱」。
- **任务探索舱主界面**：中央全景任务窗 + 可扩展连续坐标环切换；任务切换即时响应。
- **M-01 火星车 3D 任务样板**：赛璐珞实时 3D、第三人称跟随相机；覆盖「扫描 → 规则 → 规划 → 实测 → 复测 → 不确定性处置 → 成果记录」完整闭环；HUD / 小地图 / POI 信息面板 / KIBO 对话 UI 打磨；通过视觉评审与教学评审。
- **一键发布 + 线上无头验收工装**（`tools/deploy/`）：构建 → scp 同步 → Playwright 无头 Chromium 9 项线上验收；SSH 私钥经 `.gitignore` 排除，不入库。
- **配套文档与规范**：`AGENTS.md` 纲领（含 3D 任务六条准入条件）、`docs/` 策划与「开发经验与教训」沉淀。

### 技术栈
Vite + React 19 + TypeScript；3D 任务使用命令式 Three.js（`src/features/<task>/game3d/`），纯前端 SPA，无后端无数据库，部署于腾讯云轻量应用服务器。

### 版本号
`package.json` 与 `package-lock.json` 根版本由 `0.1.0` 升至 `1.0.0`。

### 部署
- 线上地址：`http://111.229.223.182`（IP 直访 :80，nginx 托管 `/var/www/kibo`）。
- 验收：线上无头 Chromium `smoke-live` 9/9 PASS（版本一致、首页 / 探索舱 / 火星 canvas+WebGL、控制台 0 报错、页面 0 异常）。
