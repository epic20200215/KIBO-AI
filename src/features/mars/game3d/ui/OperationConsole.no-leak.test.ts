/**
 * 红线 v1.3.3 锁死测试：路径选择台（OperationConsole）的 UI 代码不得包含
 * 任何「会替学生判断哪条路更好」的关键词。
 *
 * 历史教训：
 * - v1.3.1 写过"确定耗电 X / 电池电量 Y"对比 + 红色高亮 → 泄题
 * - v1.3.2 回退掉数字但保留"留得出余量/够不够回基地得自己算/区间越窄"评价 → 仍泄题
 * - v1.3.3 连评价也删了，连教学文案"近路颠簸费电/远路稳妥/最险"也删了
 *
 * 本测试只检查源码里是否含这些**会渲染到 UI 的字符串**。
 * 注释里出现的同名字字是为了给未来开发者留历史背景——那是允许的。
 * 因此先把注释剥掉再检查。
 *
 * 实现：用 Vite 的 `?raw` 后缀把 .tsx 当字符串读入。Vitest 由 Vite 驱动，
 * 该特性在测试运行期直接生效，无需任何 fs / node:fs / @types/node 依赖。
 */
import consoleSrc from './OperationConsole.tsx?raw'

const LEAK_TERMS = [
  // 数字对比泄露
  '确定耗电',
  '电池电量',
  '超预算',
  // 评价泄露（v1.3.2 残留）
  '留得出余量',
  '够不够回基地',
  '区间滑动',
  '区间越窄',
  'AI 猜',
  // 教学文案泄露（v1.3.3 才删的）
  '颠簸费电',
  '远路稳妥',
  '最险',
  '最稳',
  '里程最长也最稳',
  '里程最短也最险',
  // 任何含「超 X」「超 N」字样
  '超 X',
  '（超 ',
  // 注意：「最坏」一词只允许出现在全局 allDoomed 警示文案（"三条路全军覆没"全局态，
  // 不是单条路线对比，已在 v1.3.2 经老大确认为非泄题）。
]

function stripComments(src: string): string {
  // 块注释
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '')
  // 行注释
  out = out.replace(/^\s*\/\/[^\n]*$/gm, '')
  out = out.replace(/\s+\/\/[^\n]*$/g, '')
  return out
}

describe('路径选择台红线：UI 不得替学生判断哪条路更好', () => {
  it('OperationConsole.tsx 的可执行代码不含任何泄题关键词', () => {
    const stripped = stripComments(consoleSrc)
    const hits = LEAK_TERMS.filter((term) => stripped.includes(term))
    // 列出命中项方便排查（若失败）。
    if (hits.length > 0) {
      throw new Error(`路径选择台仍含泄题关键词：${hits.join('、')}`)
    }
    expect(hits).toEqual([])
  })
})