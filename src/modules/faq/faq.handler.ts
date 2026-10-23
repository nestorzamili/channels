import type { ChannelAdapter } from '../../core/channel.interface.ts'
import type { FeatureModule } from '../../core/router.ts'
import type {
  InboundInteractionContext,
  InboundMessageContext,
  OutboundListRow,
} from '../../core/types.ts'
import type { FaqRepository } from './faq.repository.ts'
import { logger } from '../../core/logger.ts'

export interface FaqHandlerOptions {
  botName: string
  adminName: string
  adminPhone: string
  autoGreet: boolean
  autoGreetCooldownMs?: number
}

const FAQ_TRIGGER_KEYWORDS = new Set([
  'faq',
  '/faq',
  '!faq',
  'menu',
  'teks',
  '/menu',
  '!menu',
  'help',
  '/help',
  '!help',
  'bantuan',
  'info',
  'halo',
  'hai',
  'hi',
  'hello',
  'ping',
  '/start',
  'mulai',
  'topik',
  'tanya',
  'assalamualaikum',
  'pagi',
  'siang',
  'sore',
  'malam',
])

const MAX_CHAT_ENTRIES = 1000
const TOPICS_PER_PAGE = 7
const QUESTIONS_PER_PAGE = 6

interface FaqChatState {
  topicId?: string
  page: number
  lastGreetAt?: number
}

function paginate<T>(
  items: T[],
  requestedPage: number,
  pageSize: number,
  actionPrefix: string,
): { items: T[]; page: number; footer?: string; navigation: OutboundListRow[] } {
  const lastPage = Math.max(0, Math.ceil(items.length / pageSize) - 1)
  const page = Number.isSafeInteger(requestedPage)
    ? Math.max(0, Math.min(requestedPage, lastPage))
    : 0
  const navigation: OutboundListRow[] = []
  if (page > 0) {
    navigation.push({
      id: `${actionPrefix}:${page - 1}`,
      title: 'Halaman Sebelumnya',
    })
  }
  if (page < lastPage) {
    navigation.push({
      id: `${actionPrefix}:${page + 1}`,
      title: 'Halaman Berikutnya',
    })
  }
  return {
    items: items.slice(page * pageSize, (page + 1) * pageSize),
    page,
    footer: lastPage > 0 ? `Halaman ${page + 1} dari ${lastPage + 1}` : undefined,
    navigation,
  }
}

export class FaqModule implements FeatureModule {
  readonly name = 'faq'
  private readonly repo: FaqRepository
  private readonly options: FaqHandlerOptions
  private readonly chats = new Map<string, FaqChatState>()
  private readonly autoGreetsInFlight = new Set<string>()
  private readonly log = logger.child({ component: 'faq' })

  constructor(repo: FaqRepository, options: FaqHandlerOptions) {
    this.repo = repo
    this.options = options
  }

  async handleMessage(
    adapter: ChannelAdapter,
    ctx: InboundMessageContext,
  ): Promise<boolean> {
    const normalized = ctx.text.trim().toLowerCase()
    if (!normalized) return false

    if (normalized === 'kembali') {
      const state = this.chats.get(ctx.chatId)
      if (state?.topicId) {
        await this.sendTopicQuestionsList(
          adapter, ctx.chatId, state.topicId, state.page,
        )
      } else {
        await this.sendTopicsMenu(adapter, ctx.chatId, ctx.senderName)
      }
      return true
    }

    const words = normalized.split(/\s+/)
    const firstWord = words[0] ?? ''
    const isExplicitTrigger =
      FAQ_TRIGGER_KEYWORDS.has(normalized) ||
      FAQ_TRIGGER_KEYWORDS.has(firstWord)

    if (isExplicitTrigger && words.length <= 2) {
      await this.sendTopicsMenu(adapter, ctx.chatId, ctx.senderName)
      return true
    }

    const matchedQuestion = await this.repo.findQuestionByQuery(normalized)
    if (matchedQuestion) {
      await this.sendQuestionAnswer(
        adapter,
        ctx.chatId,
        matchedQuestion.question.id,
      )
      return true
    }

    const matchedTopic = await this.repo.findTopicByQuery(normalized)
    if (matchedTopic) {
      await this.sendTopicQuestionsList(adapter, ctx.chatId, matchedTopic.id)
      return true
    }

    if (isExplicitTrigger) {
      await this.sendTopicsMenu(adapter, ctx.chatId, ctx.senderName)
      return true
    }

    if (!this.options.autoGreet || !this.canAutoGreet(ctx.chatId)) return false

    this.autoGreetsInFlight.add(ctx.chatId)
    try {
      await this.sendTopicsMenu(adapter, ctx.chatId, ctx.senderName)
      return true
    } finally {
      this.autoGreetsInFlight.delete(ctx.chatId)
    }
  }

