/**
 * KIBO 对白台词（用户反馈 #3 / #4）。
 *
 * 定位：KIBO 是用户的「AI 伙伴」——不是冷冰冰的提示框，而是和用户**一起把任务跑通**的同伴，
 * 语气是「咱们一起」「一定帮你解决」。它要传达本次设计的核心目的：
 *
 *   - 让用户**体验并驾驭 AI**（你是指挥官，AI 是跟你干活的「工具」），而不是被 AI 牵着走；
 *   - 结合真实火星探测（数据不足 AI 照样给答案、有限扫描、规划器只按规则算）；
 *   - 教学友好、**无限重试**——翻车不是失败，是「和 KIBO 一起找到坑在哪」。
 *
 * 纯函数：输入一份任务快照，输出当前该说的一句话。不持有任何状态，便于单测与复用。
 */
import type { MissionSnapshot } from './core/mission'

export type KiboMood = 'guide' | 'alert' | 'celebrate' | 'idle'

export type KiboLine = {
  text: string
  mood: KiboMood
}

export function kiboLineFor(s: MissionSnapshot): KiboLine {
  switch (s.phase) {
    case 'scan': {
      // 刚进入一张地图（还没扫过）：先点出这张地图的教学意图（P2 三段强制教学弧）。
      if (s.scansUsed === 0) {
        if (s.worldIndex !== 0) {
          return {
            mood: 'guide',
            text: `这是${s.worldGoal.label}：${s.worldGoal.teaching} 用你上一张地图学到的规则重新探明这片地形。`,
          }
        }
        return {
          mood: 'guide',
          text:
            '跟着淡青色标记把 R-7 开过去，按 E 扫描。R-7 是你的手控任务车，专门收集训练 AI 的真实地形数据；另一辆资源采集车会按训练好的 AI 自动驾驶，验证路线靠不靠谱。',
        }
      }
      if (s.scansUsed === 1) {
        return {
          mood: 'guide',
          text:
            '第一块地形数据到手了！这些真实数据会喂给 AI，帮它学会分辨哪里能走。继续扫描，还是现在就教 AI 规则？',
        }
      }
      return {
        mood: 'guide',
        text: `已经用了 ${s.scansUsed} 次扫描。每多扫一块，AI 的训练数据就多一分，路线规划也就少一分瞎猜。`,
      }
    }
    case 'rules':
      return {
        mood: 'guide',
        text:
          '这两个数字就是 AI 要学的全部通行规则。你在告诉 AI：超过多少度的坡要警惕、多少度绝对不能走。规则是你定的，AI 会严格执行。',
      }
    case 'plan':
      return {
        mood: 'guide',
        text:
          '规划器根据你已扫的数据和你定的规则，算出了候选路线。它给的是参考，不是圣旨——敢不敢走没数据的路，最后拍板的还是你这位指挥官。',
      }
    case 'drive': {
      if (s.driveStatus === 'stuck') {
        if (s.stuckHazard === 'soft') {
          return {
            mood: 'alert',
            text:
              'R-7 陷进深软沙了——这是松沙陷阱。你可以让它试着「摇出来」脱困，但更聪明的是：下次规划把软沙权重调高，AI 会主动绕开这类松沙带，从源头避开陷车。',
          }
        }
        if (s.stuckReason === 'guess') {
          return {
            mood: 'alert',
            text:
              '看，AI 在没数据的地方「猜」错了。但这不是失败，是给 AI 增加了一条真实训练样本——知道这里不能走，下次它就更聪明。',
          }
        }
        return {
          mood: 'alert',
          text:
            '翻在已探明的陡坡/岩石上，说明规则定得太松。把禁行坡度调高，AI 下次就会把这里算成禁行区。咱们一起把规则教准。',
        }
      }
      // 地图 C 盲区入口：验证车停住等待你下达指挥命令（P6 高潮）。
      // 此刻不能念默认"按 AI 规划跑"——那会让用户以为车卡 bug。要解释"为什么停、这是你的决策时刻"。
      if (s.awaitingBlindCommand) {
        return {
          mood: 'guide',
          text:
            '前方是 AI 完全没数据的一片盲区——这恰恰说明它诚实：不知道就是不知道，把决策权交还给你。下达指挥命令（按 E 或点按钮），先局部探明再放行验证车。',
        }
      }
      if (s.driveStatus === 'arrived') {
        // 缺口-1 加固：用 arrivedManual（本次到达是否手动）区分，而非实时的 s.manual（手动模式开关），
        // 避免主线 AI 实测到达时若手动模式仍激活而误念沙盒台词。当前手动模式不触发 arrived，沙盒台词暂为休眠态。
        return {
          mood: 'celebrate',
          text: s.arrivedManual
            ? '到了！这是你手控练出来的路线——手感怎么样？记住：真正给 AI 当证据的实测，永远派自动驾驶验证车去跑。'
            : '到了！R-7 这条 AI 规划的路线能走通。下一步让 AI 自动驾驶的资源采集车再走一遍——它不靠你手控，只靠训练好的 AI 判断，能过才算真 AI 方案。',
        }
      }
      return {
        mood: 'guide',
        text: 'R-7 正在按 AI 规划的路线跑。盯紧橙色虚线那几格——那里是 AI 没数据、只能靠猜的地方。R-7 的实测会帮 AI 长经验。',
      }
    }
    case 'revise':
      return {
        mood: 'guide',
        text:
          '每一轮修改都在重新训练 AI 的判断。你可以补数据、改规则、重新规划——直到 AI 给出的路线经得起实测。',
      }
    case 'report':
      return {
        mood: 'celebrate',
        text:
          '你训练的导航 AI 已经让 R-7 和资源采集验证车都通过了路线。下一张地图的地形完全不同，会越来越难——但好 AI 能迁移到新地形。你驾驭了 AI，而不是被它牵着走。',
      }
    default:
      return {
        mood: 'idle',
        text: '我是 KIBO，你的 AI 训练助理。R-7 是你手控的任务车，资源采集车是 AI 自动驾驶的验证车——咱们一起训练出一套两张地图都跑得通的导航 AI。',
      }
  }
}

