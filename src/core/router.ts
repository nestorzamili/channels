import type { ChannelAdapter } from './channel.interface.ts'
import { inboundLogContext, withLogContext } from './logger.ts'
import type {
  InboundInteractionContext,
  InboundMessageContext,
} from './types.ts'

export interface FeatureModule {
  readonly name: string
  handleMessage(
    adapter: ChannelAdapter,
    ctx: InboundMessageContext,
  ): Promise<boolean>
  handleInteraction(
    adapter: ChannelAdapter,
    ctx: InboundInteractionContext,
  ): Promise<boolean>
}

export class MessageRouter {
  private readonly modules: FeatureModule[] = []

  registerModule(module: FeatureModule): void {
    this.modules.push(module)
  }

  async routeMessage(
    adapter: ChannelAdapter,
    ctx: InboundMessageContext,
  ): Promise<void> {
    await withLogContext(inboundLogContext(ctx), async () => {
      for (const mod of this.modules) {
        const handled = await mod.handleMessage(adapter, ctx)
        if (handled) return
      }
    })
  }

  async routeInteraction(
    adapter: ChannelAdapter,
    ctx: InboundInteractionContext,
  ): Promise<void> {
    await withLogContext(inboundLogContext(ctx), async () => {
      for (const mod of this.modules) {
        const handled = await mod.handleInteraction(adapter, ctx)
        if (handled) return
      }
    })
  }
}
