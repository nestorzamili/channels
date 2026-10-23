import { describe, expect, test } from 'bun:test'
import { createLogger, inboundLogContext, withLogContext } from '../src/core/logger.ts'

describe('application logging', () => {
  test('normalizes phone identities without treating LIDs or other channel IDs as phone numbers', () => {
    expect(inboundLogContext({ channel: 'whatsapp', senderId: '628123456789:4@s.whatsapp.net' }).phone)
      .toBe('+628123456789')
    expect(inboundLogContext({ channel: 'whatsapp', senderId: '+628123456789' }).phone)
      .toBe('+628123456789')
    for (const senderId of ['123456789012345@lid', '123456789@g.us', 'not-a-phone', '08123456789']) {
      expect(inboundLogContext({ channel: 'whatsapp', senderId }).phone).toBeUndefined()
    }
    expect(inboundLogContext({ channel: 'telegram', senderId: '628123456789' }).phone).toBeUndefined()
  })

  test('isolates logging context across concurrent requests and clears it outside routing', async () => {
    const lines: string[] = []
    const log = createLogger('info', { write: (line) => { lines.push(line) } })
    const pending = Promise.withResolvers<void>()
    const first = withLogContext(inboundLogContext({
      channel: 'whatsapp', senderId: '628111111@s.whatsapp.net', messageId: 'first',
    }), async () => {
      await pending.promise
      log.info({ event: 'first.done' }, 'First completed')
    })
    await withLogContext(inboundLogContext({
      channel: 'whatsapp', senderId: '628222222@s.whatsapp.net', messageId: 'second',
    }), async () => { log.info({ event: 'second.done' }, 'Second completed') })
    pending.resolve()
    await first
    log.info({ event: 'outside' }, 'Outside request')
    const records = lines.map((line) => JSON.parse(line))
    expect(records[0]).toMatchObject({ phone: '+628222222', messageId: 'second' })
    expect(records[1]).toMatchObject({ phone: '+628111111', messageId: 'first' })
    expect(records[2].phone).toBeUndefined()
    expect(records[2].messageId).toBeUndefined()
  })

  test('writes structured records and filters below the configured level', () => {
    const lines: string[] = []
    const log = createLogger('warn', { write: (line) => { lines.push(line) } })
    log.info({ event: 'hidden' }, 'Routine event')
    log.warn({ event: 'visible' }, 'Attention required')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: 'warn', event: 'visible', name: 'channels', msg: 'Attention required',
    })
    expect(JSON.parse(lines[0]!).time).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test('keeps error codes and causes while omitting arbitrary payloads', () => {
    const lines: string[] = []
    const log = createLogger('info', { write: (line) => { lines.push(line) } })
    const cause = Object.assign(new Error('Database unavailable'), { code: 'ECONNREFUSED' })
    const err = Object.assign(new Error('Send failed', { cause }), {
      code: 'SEND_FAILED', payload: { text: 'private-message', credentials: 'private-session' },
    })
    log.error({ event: 'send.failed', err }, 'Could not send')
    const record = JSON.parse(lines[0]!)
    expect(record.err).toMatchObject({
      type: 'Error', code: 'SEND_FAILED', message: 'Send failed',
      cause: { code: 'ECONNREFUSED', message: 'Database unavailable' },
    })
    expect(record.err.stack).toBeString()
    expect(lines[0]).not.toContain('private-message')
    expect(lines[0]).not.toContain('private-session')
  })

  test('redacts sensitive fields and safely handles non-Error rejections', () => {
    const lines: string[] = []
    const log = createLogger('info', { write: (line) => { lines.push(line) } })
    log.error({
      token: 'private-token', request: { authorization: 'private-auth' },
      raw: { text: 'private-message' }, err: { creds: 'private-session' },
    }, 'Operation failed')
    expect(lines[0]).not.toContain('private-')
    expect(JSON.parse(lines[0]!)).toMatchObject({
      token: '[REDACTED]', request: { authorization: '[REDACTED]' },
      raw: '[REDACTED]', err: { message: 'Non-Error thrown' },
    })
  })

  test('retains Zaileys credential redaction when adopting the application logger', () => {
    const lines: string[] = []
    const log = createLogger('trace', { write: (line) => { lines.push(line) } })
    const credentials = {
      noiseKey: 'private-noise-key', signedIdentityKey: 'private-identity-key',
      signedPreKey: 'private-pre-key', pairingEphemeralKeyPair: 'private-pairing-key',
      verifyToken: 'private-verify-token',
    }
    log.trace({
      ...credentials,
      session: { ...credentials },
      nested: { session: { ...credentials } },
      headers: { Authorization: 'private-header' },
    }, 'Session diagnostics')
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain('private-')
    const record = JSON.parse(lines[0]!)
    for (const field of Object.keys(credentials)) {
      expect(record[field]).toBe('[REDACTED]')
      expect(record.session[field]).toBe('[REDACTED]')
      expect(record.nested.session[field]).toBe('[REDACTED]')
    }
    expect(record.headers.Authorization).toBe('[REDACTED]')
  })
})
