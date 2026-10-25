import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import * as zaileys from 'zaileys'
import {
  WhatsAppAdapter,
  extractInteractiveAction,
} from '../src/channels/whatsapp/whatsapp.adapter.ts'
import { MessageRouter } from '../src/core/router.ts'
import { createLogger, logger } from '../src/core/logger.ts'
import type { Bindings, ChildLoggerOptions } from 'pino'
import { FaqModule } from '../src/modules/faq/faq.handler.ts'
import { StaticFaqRepository } from '../src/modules/faq/faq.repository.ts'

const CHAT_ID = '628111111@s.whatsapp.net'

afterEach(() => mock.restore())

async function createSetup(
  menuMode?: 'text' | 'native',
  appLogger = createLogger('silent'),
) {
  spyOn(logger, 'child').mockImplementation(<Levels extends string = never>(
    bindings: Bindings, options?: ChildLoggerOptions<Levels>,
  ) => appLogger.child<Levels>(bindings, options))
  const client = new zaileys.Client({ sessionId: 'test', autoConnect: false })
  const clientConstructor = spyOn(zaileys as unknown as {
    Client: (options: zaileys.ClientOptions) => zaileys.Client
  }, 'Client')
    .mockReturnValue(client)
  const router = new MessageRouter()
  const routeInteraction = spyOn(router, 'routeInteraction').mockResolvedValue()
  const routeMessage = spyOn(router, 'routeMessage').mockResolvedValue()
  const adapter = new WhatsAppAdapter(
    { sessionId: 'test', authType: 'qr', menuMode },
    router,
  )
  await adapter.start()
  return {
    adapter, client, router, routeInteraction, routeMessage,
    clientOptions: clientConstructor.mock.calls[0]![0],
  }
}

function mockSender(client: zaileys.Client) {
  type Builder = ReturnType<typeof client.send>
  const text = mock(async (_text: string) => ({ id: 'sent' }))
  const list = mock(async (_payload: Parameters<Builder['list']>[0]) => ({ id: 'sent' }))
  const buttons = mock(async (
    _buttons: Parameters<Builder['buttons']>[0],
    _content?: Parameters<Builder['buttons']>[1],
  ) => ({ id: 'sent' }))
  spyOn(client, 'send').mockReturnValue({ text, list, buttons } as unknown as Builder)
  return { text, list, buttons }
}

function emitText(client: zaileys.Client, text: string, chatId = CHAT_ID) {
  client.emit('text', {
    ...messageContext(text, false, { conversation: text }),
    text,
    roomId: chatId,
    senderId: chatId,
  })
}

function messageContext(
  id: string,
  isOld: boolean,
  message: Parameters<typeof zaileys.buildMessageContext>[0]['message']['message'],
) {
  const key = { id, remoteJid: CHAT_ID, fromMe: false }
  return zaileys.buildMessageContext({
    message: { key, message },
    key,
    channelId: 'test',
    receiverId: '628222222@s.whatsapp.net',
    selfJid: '628222222@s.whatsapp.net',
    sender: { jid: CHAT_ID },
    text: 'Pilihan',
    chatType: 'text',
    mentions: [],
    isViewOnce: false,
    isEphemeral: false,
    isForwarded: false,
    isBroadcast: false,
    isNewsletter: false,
    isOld,
    prefixes: [],
    resolveRoomName: async () => null,
    resolveReceiverName: async () => null,
    resolveReplied: async () => null,
    reply: async () => key,
    react: async () => key,
  })
}

