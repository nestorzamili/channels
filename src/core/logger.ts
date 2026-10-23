import pino, { type DestinationStream } from 'pino'
import { AsyncLocalStorage } from 'node:async_hooks'

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const
export type LogLevel = typeof LOG_LEVELS[number]

interface LogContext {
  channel: string
  messageId?: string
  phone?: string
}

const logContext = new AsyncLocalStorage<LogContext>()

export function inboundLogContext(ctx: {
  channel: string
  senderId: string
  messageId?: string
}): LogContext {
  const match = ctx.channel === 'whatsapp'
    ? /^\+?([1-9]\d{7,14})(?::\d+)?(?:@(s\.whatsapp\.net|c\.us))?$/.exec(ctx.senderId)
    : null
  return {
    channel: ctx.channel,
    messageId: ctx.messageId,
    phone: match ? `+${match[1]}` : undefined,
  }
}

export function withLogContext<T>(context: LogContext, action: () => T): T {
  return logContext.run(context, action)
}

function serializeError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return {
      type: typeof error,
      message: typeof error === 'string' ? error : 'Non-Error thrown',
    }
  }
  const code = Reflect.get(error, 'code')
  return {
    type: error.name,
    message: error.message,
    stack: error.stack,
    code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
    cause: error.cause !== undefined && depth < 3
      ? serializeError(error.cause, depth + 1)
      : undefined,
  }
}

export function createLogger(
  level: LogLevel = 'info',
  destination: DestinationStream = pino.destination({ dest: 2, sync: true }),
) {
  const sensitiveFields = [
    'password', 'token', 'accessToken', 'appSecret', 'authorization',
    'creds', 'auth', 'raw', 'text', 'qrString', 'pairingCode',
    'noiseKey', 'signedIdentityKey', 'signedPreKey', 'pairingEphemeralKeyPair',
    'verifyToken', 'Authorization',
  ]
  return pino({
    name: 'channels',
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    mixin: () => ({ ...logContext.getStore() }),
    serializers: { err: serializeError },
    redact: {
      paths: sensitiveFields.flatMap((field) => [field, `*.${field}`, `*.*.${field}`]),
      censor: '[REDACTED]',
    },
  }, destination)
}

const destination = process.env.LOG_FORMAT === 'pretty' && process.env.NODE_ENV !== 'production'
  ? (await import('./pretty-logger.ts')).createPrettyDestination()
  : pino.destination({ dest: 2, sync: true })

export const logger = createLogger('info', destination)
