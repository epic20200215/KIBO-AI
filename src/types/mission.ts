export type MissionStatus = 'released' | 'design'

export type Mission = {
  id: string
  order: number
  status: MissionStatus
  coordinate: string
  eyebrow: string
  title: string
  shortTitle: string
  summary: string
  durationMinutes: number
  knowledgeNodes: string[]
  accent: string
  accentSoft: string
  poster: string
}