/**
 * 进入某个 POI 区域时说的"这里是什么"提示（UI/UX 重设计 2.2：进入新区域触发）。
 * 返回 null 表示该 POI 没有专属台词，调用方应回退到当前阶段台词。
 */
const POI_LINES: Record<string, KiboLine> = {
  'sample-a': { mood: 'guide', text: '河床沉积样本：带回去清洗、标注，就能变成 AI 认识「古河道地形」的训练数据。' },
  'sample-b': { mood: 'guide', text: '沙丘背风侧样本：分析它，AI 才能学会判断软沙会不会让车轮陷住。' },
  'sample-c': { mood: 'guide', text: '坑缘溅射样本：撞击痕迹是地形档案，标进数据集，AI 以后就知道坑附近不能硬闯。' },
  'base-clean': { mood: 'guide', text: '数据清洗台：原始扫描里有噪声，不洗掉 AI 会学错。clean 完才能拿去训练。' },
  'base-label': { mood: 'guide', text: '数据标注台：你来告诉 AI「这格能走 / 不能走」。标签是 AI 学习的标准答案。' },
  'base-train': { mood: 'guide', text: '训练舱：把清洗好的标注数据喂进去，导航 AI 才真正学会你的规则。' },
  'base-select': { mood: 'guide', text: '路径选择台：AI 会按你的规则生成 2 条候选路线，最终拍板的是你。' },
  'maze-entrance': { mood: 'alert', text: '只有 AI 规划出并通过实测验证的路线，才能安全穿过这片岩石迷阵。' },
  'energy-station': { mood: 'celebrate', text: '能源站！从这里派遣 AI 自动驾驶的资源采集车，把它当成 AI 路线的「期末考试」。' },
}

export function kiboPoiLine(kind: string): KiboLine | null {
  return POI_LINES[kind] ?? null
}

/** 玩家停滞 30 秒时的轻提示（UI/UX 重设计 2.2：玩家停滞触发）。 */
export const kiboIdleLine: KiboLine = {
  mood: 'idle',
  text: '要不要去最近的地标点看看？点一下地面，R-7 就开过去。',
}
