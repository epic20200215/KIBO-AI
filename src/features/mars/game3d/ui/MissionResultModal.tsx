/**
 * 采集车验证结束后的结果弹窗。
 *
 * 失败：告诉学生验证失败，并给一条清晰的回主基地重试路径。
 * 成功：告诉学生能源已采集，并引导下一步去找 KIBO 汇报。
 */
export type ResultKind = 'success' | 'failed'

export type MissionResultModalProps = {
  kind: ResultKind
  /** 失败时的人话原因；成功时可为空 */
  reason?: string
  onConfirm: () => void
}

export function MissionResultModal({ kind, reason, onConfirm }: MissionResultModalProps) {
  const isSuccess = kind === 'success'
  return (
    <div className="mars-result-modal" role="dialog" aria-modal="true" aria-label={isSuccess ? '验证成功' : '验证失败'}>
      <div className="mars-result-modal__card">
        <span
          className={`mars-result-modal__icon${isSuccess ? ' is-success' : ' is-failed'}`}
          aria-hidden="true"
        >
          {isSuccess ? '✓' : '✕'}
        </span>
        <h2 className="mars-result-modal__title">
          {isSuccess ? '验证成功：能源已安全送回基地' : '验证失败：采集车没能回到基地'}
        </h2>
        <p className="mars-result-modal__body">
          {isSuccess ? (
            <>
              采集车沿着你选的路线走了一个往返，把能源样本成功带回了主基地。
              <br />
              下一步：找到 KIBO，把这次验证结果告诉它。
            </>
          ) : (
            <>
              {reason || '能源在返程路上耗尽了。'}
              <br />
              回到 AI 路径生成基地，重新比较两条路线，再派采集车验证一次。
            </>
          )}
        </p>
        <button type="button" className="mars-result-modal__confirm is-primary" onClick={onConfirm}>
          {isSuccess ? '确定' : '回到 AI 路径生成的基地'}
        </button>
      </div>
    </div>
  )
}
