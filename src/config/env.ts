import { LOG_LEVELS, type LogLevel } from '../core/logger.ts'

export interface AppConfig {
  logLevel: LogLevel
  features: {
    faq: boolean
  }
  whatsapp: {
    sessionId: string
    authType: 'qr' | 'pairing'
    phoneNumber?: string
    menuMode: 'text' | 'native'
  }
  bot: {
    name: string
    adminName: string
    adminPhone: string
  }
}

const SESSION_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const rawLogLevel = (env.LOG_LEVEL ?? 'info').trim().toLowerCase()
  const logLevel = LOG_LEVELS.find((level) => level === rawLogLevel)
  if (!logLevel) {
    throw new Error(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}.`)
  }
  const sessionId = (env.WA_SESSION_ID ?? 'channels-main').trim()
  if (!SESSION_ID_REGEX.test(sessionId)) {
    throw new Error(
      `Invalid WA_SESSION_ID "${sessionId}". Must be 1-64 characters of A-Z, a-z, 0-9, _, or -.`,
    )
  }

  const rawAuthType = (env.WA_AUTH_TYPE ?? 'qr').trim().toLowerCase()
  const authType: 'qr' | 'pairing' =
    rawAuthType === 'pairing' ? 'pairing' : 'qr'

  const phoneNumber = env.WA_PHONE_NUMBER?.replace(/\D/g, '')
  const menuMode = (env.WA_MENU_MODE ?? 'native').trim().toLowerCase()
  if (menuMode !== 'text' && menuMode !== 'native') {
    throw new Error('WA_MENU_MODE must be text or native.')
  }
  if (authType === 'pairing' && !phoneNumber) {
    throw new Error(
      'WA_PHONE_NUMBER is required when WA_AUTH_TYPE=pairing (digits only, country code first, e.g. 6281234567890).',
    )
  }

  const faqEnabled = (env.FAQ_ENABLED ?? 'true').trim().toLowerCase()
  if (faqEnabled !== 'true' && faqEnabled !== 'false') {
    throw new Error('FAQ_ENABLED must be true or false.')
  }

  return {
    logLevel,
    features: {
      faq: faqEnabled === 'true',
    },
    whatsapp: {
      sessionId,
      authType,
      phoneNumber,
      menuMode,
    },
    bot: {
      name: (env.BOT_NAME ?? 'Channels Assistant').trim(),
      adminName: (env.ADMIN_NAME ?? 'Customer Support').trim(),
      adminPhone: (env.ADMIN_PHONE ?? '6281234567890').replace(/\D/g, ''),
    },
  }
}