describe('Zaileys application logging', () => {
  test('reports credential and pairing failures through the application logger at info level', async () => {
    const lines: string[] = []
    const appLogger = createLogger('info', { write: (line) => { lines.push(line) } })
    const { adapter, clientOptions } = await createSetup('native', appLogger)
    try {
      const log = clientOptions.logger
      expect(log).toBeDefined()
      if (!log) throw new Error('Expected a Zaileys logger')
      const cause = Object.assign(new Error('No space left on device'), { code: 'ENOSPC' })
      const err = Object.assign(new Error('Failed to write credentials', { cause }), {
        code: 'STORE_WRITE_FAILED', creds: 'private-session', raw: 'private-payload',
      })
      log.warn(err, 'auth.creds.writeCreds failed')
      log.warn(new Error('Invalid pairing phone number'), 'pairing-code request failed')
      log.info({ sessionId: 'test' }, 'Connection status')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]!)).toMatchObject({
        level: 'warn', component: 'zaileys', sessionId: 'test',
        msg: 'auth.creds.writeCreds failed',
        err: { code: 'STORE_WRITE_FAILED', cause: { code: 'ENOSPC' } },
      })
      expect(JSON.parse(lines[1]!)).toMatchObject({
        level: 'warn', component: 'zaileys', sessionId: 'test',
        msg: 'pairing-code request failed', err: { message: 'Invalid pairing phone number' },
      })
      expect(lines.join('')).not.toContain('private-')
    } finally {
      await adapter.stop()
    }
  })

  test('does not repeat internal failures through client event listeners', async () => {
    const lines: string[] = []
    const appLogger = createLogger('info', { write: (line) => { lines.push(line) } })
    const { adapter, client, clientOptions } = await createSetup('native', appLogger)
    try {
      const err = new Error('Connect failed')
      clientOptions.logger!.error(err, 'auto-connect failed')
      client.emit('error', { sessionId: 'test', error: err })
      clientOptions.logger!.warn({ kind: 'qr', attempts: 5, max: 5 }, 'auth attempts exhausted')
      client.emit('auth-exhausted', { sessionId: 'test', kind: 'qr', attempts: 5, max: 5 })
      expect(lines).toHaveLength(2)
      expect(lines.map((line) => JSON.parse(line).msg)).toEqual([
        'auto-connect failed', 'auth attempts exhausted',
      ])
    } finally {
      await adapter.stop()
    }
  })

  for (const level of ['error', 'silent', 'debug'] as const) {
    test(`respects the ${level} application log level`, async () => {
      const lines: string[] = []
      const appLogger = createLogger(level, { write: (line) => { lines.push(line) } })
      const { adapter, clientOptions } = await createSetup('native', appLogger)
      try {
        clientOptions.logger!.debug('Diagnostic details')
        clientOptions.logger!.warn(new Error('Write failed'), 'auth.creds.writeCreds failed')
        clientOptions.logger!.error(new Error('Connect failed'), 'auto-connect failed')
        expect(lines.map((line) => JSON.parse(line).level)).toEqual(
          level === 'debug' ? ['debug', 'warn', 'error'] : level === 'error' ? ['error'] : [],
        )
      } finally {
        await adapter.stop()
      }
    })
  }
})

describe('wrapped native-flow aliases', () => {
  for (const wrapper of ['ephemeralMessage', 'viewOnceMessage']) {
    for (const alias of ['row_id', 'button_id']) {
      test(`${wrapper} accepts ${alias} and preserves its interaction type`, () => {
        expect(
          extractInteractiveAction({
            [wrapper]: {
              message: {
                interactiveResponseMessage: {
                  body: { text: 'Pilihan' },
                  nativeFlowResponseMessage: {
                    paramsJson: JSON.stringify({ [alias]: 'faq:home' }),
                  },
                },
              },
            },
          }),
        ).toEqual({
          actionId: 'faq:home',
          label: 'Pilihan',
          interactionType: alias === 'row_id' ? 'list' : 'button',
        })
      })
    }
  }
})