  async handleInteraction(
    adapter: ChannelAdapter,
    ctx: InboundInteractionContext,
  ): Promise<boolean> {
    const { actionId, chatId } = ctx
    if (!actionId.startsWith('faq:')) return false

    const [, action, targetId, pageId] = actionId.split(':')

    if (action === 'home') {
      await this.sendTopicsMenu(adapter, chatId, ctx.senderName)
      return true
    }

    if (action === 'topics' && targetId && /^\d+$/.test(targetId)) {
      await this.sendTopicsMenu(adapter, chatId, ctx.senderName, Number(targetId))
      return true
    }

    if (action === 'topic' && targetId) {
      if (pageId !== undefined && !/^\d+$/.test(pageId)) return false
      await this.sendTopicQuestionsList(
        adapter, chatId, targetId, Number(pageId ?? 0),
      )
      return true
    }

    if (action === 'q' && targetId) {
      await this.sendQuestionAnswer(adapter, chatId, targetId)
      return true
    }

    if (action === 'contact') {
      await this.sendContactSupport(adapter, chatId)
      return true
    }

    return false
  }

  async sendTopicsMenu(
    adapter: ChannelAdapter,
    chatId: string,
    senderName?: string,
    requestedPage = 0,
  ): Promise<void> {
    const startedAt = performance.now()
    const topics = await this.repo.getAllTopics()
    const page = paginate(topics, requestedPage, TOPICS_PER_PAGE, 'faq:topics')
    const firstVisit = !this.chats.has(chatId)
    const greeting = senderName ? `Halo *${senderName}*,` : 'Halo,'
    const introduction = firstVisit
      ? `${greeting}\nSelamat datang di *${this.options.botName}*.\n\n`
      : '*Topik FAQ*\n\n'

    if (topics.length === 0) {
      await adapter.sendButtons(chatId, {
        text: `${introduction}Informasi FAQ belum tersedia. Tim kami siap membantu.`,
        buttons: [{ type: 'reply', id: 'faq:contact', text: 'Hubungi Admin' }],
      })
    } else {
      await adapter.sendList(chatId, {
        description: `${introduction}Pilih topik bantuan yang Anda butuhkan.`,
        buttonText: 'Pilih Topik',
        footerText: page.footer ?? (firstVisit ? 'Menu tidak tampil? Ketik teks.' : undefined),
        sections: [
          {
            title: 'Daftar Topik FAQ',
            rows: page.items.map((topic) => ({
              id: `faq:topic:${topic.id}`,
              title: topic.label ?? topic.title,
              description: topic.label && topic.label !== topic.title
                ? topic.title
                : undefined,
            })),
          },
          {
            title: 'Navigasi',
            rows: [
              ...page.navigation,
              { id: 'faq:contact', title: 'Hubungi Admin' },
            ],
          },
        ],
      })
    }
    this.saveChatState(chatId, {
      topicId: undefined,
      page: page.page,
      lastGreetAt: Date.now(),
    })
    this.log.info({
      event: 'faq.topics_sent', channel: adapter.name,
      page: page.page + 1, itemCount: page.items.length,
      durationMs: Math.round(performance.now() - startedAt),
    }, 'FAQ topics sent')
  }

