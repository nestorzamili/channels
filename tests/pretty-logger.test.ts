import { describe, expect, test } from 'bun:test'
import { Writable } from 'node:stream'
import { createLogger } from '../src/core/logger.ts'
import { createPrettyDestination } from '../src/core/pretty-logger.ts'

function captureOutput(lines: string[]) {
  return new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString())
      callback()
    },
  })
}

describe('development log presentation', () => {
  test('keeps debugging context in one readable line and hides host metadata', async () => {
    const lines: string[] = []
    const stream = createPrettyDestination(captureOutput(lines), false)
    const log = createLogger('info', stream).child({ component: 'faq' })
    log.info({
      event: 'faq.answer_sent', phone: '+628000000000', messageId: 'message-123',
      topicId: 'general', questionId: 'gen-hours', durationMs: 6,
    }, 'FAQ answer sent')
    await Bun.sleep(0)
    expect(lines).toHaveLength(1)
    const output = lines[0]!
    expect(output).toContain('INFO: [faq] faq.answer_sent')
    for (const value of ['+628000000000', 'message-123', 'general', 'gen-hours', 'durationMs']) {
      expect(output).toContain(value)
    }
    expect(output).not.toContain('hostname')
    expect(output).not.toContain('pid')
    expect(output).not.toContain('FAQ answer sent')
    expect(output.trim().split('\n')).toHaveLength(1)
  })

  test('preserves error details and redaction in the development view', async () => {
    const lines: string[] = []
    const stream = createPrettyDestination(captureOutput(lines), false)
    const log = createLogger('info', stream)
    const err = Object.assign(new Error('Send failed', { cause: new Error('Network unavailable') }), {
      code: 'SEND_FAILED', raw: { text: 'private-message' },
    })
    log.error({ event: 'app.failed', token: 'private-token', err }, 'Operation failed')
    await Bun.sleep(0)
    const output = lines.join('')
    expect(output).toContain('ERROR: [channels] app.failed')
    expect(output).toContain('Send failed')
    expect(output).toContain('Network unavailable')
    expect(output).toContain('SEND_FAILED')
    expect(output).toContain('[REDACTED]')
    expect(output).not.toContain('private-')
    expect(output).toContain('pretty-logger.test.ts')
  })

  test('production keeps JSON even when pretty output is requested', () => {
    const script = 'const { logger } = await import("./src/core/logger.ts"); logger.info({ event: "app.ready" }, "Application initialized");'
    const result = Bun.spawnSync([process.execPath, '-e', script], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, NODE_ENV: 'production', LOG_FORMAT: 'pretty' },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('')
    expect(JSON.parse(result.stderr.toString())).toMatchObject({
      level: 'info', name: 'channels', event: 'app.ready', msg: 'Application initialized',
    })
  })

  test('pretty output flushes fatal errors before an immediate exit', () => {
    const script = 'const { logger } = await import("./src/core/logger.ts"); logger.fatal({ event: "app.failed", err: new Error("Fatal probe") }, "Failed"); process.exit(1);'
    const result = Bun.spawnSync([process.execPath, '-e', script], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, NODE_ENV: 'development', LOG_FORMAT: 'pretty' },
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('[channels] app.failed')
    expect(result.stderr.toString()).toContain('Fatal probe')
  })
})
