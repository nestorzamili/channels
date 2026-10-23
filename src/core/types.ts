export type ChannelType = 'whatsapp' | 'telegram' | 'discord'

export interface InboundMessageContext {
  channel: ChannelType
  chatId: string
  senderId: string
  senderName?: string
  messageId?: string
  text: string
  timestamp?: number
  raw?: unknown
}

export interface InboundInteractionContext {
  channel: ChannelType
  chatId: string
  senderId: string
  senderName?: string
  messageId?: string
  actionId: string
  label?: string
  interactionType: 'button' | 'list'
  timestamp?: number
  raw?: unknown
}

export type OutboundButtonItem =
  | {
      type?: 'reply'
      id: string
      text: string
    }
  | {
      type: 'url'
      text: string
      url: string
      webview?: boolean
    }
  | {
      type: 'copy'
      text: string
      code: string
    }
  | {
      type: 'call'
      text: string
      phone: string
    }

export interface OutboundButtonsPayload {
  title?: string
  subtitle?: string
  text: string
  footer?: string
  buttons: OutboundButtonItem[]
}

export interface OutboundListRow {
  id: string
  title: string
  description?: string
}

export interface OutboundListSection {
  title: string
  rows: OutboundListRow[]
}

export interface OutboundListPayload {
  title?: string
  description: string
  buttonText: string
  footerText?: string
  sections: OutboundListSection[]
}
