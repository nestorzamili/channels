import { createRouter } from './app.ts'
import { WhatsAppAdapter } from './channels/whatsapp/whatsapp.adapter.ts'
import { loadConfig } from './config/env.ts'
import { logger } from './core/logger.ts'

async function bootstrap() {
  const config = loadConfig()
  logger.level = config.logLevel

  const router = createRouter(config)

  const whatsapp = new WhatsAppAdapter(
    {
      sessionId: config.whatsapp.sessionId,
      authType: config.whatsapp.authType,
      phoneNumber: config.whatsapp.phoneNumber,
      menuMode: config.whatsapp.menuMode,
    },
    router,
  )

  await whatsapp.start()
  logger.info(
    {
      event: 'app.ready',
      authType: config.whatsapp.authType,
      menuMode: config.whatsapp.menuMode,
      features: config.features,
    },
    'Application initialized',
  )

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    const timeout = setTimeout(() => {
      logger.fatal({ event: 'app.shutdown_timeout' }, 'Shutdown timed out')
      process.exit(1)
    }, 10_000)
    timeout.unref()
    logger.info(
      { event: 'app.stopping', signal },
      'Shutting down',
    )
    try {
      await whatsapp.stop()
      clearTimeout(timeout)
      logger.info({ event: 'app.stopped' }, 'Shutdown complete')
      process.exit(0)
    } catch (error) {
      clearTimeout(timeout)
      logger.fatal({ event: 'app.shutdown_failed', err: error }, 'Shutdown failed')
      process.exit(1)
    }
  }

  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}

bootstrap().catch((error) => {
  logger.fatal({ event: 'app.startup_failed', err: error }, 'Startup failed')
  process.exit(1)
})
