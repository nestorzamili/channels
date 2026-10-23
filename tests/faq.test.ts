import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import {
  WhatsAppAdapter,
  extractInteractiveAction,
  formatNumberedButtonsMessage,
  formatNumberedListMessage,
} from '../src/channels/whatsapp/whatsapp.adapter.ts'
import type { ChannelAdapter } from '../src/core/channel.interface.ts'
import { MessageRouter } from '../src/core/router.ts'
import type {
  OutboundButtonsPayload,
  OutboundListPayload,
} from '../src/core/types.ts'
import { FaqModule } from '../src/modules/faq/faq.handler.ts'
import { StaticFaqRepository } from '../src/modules/faq/faq.repository.ts'
import type { FaqTopic } from '../src/modules/faq/faq.types.ts'
import { createLogger, logger } from '../src/core/logger.ts'
import type { Bindings, ChildLoggerOptions } from 'pino'

afterEach(() => mock.restore())

class MockChannelAdapter implements ChannelAdapter {
  readonly name = 'whatsapp' as const
  public sentTexts: Array<{ chatId: string; text: string }> = []
  public sentButtons: Array<{ chatId: string; payload: OutboundButtonsPayload }> =
    []
  public sentLists: Array<{ chatId: string; payload: OutboundListPayload }> = []

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async sendText(chatId: string, text: string): Promise<void> {
    this.sentTexts.push({ chatId, text })
  }

  async sendButtons(
    chatId: string,
    payload: OutboundButtonsPayload,
  ): Promise<void> {
    this.sentButtons.push({ chatId, payload })
  }

  async sendList(chatId: string, payload: OutboundListPayload): Promise<void> {
    this.sentLists.push({ chatId, payload })
  }
}

