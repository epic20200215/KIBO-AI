import { useEffect, useState } from 'react'
import {
  ArrowRight,
  Check,
  Handshake,
  HeartHandshake,
  MessageCircleQuestionMark,
  SearchCheck,
  Sparkles,
  Workflow,
} from 'lucide-react'
import { Brand } from '../components/Brand'

type HomePageProps = {
  onEnterComplete: () => void
}

export function HomePage({ onEnterComplete }: HomePageProps) {
  const [entering, setEntering] = useState(false)

  useEffect(() => {
    [
      `${import.meta.env.BASE_URL}assets/cabin/cabin-shell-front-v4.webp`,
      `${import.meta.env.BASE_URL}assets/cabin/cabin-console-standby-v1.webp`,
      `${import.meta.env.BASE_URL}assets/missions/mars.webp`,
    ].forEach((src) => {
      const image = new Image()
      image.src = src
    })
  }, [])

  const startEntry = () => {
    if (!entering) setEntering(true)
  }

  return (
    <>
    <div className={`home-page ${entering ? 'home-page--entering' : ''}`}>
      <header className="site-header">
        <Brand />
        <nav className="site-nav" aria-label="首页导航">
          <button className="site-nav__cta" type="button" onClick={startEntry}>
            进入探索舱
          </button>
        </nav>
      </header>

      <main>
        <section className="home-hero">
          <div className="home-scene" aria-hidden="true">
            <img className="home-scene__base" src={`${import.meta.env.BASE_URL}assets/home/home-base.webp`} alt="" width="1736" height="941" />
            <div className="home-scene__clouds" />
            <div className="home-scene__sunwash" />
            <div className="home-scene__door-signal" />
            <div className="home-scene__kibo-wrap">
              <span className="home-scene__kibo-shadow" />
              <img className="home-scene__kibo" src={`${import.meta.env.BASE_URL}assets/kibo/kibo-welcome.webp`} alt="" width="1211" height="1299" />
            </div>
            <img className="home-scene__foreground" src={`${import.meta.env.BASE_URL}assets/home/home-foreground.webp`} alt="" width="1736" height="941" />
          </div>

          <div className="home-hero__scrim" aria-hidden="true" />

          <div className="home-hero__copy">
            <p className="home-hero__eyebrow">
              <span aria-hidden="true" />
              KIBO AI 素养探索基地
            </p>
            <h1>从探索开始<br />成为AI时代<span className="home-hero__mobile-break"><br /></span>的创造者</h1>
            <p className="home-hero__lead">面向8-15岁学生的AI素养探索基地</p>

            <div className="home-hero__trust" aria-label="网站特点">
              <span><Check size={15} aria-hidden="true" />免费学习</span>
              <span><Check size={15} aria-hidden="true" />无需注册</span>
              <span><Check size={15} aria-hidden="true" />真实项目</span>
            </div>

            <button className="primary-entry" type="button" onClick={startEntry}>
              <span>进入 KIBO 探索舱</span>
              <span className="primary-entry__icon" aria-hidden="true"><ArrowRight size={21} /></span>
            </button>
            <p className="home-hero__note">不止会用工具，更要理解原理、设计规则、驾驭 AI。</p>
          </div>
        </section>

        <section id="method" className="method-section" aria-labelledby="method-title">
          <div className="section-kicker">AI LITERACY CORE</div>
          <div className="method-section__heading">
            <h2 id="method-title">成为 AI 创造者，<br />需要六种核心能力</h2>
            <p>KIBO 不教孩子追逐某个工具，而是在真实项目中练习提出问题、判断证据、设计系统，并对 AI 产生的结果负责。</p>
          </div>

          <div className="competency-grid">
            <article className="competency-card competency-card--teal">
              <div className="competency-card__top">
                <span className="competency-card__icon"><MessageCircleQuestionMark aria-hidden="true" /></span>
                <span className="competency-card__index">01</span>
              </div>
              <h3>提问力</h3>
              <p>把模糊的目标变成可以观察、可以验证的问题，先问对，再行动。</p>
            </article>
            <article className="competency-card competency-card--orange">
              <div className="competency-card__top">
                <span className="competency-card__icon"><SearchCheck aria-hidden="true" /></span>
                <span className="competency-card__index">02</span>
              </div>
              <h3>判断力</h3>
              <p>检查证据、来源、偏差和不确定性，不把 AI 输出直接当成答案。</p>
            </article>
            <article className="competency-card competency-card--teal">
              <div className="competency-card__top">
                <span className="competency-card__icon"><Workflow aria-hidden="true" /></span>
                <span className="competency-card__index">03</span>
              </div>
              <h3>系统设计力</h3>
              <p>拆解数据、规则、目标与反馈，看懂智能系统如何运作和影响结果。</p>
            </article>
            <article className="competency-card competency-card--orange">
              <div className="competency-card__top">
                <span className="competency-card__icon"><Handshake aria-hidden="true" /></span>
                <span className="competency-card__index">04</span>
              </div>
              <h3>人机协同力</h3>
              <p>理解人和 AI 各自擅长什么，通过分工、测试与修改共同完成任务。</p>
            </article>
            <article className="competency-card competency-card--teal">
              <div className="competency-card__top">
                <span className="competency-card__icon"><Sparkles aria-hidden="true" /></span>
                <span className="competency-card__index">05</span>
              </div>
              <h3>创造与品味</h3>
              <p>比较不同方案，做出有目的、能解释、有自己判断的创造性选择。</p>
            </article>
            <article className="competency-card competency-card--orange">
              <div className="competency-card__top">
                <span className="competency-card__icon"><HeartHandshake aria-hidden="true" /></span>
                <span className="competency-card__index">06</span>
              </div>
              <h3>共情与责任</h3>
              <p>考虑真实使用者，以及隐私、公平、安全和技术带来的长期影响。</p>
            </article>
          </div>
        </section>

      </main>

      <footer className="site-footer">
        <Brand />
        <p>为下一代 AI 创造者建立的免费探索基地</p>
      </footer>
    </div>

      {entering && (
        <>
          <div className="portal-bg" aria-hidden="true" />
          <div
            className="portal-transition"
            aria-label="正在进入 KIBO 探索舱"
            onAnimationEnd={(event) => {
              if (event.target === event.currentTarget) onEnterComplete()
            }}
          >
            <div className="portal-transition__iris" />
            <span>进入探索舱</span>
          </div>
        </>
      )}
    </>
  )
}