describe('interaction events after reconnect', () => {
  test('a failed interaction is logged once across message and button-click events', async () => {
    const lines: string[] = []
    const appLogger = createLogger('info', { write: (line) => { lines.push(line) } })
    const { adapter, client, routeInteraction } = await createSetup('native', appLogger)
    routeInteraction.mockRejectedValueOnce(Object.assign(new Error('Send failed'), {
      code: 'SEND_FAILED', raw: { text: 'private-message', creds: 'private-session' },
    }))
    client.emit('message', messageContext('failed-tap', false, {
      buttonsResponseMessage: {
        selectedButtonId: 'faq:home', selectedDisplayText: 'private-message',
      },
    }))
    client.emit('button-click', {
      key: { id: 'failed-tap', remoteJid: CHAT_ID },
      buttonId: 'faq:home', sender: { jid: CHAT_ID }, timestamp: 1,
    })
    await Bun.sleep(0)
    expect(routeInteraction).toHaveBeenCalledTimes(1)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: 'whatsapp.inbound_failed', component: 'whatsapp',
      source: 'message', messageId: 'failed-tap', phone: '+628111111', err: { code: 'SEND_FAILED' },
    })
    expect(lines[0]).not.toContain('private-')
    expect(lines[0]).not.toContain(CHAT_ID)
    emitText(client, 'hello')
    await Bun.sleep(0)
    expect(lines).toHaveLength(1)
    await adapter.stop()
  })

  for (const interactionType of ['list', 'button'] as const) {
    test(`${interactionType} ignores old messages and routes live interactions once`, async () => {
      const { adapter, client, routeInteraction, routeMessage } =
        await createSetup()
      const previousOption = {
        id: 'previous', title: 'Menu aktif', type: 'list' as const,
      }
      adapter.saveMenuOptions(CHAT_ID, [previousOption])
      const content = interactionType === 'list'
        ? {
            listResponseMessage: {
              singleSelectReply: { selectedRowId: 'faq:home' },
              title: 'Pilihan',
            },
          }
        : {
            buttonsResponseMessage: {
              selectedButtonId: 'faq:home',
              selectedDisplayText: 'Pilihan',
            },
          }

      const emitInteraction = (id: string) => {
        const payload = {
          key: { id, remoteJid: CHAT_ID, fromMe: false },
          sender: { jid: CHAT_ID },
          timestamp: 1,
        }
        if (interactionType === 'list') {
          client.emit('list-select', {
            ...payload, rowId: 'faq:home', title: 'Pilihan',
          })
        } else {
          client.emit('button-click', {
            ...payload, buttonId: 'faq:home', buttonText: 'Pilihan',
          })
        }
      }

      client.emit('message', messageContext('old', true, content))
      emitInteraction('old')
      await Bun.sleep(0)
      expect(routeInteraction).not.toHaveBeenCalled()
      expect(routeMessage).not.toHaveBeenCalled()
      expect(adapter.resolveMenuSelection(CHAT_ID, '1')).toEqual(previousOption)

      client.emit('message', messageContext('live', false, content))
      emitInteraction('live')
      await Bun.sleep(0)
      expect(routeInteraction).toHaveBeenCalledTimes(1)
      expect(routeInteraction.mock.calls[0]?.[1]).toMatchObject({
        actionId: 'faq:home', interactionType, chatId: CHAT_ID,
      })

      client.emit('message', messageContext('event-only', false, {
        conversation: 'Pilihan',
      }))
      emitInteraction('event-only')
      await Bun.sleep(0)
      expect(routeInteraction).toHaveBeenCalledTimes(2)
      expect(routeInteraction.mock.calls[1]?.[1]).toMatchObject({
        actionId: 'faq:home', interactionType, chatId: CHAT_ID,
      })
      await adapter.stop()
    })
  }
})

