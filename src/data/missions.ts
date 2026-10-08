import type { Mission } from '../types/mission'

export const missions: Mission[] = [
  {
    id: 'mars-rover',
    order: 1,
    status: 'released',
    coordinate: 'M-01',
    eyebrow: '火星自主导航',
    title: '火星无人车：穿越岩石迷阵',
    shortTitle: '火星无人车',
    summary: '识别危险地形，设计安全、能耗与距离之间的路线策略。',
    durationMinutes: 28,
    knowledgeNodes: ['感知', '路径规划', '目标权衡'],
    accent: '#ff8a3d',
    accentSoft: '#ffd4ae',
    poster: `${import.meta.env.BASE_URL}assets/missions/mars.webp`,
  },
  {
    id: 'infinite-maze',
    order: 2,
    status: 'design',
    coordinate: 'G-02',
    eyebrow: '强化学习与奖励',
    title: '无限迷宫：训练 AI 闯关冠军',
    shortTitle: '无限迷宫',
    summary: '设计奖励规则，观察 AI 如何学习，并找出它刷分绕路的漏洞。',
    durationMinutes: 27,
    knowledgeNodes: ['状态与动作', '奖励', '反馈'],
    accent: '#31c6c9',
    accentSoft: '#b7f2ef',
    poster: `${import.meta.env.BASE_URL}assets/missions/maze.webp`,
  },
  {
    id: 'dinosaur-prints',
    order: 3,
    status: 'design',
    coordinate: 'D-03',
    eyebrow: '特征与分类',
    title: '恐龙足迹侦探：谁留下了这串脚印？',
    shortTitle: '恐龙足迹',
    summary: '测量足迹特征，让分类器给出证据，也学会在证据不足时说不知道。',
    durationMinutes: 28,
    knowledgeNodes: ['特征', '分类', '不确定性'],
    accent: '#f2b63f',
    accentSoft: '#ffe7a5',
    poster: `${import.meta.env.BASE_URL}assets/missions/dinosaur.webp`,
  },
  {
    id: 'whale-song',
    order: 4,
    status: 'design',
    coordinate: 'O-04',
    eyebrow: '声音识别与阈值',
    title: '深海声纹追踪：在噪声中找到鲸歌',
    shortTitle: '深海声纹',
    summary: '听声音、看频谱、调阈值，在漏报与误报之间作出选择。',
    durationMinutes: 27,
    knowledgeNodes: ['声音特征', '阈值', '人类复核'],
    accent: '#21b8e6',
    accentSoft: '#a9eaff',
    poster: `${import.meta.env.BASE_URL}assets/missions/ocean.webp`,
  },
  {
    id: 'micro-census',
    order: 5,
    status: 'design',
    coordinate: 'C-05',
    eyebrow: '图像分割与计数',
    title: '微观世界人口普查：AI 为什么总是数错？',
    shortTitle: '微观普查',
    summary: '调节分割规则，检查重叠细胞，找出一个正确数字背后的错误轮廓。',
    durationMinutes: 28,
    knowledgeNodes: ['图像分割', '基准答案', '误差'],
    accent: '#4ed9cc',
    accentSoft: '#b9f5ed',
    poster: `${import.meta.env.BASE_URL}assets/missions/micro.webp`,
  },
]

export function getReleasedMissions(catalog: Mission[] = missions) {
  return catalog.filter((mission) => mission.status === 'released').sort((a, b) => a.order - b.order)
}

// 探索舱任务目录：按 order 返回全部任务。生产环境也用它展示所有任务介绍，
// 仅 status === 'released' 的任务可进入实际体验（其余在 CabinPage 显示「敬请期待」）。
export function getInterfaceReviewMissions(catalog: Mission[] = missions) {
  return [...catalog].sort((a, b) => a.order - b.order)
}
