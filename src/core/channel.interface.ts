import type {
  ChannelType,
  OutboundButtonsPayload,
  OutboundListPayload,
} from './types.ts'

export interface ChannelAdapter {
  readonly name: ChannelType
  start(): Promise<void>
  stop(): Promise<void>
  sendText(chatId: string, text: string): Promise<void>
  sendButtons(chatId: string, payload: OutboundButtonsPayload): Promise<void>
  sendList(chatId: string, payload: OutboundListPayload): Promise<void>
}