describe('FAQ journey from greeting to topics, questions, and answer', () => {
  const createSetup = (
    autoGreet = true,
    autoGreetCooldownMs = 30_000,
    topics?: FaqTopic[],
    appLogger = createLogger('silent'),
  ) => {
    spyOn(logger, 'child').mockImplementation(<Levels extends string = never>(
      bindings: Bindings, options?: ChildLoggerOptions<Levels>,
    ) => appLogger.child<Levels>(bindings, options))
    const adapter = new MockChannelAdapter()
    const router = new MessageRouter()
    const repo = new StaticFaqRepository(topics)
    const faq = new FaqModule(repo, {
      botName: 'Channels Bot',
      adminName: 'CS Support',
      adminPhone: '6281234567890',
      autoGreet,
      autoGreetCooldownMs,
    })
    router.registerModule(faq)
    return { adapter, router, repo, faq }
  }

  test('activity logs correlate each successful FAQ stage with its sender and incoming message', async () => {
    const lines: string[] = []
    const log = createLogger('info', { write: (line) => { lines.push(line) } })
    const { adapter, router } = createSetup(false, 30_000, undefined, log)
    const ctx = {
      channel: 'whatsapp' as const, chatId: '628123456789@s.whatsapp.net',
      senderId: '628123456789@s.whatsapp.net', senderName: 'private-name',
    }
    await router.routeMessage(adapter, { ...ctx, messageId: 'greeting', text: 'halo' })
    for (const [messageId, actionId] of [
      ['topic', 'faq:topic:payment'], ['question', 'faq:q:pay-promo'], ['support', 'faq:contact'],
    ]) {
      await router.routeInteraction(adapter, {
        ...ctx, messageId, actionId: actionId!, interactionType: 'list',
      })
    }
    const records = lines.map((line) => JSON.parse(line))
    expect(records.map((record) => record.event)).toEqual([
      'faq.topics_sent', 'faq.questions_sent', 'faq.answer_sent', 'faq.support_sent',
    ])
    expect(records.map((record) => record.messageId)).toEqual(['greeting', 'topic', 'question', 'support'])
    for (const record of records) {
      expect(record).toMatchObject({ level: 'info', component: 'faq', phone: '+628123456789', channel: 'whatsapp' })
      expect(record.durationMs).toBeGreaterThanOrEqual(0)
    }
    expect(records[2]).toMatchObject({ topicId: 'payment', questionId: 'pay-promo' })
    expect(lines.join('')).not.toContain('private-name')
    expect(lines.join('')).not.toContain('WELCOME10')
  })

  test('pending and failed sends do not log success or duplicate suppressed auto-greets', async () => {
    const lines: string[] = []
    const log = createLogger('info', { write: (line) => { lines.push(line) } })
    const { adapter, router } = createSetup(true, 30_000, undefined, log)
    const started = Promise.withResolvers<void>()
    const pending = Promise.withResolvers<void>()
    const send = spyOn(adapter, 'sendList').mockImplementationOnce(async () => {
      started.resolve()
      await pending.promise
    })
    const ctx = {
      channel: 'whatsapp' as const, chatId: '628123456789@s.whatsapp.net',
      senderId: '628123456789@s.whatsapp.net', text: 'zzzz',
    }
    const first = router.routeMessage(adapter, { ...ctx, messageId: 'first' })
    await started.promise
    try {
      await router.routeMessage(adapter, { ...ctx, messageId: 'second' })
      expect(lines).toHaveLength(0)
    } finally {
      pending.resolve()
      await first
    }
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'faq.topics_sent', messageId: 'first' })
    send.mockRejectedValueOnce(new Error('offline'))
    await expect(router.routeMessage(adapter, { ...ctx, text: 'menu', messageId: 'failed' })).rejects.toThrow('offline')
    expect(lines).toHaveLength(1)
  })

  test('1. Greeting or trigger message displays FAQ Topics list at the start without header title', async () => {
    const { adapter, router } = createSetup()

    await router.routeMessage(adapter, {
      channel: 'whatsapp',
      chatId: '628111111@s.whatsapp.net',
      senderId: '628111111@s.whatsapp.net',
      senderName: 'Budi',
      text: 'halo',
    })

    expect(adapter.sentLists.length).toBe(1)
    const firstList = adapter.sentLists[0]!
    expect(firstList.chatId).toBe('628111111@s.whatsapp.net')
    expect(firstList.payload.title).toBeUndefined()
    expect(firstList.payload.description).toContain('Halo *Budi*,')
    expect(firstList.payload.buttonText).toBe('Pilih Topik')

    const topicRows = firstList.payload.sections[0]?.rows ?? []
    expect(topicRows.some((r) => r.id === 'faq:topic:general')).toBe(true)
    expect(topicRows.some((r) => r.id === 'faq:topic:order')).toBe(true)
    expect(topicRows.some((r) => r.id === 'faq:topic:payment')).toBe(true)
  })

  test('2. Selecting a topic sends a native list with questions before navigation', async () => {
    const { adapter, router } = createSetup()

    await router.routeInteraction(adapter, {
      channel: 'whatsapp',
      chatId: '628111111@s.whatsapp.net',
      senderId: '628111111@s.whatsapp.net',
      actionId: 'faq:topic:payment',
      interactionType: 'list',
    })

    expect(adapter.sentLists).toHaveLength(1)
    expect(adapter.sentButtons).toHaveLength(0)
    const questionMenu = adapter.sentLists[0]!
    expect(questionMenu.payload.description).toContain('Pembayaran & Promo')
    expect(questionMenu.payload.sections[0]!.rows).toEqual([
      {
        id: 'faq:q:pay-methods', title: 'Metode Pembayaran',
        description: 'Metode pembayaran apa saja yang didukung?',
      },
      {
        id: 'faq:q:pay-promo', title: 'Promo Pengguna Baru',
        description: 'Apakah ada kode promo untuk pengguna baru?',
      },
    ])
    expect(questionMenu.payload.sections[1]!.title).toBe('Navigasi')
  })

  test('3. Selecting a question sends its answer with navigation buttons', async () => {
    const { adapter, router } = createSetup()

    await router.routeInteraction(adapter, {
      channel: 'whatsapp',
      chatId: '628111111@s.whatsapp.net',
      senderId: '628111111@s.whatsapp.net',
      actionId: 'faq:q:pay-promo',
      interactionType: 'list',
    })

    expect(adapter.sentLists).toHaveLength(0)
    expect(adapter.sentButtons).toHaveLength(1)
    expect(adapter.sentTexts).toHaveLength(0)
    const answerMsg = adapter.sentButtons[0]!
    expect(answerMsg.payload.title).toBeUndefined()
    expect(answerMsg.payload.text).toContain('WELCOME10')
    expect(answerMsg.payload.buttons).toEqual([
      { type: 'reply', id: 'faq:topic:payment:0', text: 'Daftar Pertanyaan' },
      { type: 'reply', id: 'faq:home', text: 'Semua Topik' },
      { type: 'reply', id: 'faq:contact', text: 'Hubungi Admin' },
    ])
  })

  test('4. Contact Admin sends a link and phone in the body with a home reply button', async () => {
    const { adapter, router } = createSetup()

    await router.routeInteraction(adapter, {
      channel: 'whatsapp',
      chatId: '628111111@s.whatsapp.net',
      senderId: '628111111@s.whatsapp.net',
      actionId: 'faq:contact',
      interactionType: 'button',
    })

    expect(adapter.sentButtons.length).toBe(1)
    const supportMsg = adapter.sentButtons[0]!
    expect(supportMsg.payload.title).toBeUndefined()
    expect(supportMsg.payload.text).toContain('https://wa.me/6281234567890')
    expect(supportMsg.payload.text).toContain('+6281234567890')
    expect(supportMsg.payload.buttons).toEqual([
      { type: 'reply', id: 'faq:home', text: 'Semua Topik' },
    ])
  })

  test('5. Direct question keyword search answers the matched question immediately', async () => {
    const { adapter, router } = createSetup()

    await router.routeMessage(adapter, {
      channel: 'whatsapp',
      chatId: '628111111@s.whatsapp.net',
      senderId: '628111111@s.whatsapp.net',
      text: 'apakah ada kode promo pengguna baru',
    })

    expect(adapter.sentButtons.length).toBe(1)
    expect(adapter.sentButtons[0]!.payload.text).toContain('WELCOME10')
  })

  test('6. Auto-greet cooldown prevents duplicate menu spam on consecutive unknown messages, while explicit trigger always responds', async () => {
    const { adapter, router } = createSetup(true, 60_000)

    await router.routeMessage(adapter, {
      channel: 'whatsapp',
      chatId: '628999999@s.whatsapp.net',
      senderId: '628999999@s.whatsapp.net',
      text: 'permisi kak',
    })
    expect(adapter.sentLists.length).toBe(1)

    await router.routeMessage(adapter, {
      channel: 'whatsapp',
      chatId: '628999999@s.whatsapp.net',
      senderId: '628999999@s.whatsapp.net',
      text: 'saya mau nanya sesuatu',
    })
    expect(adapter.sentLists.length).toBe(1)

    await router.routeMessage(adapter, {
      channel: 'whatsapp',
      chatId: '628999999@s.whatsapp.net',
      senderId: '628999999@s.whatsapp.net',
      text: 'menu',
    })
    expect(adapter.sentLists.length).toBe(2)
  })

  test('greeting appears once and subsequent stages keep copy focused on the current task', async () => {
    const { adapter, faq } = createSetup(false)
    const chatId = 'chat'
    await faq.sendTopicsMenu(adapter, chatId, 'Budi')
    expect(adapter.sentLists[0]!.payload.description).toContain('Halo *Budi*,')
    expect(adapter.sentLists[0]!.payload.footerText).toBe('Menu tidak tampil? Ketik teks.')
    await faq.sendTopicQuestionsList(adapter, chatId, 'payment')
    const questions = adapter.sentLists.at(-1)!.payload
    expect(questions.description).toBe('*Pembayaran & Promo*\n\nPilih pertanyaan yang ingin Anda tanyakan.')
    expect(questions.footerText).toBeUndefined()
    await faq.sendQuestionAnswer(adapter, chatId, 'pay-promo')
    const answer = adapter.sentButtons.at(-1)!.payload
    expect(answer.text).toContain('WELCOME10')
    expect(answer.text).not.toContain('Ketik')
    expect(answer.footer).toBeUndefined()
    await faq.sendTopicsMenu(adapter, chatId, 'Budi')
    const topics = adapter.sentLists.at(-1)!.payload
    expect(topics.description).toBe('*Topik FAQ*\n\nPilih topik bantuan yang Anda butuhkan.')
    expect(topics.footerText).toBeUndefined()
  })

  for (const cooldown of [0, 30_000]) {
    test(`concurrent unknown messages send one auto-greet with cooldown ${cooldown}`, async () => {
      const { adapter, faq } = createSetup(true, cooldown)
      const started = Promise.withResolvers<void>()
      const pending = Promise.withResolvers<void>()
      const send = spyOn(adapter, 'sendList').mockImplementationOnce(async () => {
        started.resolve()
        await pending.promise
      })
      const ctx = { channel: 'whatsapp' as const, chatId: 'chat', senderId: 'chat', text: 'zzzz' }
      const first = faq.handleMessage(adapter, ctx)
      await started.promise
      try {
        expect(await faq.handleMessage(adapter, { ...ctx, text: 'yyyy' })).toBe(false)
        expect(send).toHaveBeenCalledTimes(1)
      } finally {
        pending.resolve()
        await first
        send.mockRestore()
      }
      expect(await faq.handleMessage(adapter, ctx)).toBe(cooldown === 0)
    })
  }

  test('a pending auto-greet does not block other chats or explicit menu commands', async () => {
    const { adapter, faq } = createSetup()
    const started = Promise.withResolvers<void>()
    const pending = Promise.withResolvers<void>()
    const send = spyOn(adapter, 'sendList').mockImplementationOnce(async () => {
      started.resolve()
      await pending.promise
    })
    const ctx = { channel: 'whatsapp' as const, chatId: 'chat', senderId: 'chat', text: 'zzzz' }
    const first = faq.handleMessage(adapter, ctx)
    await started.promise
    try {
      expect(await faq.handleMessage(adapter, { ...ctx, chatId: 'other', senderId: 'other' })).toBe(true)
      expect(await faq.handleMessage(adapter, { ...ctx, text: 'menu' })).toBe(true)
      expect(send).toHaveBeenCalledTimes(3)
    } finally {
      pending.resolve()
      await first
      send.mockRestore()
    }
  })

  test('failed auto-greets release the in-flight guard without starting the cooldown', async () => {
    const { adapter, faq } = createSetup()
    const send = spyOn(adapter, 'sendList').mockRejectedValueOnce(new Error('offline'))
    const ctx = { channel: 'whatsapp' as const, chatId: 'chat', senderId: 'chat', text: 'zzzz' }
    try {
      await expect(faq.handleMessage(adapter, ctx)).rejects.toThrow('offline')
      expect(await faq.handleMessage(adapter, ctx)).toBe(true)
      expect(send).toHaveBeenCalledTimes(2)
    } finally {
      send.mockRestore()
    }
  })

  test('an empty FAQ offers help directly instead of an empty picker', async () => {
    const { adapter, faq } = createSetup(false, 0, [])
    await faq.sendTopicsMenu(adapter, 'chat')
    expect(adapter.sentLists).toHaveLength(0)
    expect(adapter.sentButtons).toHaveLength(1)
    expect(adapter.sentButtons[0]!.payload.text).toContain('Informasi FAQ belum tersedia')
    expect(adapter.sentButtons[0]!.payload.buttons).toEqual([
      { type: 'reply', id: 'faq:contact', text: 'Hubungi Admin' },
    ])
  })

  test('pagination exposes every topic and question with at most ten rows per menu', async () => {
    const topics = Array.from({ length: 17 }, (_, topicIndex) => ({
      id: `topic-${topicIndex}`,
      title: `Topik ${topicIndex}`,
      questions: Array.from({ length: 15 }, (_, questionIndex) => ({
        id: `q-${topicIndex}-${questionIndex}`,
        question: `Pertanyaan ${questionIndex}`,
        answer: `Jawaban ${questionIndex}`,
      })),
    }))
    const { adapter, faq } = createSetup(false, 0, topics)
    const chatId = '628111111@s.whatsapp.net'
    const select = (actionId: string) => faq.handleInteraction(adapter, {
      channel: 'whatsapp', chatId, senderId: chatId, actionId, interactionType: 'list',
    })

    for (const [initialAction, prefix, expected] of [
      ['faq:home', 'faq:topics:', topics.map((topic) => `faq:topic:${topic.id}`)],
      ['faq:topic:topic-0', 'faq:topic:topic-0:', topics[0]!.questions.map((q) => `faq:q:${q.id}`)],
    ] as const) {
      const seen = new Set<string>()
      let next: string | undefined = initialAction
      let page = 0
      while (next) {
        expect(await select(next)).toBe(true)
        const payload = adapter.sentLists.at(-1)!.payload
        const rows = payload.sections.flatMap((section) => section.rows)
        expect(payload.footerText).toBe(`Halaman ${page + 1} dari 3`)
        expect(rows.length).toBeLessThanOrEqual(10)
        expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length)
        for (const row of rows) {
          if (expected.includes(row.id)) seen.add(row.id)
        }
        if (page > 0) {
          expect(rows.some((row) => row.id === `${prefix}${page - 1}`)).toBe(true)
        }
        next = rows.find((row) => row.id === `${prefix}${page + 1}`)?.id
        page++
        expect(page).toBeLessThanOrEqual(3)
      }
      expect([...seen]).toEqual([...expected])
    }
  })

  test('back button and kembali reopen the answered question page while menu resets the topic', async () => {
    const topics = [{
      id: 'many', title: 'Banyak pertanyaan',
      questions: Array.from({ length: 15 }, (_, index) => ({
        id: `q-${index}`, question: `Pertanyaan ${index}`, answer: `Jawaban ${index}`,
      })),
    }]
    const { adapter, faq } = createSetup(false, 0, topics)
    const chatId = '628111111@s.whatsapp.net'
    const context = { channel: 'whatsapp' as const, chatId, senderId: chatId }
    await faq.sendQuestionAnswer(adapter, chatId, 'q-8')
    const back = adapter.sentButtons.at(-1)!.payload.buttons[0]!
    expect(back).toEqual({ type: 'reply', id: 'faq:topic:many:1', text: 'Daftar Pertanyaan' })
    if (back.type !== 'reply') throw new Error('Expected reply button')
    await faq.handleInteraction(adapter, {
      ...context, actionId: back.id, interactionType: 'button',
    })
    expect(adapter.sentLists.at(-1)!.payload.sections[0]?.rows[0]?.id).toBe('faq:q:q-6')
    await faq.sendContactSupport(adapter, chatId)
    await faq.handleMessage(adapter, { ...context, text: 'kembali' })
    expect(adapter.sentLists.at(-1)!.payload.sections[0]?.rows[0]?.id).toBe('faq:q:q-6')
    await faq.handleMessage(adapter, {
      ...context, chatId: 'other', senderId: 'other', text: 'kembali',
    })
    expect(adapter.sentLists.at(-1)!.payload.buttonText).toBe('Pilih Topik')
    await faq.handleMessage(adapter, { ...context, text: 'menu' })
    await faq.handleMessage(adapter, { ...context, text: 'kembali' })
    expect(adapter.sentLists.at(-1)!.payload.buttonText).toBe('Pilih Topik')
  })

  test('failed answers preserve the current topic for text navigation', async () => {
    const { adapter, faq } = createSetup(false)
    const chatId = '628111111@s.whatsapp.net'
    await faq.sendTopicQuestionsList(adapter, chatId, 'payment')
    const sendButtons = spyOn(adapter, 'sendButtons').mockRejectedValueOnce(new Error('offline'))
    await expect(faq.sendQuestionAnswer(adapter, chatId, 'gen-hours')).rejects.toThrow('offline')
    sendButtons.mockRestore()
    await faq.handleMessage(adapter, {
      channel: 'whatsapp', chatId, senderId: chatId, text: 'kembali',
    })
    expect(adapter.sentLists.at(-1)!.payload.description).toContain('Pembayaran & Promo')
  })

  test('empty topics and out-of-range pages still offer valid navigation', async () => {
    const { adapter, faq } = createSetup(false, 0, [{ id: 'empty', title: 'Kosong', questions: [] }])
    await faq.sendTopicQuestionsList(adapter, 'chat', 'empty', 100)
    expect(adapter.sentButtons.at(-1)!.payload.text).toContain('Belum ada pertanyaan')
    expect(adapter.sentButtons.at(-1)!.payload.buttons).toEqual([
      { type: 'reply', id: 'faq:home', text: 'Semua Topik' },
      { type: 'reply', id: 'faq:contact', text: 'Hubungi Admin' },
    ])
    await faq.sendTopicsMenu(adapter, 'chat', undefined, 100)
    expect(adapter.sentLists.at(-1)!.payload.sections[0]?.rows[0]?.id).toBe('faq:topic:empty')
  })

  test('FAQ list labels fit native rows and full questions appear once in descriptions', async () => {
    const { adapter, faq, repo } = createSetup(false)
    await faq.sendTopicsMenu(adapter, 'chat')
    for (const row of adapter.sentLists.at(-1)!.payload.sections.flatMap((section) => section.rows)) {
      expect(row.title.length).toBeLessThanOrEqual(24)
      expect(row.title).not.toContain('…')
    }
    for (const topic of await repo.getAllTopics()) {
      await faq.sendTopicQuestionsList(adapter, 'chat', topic.id)
      const rows = adapter.sentLists.at(-1)!.payload.sections[0]!.rows
      for (const question of topic.questions) {
        const row = rows.find((entry) => entry.id === `faq:q:${question.id}`)!
        expect(row.title.length).toBeLessThanOrEqual(24)
        expect(row.title).not.toContain('…')
        expect(row.title).toBe(question.label!)
        expect(row.description).toBe(question.question)
      }
    }
  })

  for (const count of [1, 2, 3, 4]) {
    test(`${count} questions use one native list consistently`, async () => {
      const topic = {
        id: 'size', title: 'Ukuran menu',
        questions: Array.from({ length: count }, (_, index) => ({
          id: `q-${index}`, label: `Label ${index}`,
          question: `Pertanyaan lengkap nomor ${index}`, answer: `Jawaban ${index}`,
        })),
      }
      const { adapter, faq } = createSetup(false, 0, [topic])
      await faq.sendTopicQuestionsList(adapter, 'chat', topic.id)
      expect(adapter.sentButtons).toHaveLength(0)
      expect(adapter.sentLists).toHaveLength(1)
      const rows = adapter.sentLists[0]!.payload.sections[0]!.rows
      expect(rows).toHaveLength(count)
      expect(rows[0]).toEqual({
        id: 'faq:q:q-0', title: 'Label 0', description: 'Pertanyaan lengkap nomor 0',
      })
    })
  }

  test('an answer in a single-question topic sends no additional question list', async () => {
    const { adapter, faq } = createSetup(false, 0, [{
      id: 'single', title: 'Satu pertanyaan',
      questions: [{ id: 'only', question: 'Pertanyaan tunggal', answer: 'Jawaban tunggal' }],
    }])
    await faq.sendQuestionAnswer(adapter, 'chat', 'only')
    const payload = adapter.sentButtons[0]!.payload
    expect(payload.text).toContain('Jawaban tunggal')
    expect(payload.buttons).toHaveLength(3)
    expect(adapter.sentLists).toHaveLength(0)
  })

  test('7. WhatsApp numbered menu formatting and numeric selection resolve to actionId without nativeFlowMessage', () => {
    const router = new MessageRouter()
    const wa = new WhatsAppAdapter(
      { sessionId: 'test', authType: 'qr' },
      router,
    )

    const formattedList = formatNumberedListMessage({
      description: 'Silakan pilih topik:',
      buttonText: 'Pilih Topik FAQ',
      sections: [
        {
          title: 'Daftar Topik FAQ',
          rows: [
            { id: 'faq:topic:general', title: 'Informasi Umum' },
            { id: 'faq:topic:payment', title: 'Pembayaran & Promo' },
          ],
        },
        {
          title: 'Bantuan Lainnya',
          rows: [{ id: 'faq:contact', title: 'Hubungi Layanan Pelanggan' }],
        },
      ],
    })

    expect(formattedList.text).toContain('1. Informasi Umum')
    expect(formattedList.text).toContain('2. Pembayaran & Promo')
    expect(formattedList.text).toContain('3. Hubungi Layanan Pelanggan')
    expect(formattedList.options.length).toBe(3)

    wa.saveMenuOptions('628111111@s.whatsapp.net', formattedList.options)

    expect(wa.resolveMenuSelection('628111111@s.whatsapp.net', '2')).toEqual({
      id: 'faq:topic:payment',
      title: 'Pembayaran & Promo',
      type: 'list',
    })
    expect(wa.resolveMenuSelection('628111111@s.whatsapp.net', '#3.')).toEqual({
      id: 'faq:contact',
      title: 'Hubungi Layanan Pelanggan',
      type: 'list',
    })
    expect(
      wa.resolveMenuSelection('628111111@s.whatsapp.net', 'informasi umum'),
    ).toEqual({
      id: 'faq:topic:general',
      title: 'Informasi Umum',
      type: 'list',
    })
    expect(wa.resolveMenuSelection('628111111@s.whatsapp.net', '99')).toBeNull()

    const formattedButtons = formatNumberedButtonsMessage({
      text: 'Gunakan kode WELCOME10.',
      buttons: [
        { type: 'copy', text: 'Kode Promo', code: 'WELCOME10' },
        { type: 'url', text: 'Chat Admin', url: 'https://wa.me/6281234567890' },
        { type: 'reply', id: 'faq:home', text: 'Semua Topik FAQ' },
      ],
    })

    expect(formattedButtons.text).toContain('*Kode Promo:* WELCOME10')
    expect(formattedButtons.text).toContain(
      '*Chat Admin:* https://wa.me/6281234567890',
    )
    expect(formattedButtons.text).toContain('1. Semua Topik FAQ')
    expect(formattedButtons.options).toEqual([
      { id: 'faq:home', title: 'Semua Topik FAQ', type: 'button' },
    ])
  })

  test('8. extractInteractiveAction unwraps ephemeralMessage and viewOnceMessage wrappers', () => {
    const wrapped = {
      ephemeralMessage: {
        message: {
          viewOnceMessage: {
            message: {
              interactiveResponseMessage: {
                body: { text: 'Pembayaran & Promo' },
                nativeFlowResponseMessage: {
                  name: 'single_select',
                  paramsJson: JSON.stringify({
                    id: 'faq:topic:payment',
                    title: 'Pembayaran & Promo',
                  }),
                },
              },
            },
          },
        },
      },
    }

    expect(extractInteractiveAction(wrapped)).toEqual({
      actionId: 'faq:topic:payment',
      label: 'Pembayaran & Promo',
      interactionType: 'list',
    })
  })
})
