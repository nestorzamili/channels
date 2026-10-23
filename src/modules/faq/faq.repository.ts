import fs from 'node:fs'
import type { FaqQuestion, FaqTopic } from './faq.types.ts'

export interface QuestionWithTopic {
  topic: FaqTopic
  question: FaqQuestion
}

export interface FaqRepository {
  getAllTopics(): Promise<FaqTopic[]>
  getTopicById(topicId: string): Promise<FaqTopic | undefined>
  getQuestionById(questionId: string): Promise<QuestionWithTopic | undefined>
  findTopicByQuery(query: string): Promise<FaqTopic | undefined>
  findQuestionByQuery(query: string): Promise<QuestionWithTopic | undefined>
}

interface IndexedTopic {
  topic: FaqTopic
  idLower: string
  tokens: Set<string>
}

interface IndexedQuestion {
  entry: QuestionWithTopic
  idLower: string
  tokens: Set<string>
}

const STOP_WORDS = new Set([
  'apa',
  'apakah',
  'bagaimana',
  'berapa',
  'bisa',
  'cara',
  'dan',
  'dari',
  'dengan',
  'di',
  'ini',
  'itu',
  'jika',
  'ke',
  'kami',
  'kapan',
  'mana',
  'pada',
  'saja',
  'saya',
  'sudah',
  'tidak',
  'untuk',
  'yang',
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token))
}

function loadTopics(): unknown {
  try {
    return JSON.parse(fs.readFileSync(new URL('./faq.data.json', import.meta.url), 'utf8'))
  } catch (error) {
    throw new Error('Failed to load faq.data.json.', { cause: error })
  }
}

function assertText(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid FAQ data: ${path} must be a non-empty string.`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertEntry(
  value: unknown,
  path: string,
  fields: string[],
): asserts value is Record<string, unknown> & { id: string } {
  if (!isRecord(value)) {
    throw new Error(`Invalid FAQ data: ${path} must be an object.`)
  }
  assertText(value.id, `${path}.id`)
  if (/[^A-Za-z0-9_-]/.test(value.id)) {
    throw new Error(`Invalid FAQ data: ${path}.id must contain only letters, digits, _ or -.`)
  }
  for (const field of fields) {
    assertText(value[field], `${path}.${field}`)
  }
  if (value.label !== undefined) {
    assertText(value.label, `${path}.label`)
  }
}

function validateTopics(data: unknown): asserts data is FaqTopic[] {
  if (!Array.isArray(data)) {
    throw new Error('Invalid FAQ data: topics must be an array.')
  }
  const topicIds = new Set<string>()
  const questionIds = new Set<string>()
  for (const [topicIndex, topic] of data.entries()) {
    const path = `topics[${topicIndex}]`
    assertEntry(topic, path, ['title'])
    const topicId = topic.id.toLowerCase()
    if (topicIds.has(topicId)) {
      throw new Error(`Invalid FAQ data: duplicate topic ID at ${path}.id.`)
    }
    topicIds.add(topicId)
    if (!Array.isArray(topic.questions)) {
      throw new Error(`Invalid FAQ data: ${path}.questions must be an array.`)
    }
    for (const [questionIndex, question] of topic.questions.entries()) {
      const questionPath = `${path}.questions[${questionIndex}]`
      assertEntry(question, questionPath, ['question', 'answer'])
      const questionId = question.id.toLowerCase()
      if (questionIds.has(questionId)) {
        throw new Error(`Invalid FAQ data: duplicate question ID at ${questionPath}.id.`)
      }
      questionIds.add(questionId)
    }
  }
}

export class StaticFaqRepository implements FaqRepository {
  private readonly topics: FaqTopic[]
  private readonly topicMap = new Map<string, FaqTopic>()
  private readonly questionMap = new Map<string, QuestionWithTopic>()
  private readonly indexedTopics: IndexedTopic[] = []
  private readonly indexedQuestions: IndexedQuestion[] = []

  constructor(topics: unknown = loadTopics()) {
    validateTopics(topics)
    this.topics = topics

    for (const topic of topics) {
      this.topicMap.set(topic.id, topic)
      this.indexedTopics.push({
        topic,
        idLower: topic.id.toLowerCase(),
        tokens: new Set(tokenize(`${topic.id} ${topic.title}`)),
      })

      for (const question of topic.questions) {
        const entry: QuestionWithTopic = { topic, question }
        this.questionMap.set(question.id, entry)
        this.indexedQuestions.push({
          entry,
          idLower: question.id.toLowerCase(),
          tokens: new Set(tokenize(`${question.id} ${question.question}`)),
        })
      }
    }
  }

  async getAllTopics(): Promise<FaqTopic[]> {
    return this.topics
  }

  async getTopicById(topicId: string): Promise<FaqTopic | undefined> {
    return this.topicMap.get(topicId)
  }

  async getQuestionById(
    questionId: string,
  ): Promise<QuestionWithTopic | undefined> {
    return this.questionMap.get(questionId)
  }

  async findTopicByQuery(query: string): Promise<FaqTopic | undefined> {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return undefined

    for (const item of this.indexedTopics) {
      if (item.idLower === normalized) return item.topic
    }

    const queryTokens = tokenize(normalized)
    if (queryTokens.length === 0) return undefined

    let bestMatch: FaqTopic | undefined
    let bestScore = 0

    for (const item of this.indexedTopics) {
      let hits = 0
      for (const token of queryTokens) {
        if (item.tokens.has(token)) hits++
      }
      if (hits > bestScore) {
        bestScore = hits
        bestMatch = item.topic
      }
    }

    return bestScore > 0 ? bestMatch : undefined
  }

  async findQuestionByQuery(
    query: string,
  ): Promise<QuestionWithTopic | undefined> {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return undefined

    for (const item of this.indexedQuestions) {
      if (item.idLower === normalized) return item.entry
    }

    const queryTokens = tokenize(normalized)
    if (queryTokens.length < 2) return undefined

    let bestMatch: QuestionWithTopic | undefined
    let bestScore = 0

    for (const item of this.indexedQuestions) {
      let hits = 0
      for (const token of queryTokens) {
        if (item.tokens.has(token)) hits++
      }
      if (hits >= 2 && hits > bestScore) {
        bestScore = hits
        bestMatch = item.entry
      }
    }

    return bestMatch
  }
}