describe('menu state follows successful sends', () => {
  for (const menuType of ['list', 'button'] as const) {
    test(`${menuType} preserves the visible menu on failure and updates after success`, async () => {
      const { adapter, client } = await createSetup('text')
      const sendText = mock((_text: string): Promise<void> => Promise.resolve())
      const send = spyOn(client, 'send').mockReturnValue({
        text: sendText,
      } as unknown as ReturnType<typeof client.send>)
      const previousOption = {
        id: 'previous', title: 'Menu aktif', type: 'list' as const,
      }
      adapter.saveMenuOptions(CHAT_ID, [previousOption])

      const sendMenu = () => menuType === 'list'
        ? adapter.sendList(CHAT_ID, {
            description: 'Menu baru',
            buttonText: 'Pilih',
            sections: [{ title: '', rows: [{ id: 'next', title: 'Berikutnya' }] }],
          })
        : adapter.sendButtons(CHAT_ID, {
            text: 'Menu baru',
            buttons: [{ type: 'reply', id: 'next', text: 'Berikutnya' }],
          })

      const failed = Promise.withResolvers<void>()
      sendText.mockReturnValueOnce(failed.promise)
      const failedSend = sendMenu()
      void failedSend.catch(() => {})
      await Bun.sleep(0)
      expect(sendText).toHaveBeenCalledTimes(1)
      expect(adapter.resolveMenuSelection(CHAT_ID, '1')).toEqual(previousOption)
      failed.reject(new Error('Connection lost'))
      await expect(failedSend).rejects.toThrow('Connection lost')
      expect(adapter.resolveMenuSelection(CHAT_ID, '1')).toEqual(previousOption)

      const successful = Promise.withResolvers<void>()
      sendText.mockReturnValueOnce(successful.promise)
      const successfulSend = sendMenu()
      await Bun.sleep(0)
      expect(sendText).toHaveBeenCalledTimes(2)
      expect(adapter.resolveMenuSelection(CHAT_ID, '1')).toEqual(previousOption)
      successful.resolve()
      await successfulSend
      expect(adapter.resolveMenuSelection(CHAT_ID, '1')).toEqual({
        id: 'next', title: 'Berikutnya', type: menuType,
      })
      expect(send).toHaveBeenCalledWith(CHAT_ID)
      expect(sendText.mock.calls[1]?.[0]).toContain('1. Berikutnya')
      await adapter.stop()
    })
  }
})

