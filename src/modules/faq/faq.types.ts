export interface FaqQuestion {
  id: string
  question: string
  label?: string
  answer: string
}

export interface FaqTopic {
  id: string
  title: string
  label?: string
  questions: FaqQuestion[]
}
