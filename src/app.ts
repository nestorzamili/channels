import type { AppConfig } from './config/env.ts'
import { MessageRouter } from './core/router.ts'
import { FaqModule } from './modules/faq/faq.handler.ts'
import { StaticFaqRepository } from './modules/faq/faq.repository.ts'

export function createRouter(config: AppConfig): MessageRouter {
  const router = new MessageRouter()

  if (config.features.faq) {
    router.registerModule(new FaqModule(new StaticFaqRepository(), {
      botName: config.bot.name,
      adminName: config.bot.adminName,
      adminPhone: config.bot.adminPhone,
      autoGreet: true,
    }))
  }

  return router
}