describe('menu modes', () => {
  const payload = {
    description: 'Pilih pertanyaan',
    buttonText: 'Pilih',
    sections: [{
      title: 'Pertanyaan',
      rows: [{ id: 'faq:q:pay-methods', title: 'Metode pembayaran apa saja yang didukung?' }],
    }],
  }

  test('native is the default and sends a list and reply buttons without duplicate text messages', async () => {
    const { adapter, client } = await createSetup()
    const { text, list, buttons } = mockSender(client)
    await adapter.sendList(CHAT_ID, payload)
    expect(list).toHaveBeenCalledTimes(1)
    const row = list.mock.calls[0]?.[0].sections[0]?.rows[0]
    expect(row?.title.length).toBeLessThanOrEqual(24)
    expect(row?.title).toBe('Pilihan 1')
    expect(row?.description).toBe(payload.sections[0]?.rows[0]?.title)
    await adapter.sendButtons(CHAT_ID, {
      text: 'Jawaban',
      buttons: [{ type: 'reply', id: 'faq:home', text: 'Semua Topik FAQ' }],
    })
    expect(buttons).toHaveBeenCalledTimes(1)
    expect(text).not.toHaveBeenCalled()
    expect(adapter.resolveMenuSelection(CHAT_ID, '1')?.id).toBe('faq:home')
    await adapter.stop()
  })

  test('native journey uses consistent lists for browsing and buttons for answer actions', async () => {
    const lines: string[] = []
    const appLogger = createLogger('info', { write: (line) => { lines.push(line) } })
    const { adapter, client, router, routeMessage, routeInteraction } = await createSetup('native', appLogger)
    routeMessage.mockRestore()
    routeInteraction.mockRestore()
    const incomingMessages = spyOn(router, 'routeMessage')
    router.registerModule(new FaqModule(new StaticFaqRepository(), {
      botName: 'Bot', adminName: 'Admin', adminPhone: '6281234567890', autoGreet: false,
    }))
    const { text, list, buttons } = mockSender(client)
    const pick = (rowId: string) => client.emit('list-select', {
      key: { id: rowId, remoteJid: CHAT_ID, fromMe: false },
      rowId,
      sender: { jid: CHAT_ID },
      timestamp: 1,
    })
    const click = (buttonId: string) => client.emit('button-click', {
      key: { id: buttonId, remoteJid: CHAT_ID, fromMe: false },
      buttonId, sender: { jid: CHAT_ID }, timestamp: 1,
    })

    emitText(client, 'halo')
    await Bun.sleep(0)
    expect(list).toHaveBeenCalledTimes(1)
    expect(list.mock.calls[0]![0].description).toContain('Halo,')
    expect(list.mock.calls[0]![0].buttonText).toBe('Pilih Topik')
    expect(buttons).not.toHaveBeenCalled()
    pick('faq:topic:payment')
    await Bun.sleep(0)
    expect(list).toHaveBeenCalledTimes(2)
    expect(buttons).not.toHaveBeenCalled()
    expect(list.mock.calls[1]![0].sections[0]!.rows).toEqual([
      {
        id: 'faq:q:pay-methods', title: 'Metode Pembayaran',
        description: 'Metode pembayaran apa saja yang didukung?',
      },
      {
        id: 'faq:q:pay-promo', title: 'Promo Pengguna Baru',
        description: 'Apakah ada kode promo untuk pengguna baru?',
      },
    ])
    pick('faq:q:pay-methods')
    await Bun.sleep(0)
    expect(list).toHaveBeenCalledTimes(2)
    expect(buttons).toHaveBeenCalledTimes(1)
    expect(buttons.mock.calls[0]![1]?.text).toContain('QRIS')
    expect(buttons.mock.calls[0]![1]?.bottomSheet).toBeUndefined()
    expect(buttons.mock.calls[0]![0]).toEqual([
      { type: 'reply', id: 'faq:topic:payment:0', text: 'Daftar Pertanyaan' },
      { type: 'reply', id: 'faq:home', text: 'Semua Topik' },
      { type: 'reply', id: 'faq:contact', text: 'Hubungi Admin' },
    ])
    click('faq:topic:payment:0')
    await Bun.sleep(0)
    expect(list).toHaveBeenCalledTimes(3)
    expect(buttons).toHaveBeenCalledTimes(1)
    expect(list.mock.calls[2]![0].description).toContain('*Pembayaran & Promo*')
    pick('faq:q:pay-promo')
    await Bun.sleep(0)
    expect(list).toHaveBeenCalledTimes(3)
    expect(buttons).toHaveBeenCalledTimes(2)
    expect(buttons.mock.calls[1]![1]?.text).toContain('WELCOME10')
    expect(incomingMessages).toHaveBeenCalledTimes(1)
    const records = lines.map((line) => JSON.parse(line))
    expect(records.map((record) => record.event)).toEqual([
      'faq.topics_sent', 'faq.questions_sent', 'faq.answer_sent',
      'faq.questions_sent', 'faq.answer_sent',
    ])
    expect(records.map((record) => record.messageId)).toEqual([
      'halo', 'faq:topic:payment', 'faq:q:pay-methods',
      'faq:topic:payment:0', 'faq:q:pay-promo',
    ])
    for (const record of records) {
      expect(record).toMatchObject({ phone: '+628111111', component: 'faq' })
    }
    expect(text).not.toHaveBeenCalled()
    emitText(client, 'teks')
    await Bun.sleep(0)
    expect(text).toHaveBeenCalledTimes(1)
    expect(text.mock.calls[0]![0]).toContain('WELCOME10')
    expect(text.mock.calls[0]![0]).toContain('1. Daftar Pertanyaan')
    emitText(client, '1')
    await Bun.sleep(0)
    expect(text).toHaveBeenCalledTimes(2)
    expect(text.mock.calls[1]![0]).toContain('*Pembayaran & Promo*')
    expect(list).toHaveBeenCalledTimes(3)
    await adapter.stop()
  })

  test('teks replays the active menu and changes only that chat to numbered menus', async () => {
    const { adapter, client, routeMessage } = await createSetup('native')
    const { text, list } = mockSender(client)
    await adapter.sendList(CHAT_ID, payload)
    emitText(client, ' TeKs ')
    await Bun.sleep(0)
    expect(text).toHaveBeenCalledTimes(1)
    expect(text.mock.calls[0]?.[0]).toContain('1. Metode pembayaran')
    expect(routeMessage).not.toHaveBeenCalled()
    await adapter.sendList(CHAT_ID, payload)
    expect(text).toHaveBeenCalledTimes(2)
    await adapter.sendList('628999999@s.whatsapp.net', payload)
    expect(list).toHaveBeenCalledTimes(2)
    await adapter.stop()
  })

  test('failed native sends preserve the previous menu without sending a second message', async () => {
    const { adapter, client } = await createSetup('native')
    const { text, list } = mockSender(client)
    await adapter.sendList(CHAT_ID, payload)
    list.mockRejectedValueOnce(new Error('Connection lost'))
    await expect(adapter.sendList(CHAT_ID, {
      ...payload,
      sections: [{ title: 'New', rows: [{ id: 'new', title: 'New option' }] }],
    })).rejects.toThrow('Connection lost')
    expect(adapter.resolveMenuSelection(CHAT_ID, '1')?.id).toBe('faq:q:pay-methods')
    expect(text).not.toHaveBeenCalled()
    await adapter.stop()
  })

  test('failed teks delivery preserves the current native mode', async () => {
    const { adapter, client } = await createSetup('native')
    const { text, list } = mockSender(client)
    await adapter.sendList(CHAT_ID, payload)
    text.mockRejectedValueOnce(new Error('offline'))
    emitText(client, 'teks')
    await Bun.sleep(0)
    await adapter.sendList(CHAT_ID, payload)
    expect(list).toHaveBeenCalledTimes(2)
    expect(text).toHaveBeenCalledTimes(1)
    expect(adapter.resolveMenuSelection(CHAT_ID, '1')?.id).toBe('faq:q:pay-methods')
    await adapter.stop()
  })

  test('navigation commands take priority over matching menu labels', async () => {
    const { adapter, client, routeMessage, routeInteraction } = await createSetup()
    mockSender(client)
    await adapter.sendList(CHAT_ID, {
      ...payload,
      sections: [{ title: 'Navigasi', rows: [
        { id: 'wrong-menu', title: 'menu' },
        { id: 'wrong-back', title: 'kembali' },
      ] }],
    })
    emitText(client, 'menu')
    emitText(client, 'kembali')
    await Bun.sleep(0)
    expect(routeMessage).toHaveBeenCalledTimes(2)
    expect(routeInteraction).not.toHaveBeenCalled()
    await adapter.stop()
  })

  test('a menu without selectable options clears previous numeric choices', async () => {
    const { adapter, client } = await createSetup()
    mockSender(client)
    await adapter.sendList(CHAT_ID, payload)
    await adapter.sendButtons(CHAT_ID, { text: 'Selesai', buttons: [] })
    expect(adapter.resolveMenuSelection(CHAT_ID, '1')).toBeNull()
    await adapter.stop()
  })

  for (const startWithText of [false, true]) {
    test(`FAQ text navigation works with ${startWithText ? 'teks' : 'menu'} as the first command`, async () => {
      const { adapter, client, router, routeMessage, routeInteraction } = await createSetup('native')
      routeMessage.mockRestore()
      routeInteraction.mockRestore()
      router.registerModule(new FaqModule(new StaticFaqRepository(), {
        botName: 'Bot', adminName: 'Admin', adminPhone: '6281234567890', autoGreet: false,
      }))
      const { text, list, buttons } = mockSender(client)
      emitText(client, startWithText ? 'teks' : 'menu')
      await Bun.sleep(0)
      if (!startWithText) {
        expect(list).toHaveBeenCalledTimes(1)
        emitText(client, 'teks')
        await Bun.sleep(0)
      }
      expect(text).toHaveBeenCalledTimes(1)
      emitText(client, '3')
      await Bun.sleep(0)
      expect(text.mock.calls.at(-1)?.[0]).toContain('*Pembayaran & Promo*')
      emitText(client, '2')
      await Bun.sleep(0)
      expect(text.mock.calls.at(-1)?.[0]).toContain('WELCOME10')
      emitText(client, 'kembali')
      await Bun.sleep(0)
      expect(text.mock.calls.at(-1)?.[0]).toContain('*Pembayaran & Promo*')
      emitText(client, 'menu')
      await Bun.sleep(0)
      expect(text.mock.calls.at(-1)?.[0]).toContain('Daftar Topik FAQ')
      expect(text).toHaveBeenCalledTimes(5)
      expect(buttons).not.toHaveBeenCalled()
      await adapter.stop()
    })
  }
})

