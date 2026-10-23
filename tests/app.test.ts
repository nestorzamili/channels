import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { Bindings, ChildLoggerOptions } from 'pino'
import { createRouter } from '../src/app.ts'
import { loadConfig } from '../src/config/env.ts'
import type { ChannelAdapter } from '../src/core/channel.interface.ts'
import { createLogger, logger } from '../src/core/logger.ts'

afterEach(() => mock.restore())

function createSetup(env: Record<string, string | undefined> = {}) {
  const log = createLogger('silent')
  spyOn(logger, 'child').mockImplementation(<Levels extends string = never>(
    bindings: Bindings, options?: ChildLoggerOptions<Levels>,
  ) => log.child<Levels>(bindings, options))
  const adapter = {
    name: 'whatsapp',
    start: mock(async () => {}),
    stop: mock(async () => {}),
    sendText: mock(async () => {}),
    sendList: mock(async () => {}),
    sendButtons: mock(async () => {}),
  } satisfies ChannelAdapter
  return { adapter, router: createRouter(loadConfig(env)) }
}

const ctx = {
  channel: 'whatsapp' as const,
  chatId: '628123456789@s.whatsapp.net',
  senderId: '628123456789@s.whatsapp.net',
}

describe('FAQ feature registration', () => {
  test('disabled FAQ ignores text commands, keywords, and previous native menu selections', async () => {
    const { adapter, router } = createSetup({ FAQ_ENABLED: 'false' })

    for (const text of ['halo', 'menu', '/faq', 'kembali', 'teks', 'pembayaran', 'zzzz']) {
      await router.routeMessage(adapter, { ...ctx, text })
    }
    for (const interactionType of ['button', 'list'] as const) {
      for (const actionId of ['faq:home', 'faq:topic:payment', 'faq:q:pay-promo', 'faq:contact']) {
        await router.routeInteraction(adapter, { ...ctx, interactionType, actionId })
      }
    }

    expect(adapter.sendText).not.toHaveBeenCalled()
    expect(adapter.sendList).not.toHaveBeenCalled()
    expect(adapter.sendButtons).not.toHaveBeenCalled()
  })

  test('enabled FAQ retains the native greeting, topic, and answer journey', async () => {
    const { adapter, router } = createSetup()
    await router.routeMessage(adapter, { ...ctx, text: 'halo' })
    expect(adapter.sendList).toHaveBeenCalledTimes(1)

    await router.routeInteraction(adapter, {
      ...ctx, interactionType: 'list', actionId: 'faq:topic:payment',
    })
    expect(adapter.sendList).toHaveBeenCalledTimes(2)

    await router.routeInteraction(adapter, {
      ...ctx, interactionType: 'list', actionId: 'faq:q:pay-promo',
    })
    expect(adapter.sendButtons).toHaveBeenCalledTimes(1)
  })

  test('auto-greet stays enabled with a fixed 30-second cooldown regardless of removed env settings', async () => {
    const { adapter, router } = createSetup({
      FAQ_AUTO_GREET: 'false', FAQ_AUTO_GREET_COOLDOWN_MS: '0',
    })
    let now = 1_000_000
    spyOn(Date, 'now').mockImplementation(() => now)

    await router.routeMessage(adapter, { ...ctx, text: 'zzzz' })
    expect(adapter.sendList).toHaveBeenCalledTimes(1)
    now += 29_999
    await router.routeMessage(adapter, { ...ctx, text: 'zzzz' })
    expect(adapter.sendList).toHaveBeenCalledTimes(1)
    now += 1
    await router.routeMessage(adapter, { ...ctx, text: 'zzzz' })
    expect(adapter.sendList).toHaveBeenCalledTimes(2)
  })
})
