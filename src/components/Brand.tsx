type BrandProps = {
  onClick?: () => void
  inverse?: boolean
}

export function Brand({ onClick, inverse = false }: BrandProps) {
  const content = (
    <>
      <span className="brand__avatar" aria-hidden="true">
        <img src="/assets/kibo/kibo-head.webp" alt="" />
      </span>
      <span className="brand__word">KIBO</span>
      <span className="brand__descriptor">AI 素养探索基地</span>
    </>
  )

  if (onClick) {
    return (
      <button className={`brand ${inverse ? 'brand--inverse' : ''}`} type="button" onClick={onClick}>
        {content}
      </button>
    )
  }

  return <div className={`brand ${inverse ? 'brand--inverse' : ''}`}>{content}</div>
}