  async sendTopicQuestionsList(
    adapter: ChannelAdapter,
    chatId: string,
    topicId: string,
    requestedPage = 0,
  ): Promise<void> {
    const startedAt = performance.now()
    const topic = await this.repo.getTopicById(topicId)
    if (!topic) {
      await this.sendTopicsMenu(adapter, chatId)
      return
    }

    const page = paginate(
      topic.questions, requestedPage, QUESTIONS_PER_PAGE, `faq:topic:${topic.id}`,
    )
    const description = `*${topic.title}*\n\nPilih pertanyaan yang ingin Anda tanyakan.`
    const rows = page.items.map((question, index) => {
      const label = question.label ?? question.question
      const title = label.length <= 24
        ? label
        : `Pertanyaan ${page.page * QUESTIONS_PER_PAGE + index + 1}`
      return {
        id: `faq:q:${question.id}`,
        title,
        description: title !== question.question ? question.question : undefined,
      }
    })

    if (rows.length === 0) {
      await adapter.sendButtons(chatId, {
        text: `*${topic.title}*\n\nBelum ada pertanyaan untuk topik ini. Pilih topik lain atau hubungi admin.`,
        buttons: [
          { type: 'reply', id: 'faq:home', text: 'Semua Topik' },
          { type: 'reply', id: 'faq:contact', text: 'Hubungi Admin' },
        ],
      })
    } else {
      await adapter.sendList(chatId, {
        description,
        buttonText: 'Pilih Pertanyaan',
        footerText: page.footer,
        sections: [
          { title: 'Daftar Pertanyaan', rows },
          {
            title: 'Navigasi',
            rows: [
              ...page.navigation,
              { id: 'faq:home', title: 'Semua Topik' },
              { id: 'faq:contact', title: 'Hubungi Admin' },
            ],
          },
        ],
      })
    }
    this.saveChatState(chatId, {
      topicId: topic.id,
      page: page.page,
    })
    this.log.info({
      event: 'faq.questions_sent', channel: adapter.name, topicId: topic.id,
      page: page.page + 1, itemCount: page.items.length,
      durationMs: Math.round(performance.now() - startedAt),
    }, 'FAQ questions sent')
  }

  async sendQuestionAnswer(
    adapter: ChannelAdapter,
    chatId: string,
    questionId: string,
  ): Promise<void> {
    const startedAt = performance.now()
    const found = await this.repo.getQuestionById(questionId)
    if (!found) {
      await this.sendTopicsMenu(adapter, chatId)
      return
    }

    const { topic, question } = found

    const page = Math.floor(
      topic.questions.findIndex((entry) => entry.id === question.id) /
        QUESTIONS_PER_PAGE,
    )
    await adapter.sendButtons(chatId, {
      text: `*${question.question}*\n\n${question.answer}`,
      buttons: [
        { type: 'reply', id: `faq:topic:${topic.id}:${page}`, text: 'Daftar Pertanyaan' },
        { type: 'reply', id: 'faq:home', text: 'Semua Topik' },
        { type: 'reply', id: 'faq:contact', text: 'Hubungi Admin' },
      ],
    })
    this.saveChatState(chatId, { topicId: topic.id, page })
    this.log.info({
      event: 'faq.answer_sent', channel: adapter.name,
      topicId: topic.id, questionId: question.id,
      durationMs: Math.round(performance.now() - startedAt),
    }, 'FAQ answer sent')
  }

  async sendContactSupport(
    adapter: ChannelAdapter,
    chatId: string,
  ): Promise<void> {
    const startedAt = performance.now()
    const cleanPhone = this.options.adminPhone.replace(/\D/g, '')

    await adapter.sendButtons(chatId, {
      text:
        `Hubungi tim *${this.options.adminName}* untuk bantuan lebih lanjut.\n\n` +
        `*WhatsApp:* https://wa.me/${cleanPhone}\n` +
        `*Telepon:* +${cleanPhone}`,
      buttons: [
        {
          type: 'reply',
          id: 'faq:home',
          text: 'Semua Topik',
        },
      ],
    })
    this.log.info({
      event: 'faq.support_sent', channel: adapter.name,
      durationMs: Math.round(performance.now() - startedAt),
    }, 'FAQ support contact sent')
  }

  private canAutoGreet(chatId: string): boolean {
    if (this.autoGreetsInFlight.has(chatId)) return false
    const cooldownMs = this.options.autoGreetCooldownMs ?? 30_000
    if (cooldownMs <= 0) return true
    const lastGreetAt = this.chats.get(chatId)?.lastGreetAt
    if (lastGreetAt === undefined) return true
    return Date.now() - lastGreetAt >= cooldownMs
  }

  private saveChatState(chatId: string, update: Partial<FaqChatState>): void {
    if (
      !this.chats.has(chatId) &&
      this.chats.size >= MAX_CHAT_ENTRIES
    ) {
      const oldestKey = this.chats.keys().next().value
      if (oldestKey !== undefined) {
        this.chats.delete(oldestKey)
      }
    }

    this.chats.set(chatId, { page: 0, ...this.chats.get(chatId), ...update })
  }
}