describe('review fix regressions', () => {
  test('native send caps reply buttons at three while keeping all numbered options', async () => {
    const { adapter, client } = await createSetup('native')
    const sender = mockSender(client)
    await adapter.sendButtons(CHAT_ID, {
      text: 'Pilih menu',
      buttons: [
        { type: 'reply', id: 'opt1', text: 'Satu' },
        { type: 'reply', id: 'opt2', text: 'Dua' },
        { type: 'reply', id: 'opt3', text: 'Tiga' },
        { type: 'reply', id: 'opt4', text: 'Empat' },
        { type: 'reply', id: 'opt5', text: 'Lima' },
      ],
    })
    expect(sender.buttons).toHaveBeenCalledTimes(1)
    const [nativeButtons] = sender.buttons.mock.calls[0]!
    expect((nativeButtons as unknown[]).length).toBe(3)

    const chosen = adapter.resolveMenuSelection(CHAT_ID, '5')
    expect(chosen?.id).toBe('opt5')
  })

  test('interactions without a message id are skipped', async () => {
    const { client, routeInteraction } = await createSetup('native')
    client.emit('button-click', {
      key: { remoteJid: CHAT_ID, id: undefined },
      sender: { jid: CHAT_ID, pn: CHAT_ID },
      buttonId: 'faq:home',
      buttonText: 'Semua Topik',
      timestamp: Date.now(),
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(routeInteraction).not.toHaveBeenCalled()
  })
})

describe('adapter state persistence', () => {
  test('restarted adapter does not reprocess a handled interaction', async () => {
    process.env.ADAPTER_STATE_DIR = `/tmp/channels-test-state-${Date.now()}`
    const first = await createSetup('native')
    first.client.emit('button-click', {
      key: { remoteJid: CHAT_ID, id: 'persist-1' },
      sender: { jid: CHAT_ID, pn: CHAT_ID },
      buttonId: 'faq:home',
      buttonText: 'Semua Topik',
      timestamp: Date.now(),
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(first.routeInteraction).toHaveBeenCalledTimes(1)
    await first.adapter.stop()

    const second = await createSetup('native')
    second.client.emit('button-click', {
      key: { remoteJid: CHAT_ID, id: 'persist-1' },
      sender: { jid: CHAT_ID, pn: CHAT_ID },
      buttonId: 'faq:home',
      buttonText: 'Semua Topik',
      timestamp: Date.now(),
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(second.routeInteraction).not.toHaveBeenCalled()
  })

  test('corrupt state file starts clean', async () => {
    const dir = `/tmp/channels-test-state-${Date.now()}-corrupt`
    process.env.ADAPTER_STATE_DIR = dir
    await import('node:fs').then((fs) => fs.mkdirSync(dir, { recursive: true }))
    await import('node:fs').then((fs) => fs.writeFileSync(`${dir}/adapter-state.json`, '{broken'))
    const setup = await createSetup('native')
    expect(setup.adapter).toBeDefined()
    await setup.adapter.stop()
  })
})
