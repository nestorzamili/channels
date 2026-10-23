import {
  Client,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
} from 'zaileys'
import type { ChannelAdapter } from '../../core/channel.interface.ts'
import type { MessageRouter } from '../../core/router.ts'
import { inboundLogContext, logger } from '../../core/logger.ts'
import type {
  OutboundButtonItem,
  OutboundButtonsPayload,
  OutboundListPayload,
  OutboundListRow,
  OutboundListSection,
} from '../../core/types.ts'

export interface WhatsAppAdapterOptions {
  sessionId: string
  authType: 'qr' | 'pairing'
  phoneNumber?: string
  menuMode?: 'text' | 'native'
}

export interface NumberedMenuOption {
  id: string
  title: string
  type: 'list' | 'button'
}

interface MenuState {
  options: NumberedMenuOption[]
  text?: string
  mode: 'text' | 'native'
}

const MAX_MENU_STATE_ENTRIES = 1000
const MAX_HANDLED_IDS = 500

function isNonDirectJid(jid: string): boolean {
  return (
    Boolean(isJidGroup(jid)) ||
    Boolean(isJidBroadcast(jid)) ||
    Boolean(isJidNewsletter(jid))
  )
}

function unwrapMessageContent(
  message: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  let current = message
  const wrapperKeys = [
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'viewOnceMessageV2Extension',
    'documentWithCaptionMessage',
    'editedMessage',
  ]

  for (let depth = 0; depth < 5 && current; depth++) {
    let unwrapped = false
    for (const key of wrapperKeys) {
      const wrapper = current[key] as
        | { message?: Record<string, unknown> }
        | undefined
      if (wrapper?.message) {
        current = wrapper.message
        unwrapped = true
        break
      }
    }
    if (!unwrapped) break
  }

  return current ?? null
}

export function extractInteractiveAction(
  rawMessage: Record<string, unknown> | null | undefined,
): { actionId: string; label: string; interactionType: 'list' | 'button' } | null {
  const content = unwrapMessageContent(rawMessage)
  if (!content) return null

  const listResp = content.listResponseMessage as
    | {
        singleSelectReply?: { selectedRowId?: string }
        title?: string
      }
    | undefined
  if (listResp?.singleSelectReply?.selectedRowId) {
    return {
      actionId: listResp.singleSelectReply.selectedRowId,
      label: listResp.title ?? '',
      interactionType: 'list',
    }
  }

  const btnResp = content.buttonsResponseMessage as
    | {
        selectedButtonId?: string
        selectedDisplayText?: string
      }
    | undefined
  if (btnResp?.selectedButtonId) {
    return {
      actionId: btnResp.selectedButtonId,
      label: btnResp.selectedDisplayText ?? '',
      interactionType: 'button',
    }
  }

  const tplResp = content.templateButtonReplyMessage as
    | {
        selectedId?: string
        selectedDisplayText?: string
      }
    | undefined
  if (tplResp?.selectedId) {
    return {
      actionId: tplResp.selectedId,
      label: tplResp.selectedDisplayText ?? '',
      interactionType: 'button',
    }
  }

  const interactiveResp = content.interactiveResponseMessage as
    | {
        body?: { text?: string }
        nativeFlowResponseMessage?: {
          name?: string
          paramsJson?: string
        }
      }
    | undefined
  const nativeFlow = interactiveResp?.nativeFlowResponseMessage
  if (nativeFlow?.paramsJson) {
    try {
      const parsed = JSON.parse(nativeFlow.paramsJson) as {
        id?: string
        selectedId?: string
        rowId?: string
        row_id?: string
        button_id?: string
        title?: string
        display_text?: string
      }
      const actionId =
        parsed.id ??
        parsed.selectedId ??
        parsed.rowId ??
        parsed.row_id ??
        parsed.button_id
      if (actionId) {
        const label =
          parsed.title ??
          parsed.display_text ??
          interactiveResp?.body?.text ??
          ''
        const isList =
          nativeFlow.name === 'single_select' ||
          Boolean(parsed.rowId ?? parsed.row_id)
        return {
          actionId,
          label,
          interactionType: isList ? 'list' : 'button',
        }
      }
    } catch {
      return null
    }
  }

  return null
}

export function formatNumberedListMessage(
  payload: OutboundListPayload,
): { text: string; options: NumberedMenuOption[] } {
  const seenRowIds = new Set<string>()
  const safeSections: OutboundListSection[] = []
  let remainingRows = 10

  for (const section of payload.sections) {
    if (remainingRows <= 0) break

    const rows: OutboundListRow[] = []
    for (const row of section.rows) {
      if (rows.length >= remainingRows) break
      const rowId = row.id.trim()
      const rowTitle = row.title.trim()
      if (!rowId || !rowTitle || seenRowIds.has(rowId)) continue
      seenRowIds.add(rowId)
      rows.push(row)
    }

    if (rows.length > 0) {
      safeSections.push({
        title: section.title,
        rows,
      })
      remainingRows -= rows.length
    }
  }

  if (safeSections.length === 0) {
    return { text: payload.description, options: [] }
  }

  const lines: string[] = []
  if (payload.title?.trim()) {
    lines.push(`*${payload.title.trim()}*`)
  }
  if (payload.description.trim()) {
    lines.push(payload.description.trim())
  }

  const options: NumberedMenuOption[] = []
  for (const section of safeSections) {
    const sectionLines: string[] = []
    if (section.title.trim()) {
      sectionLines.push(`*${section.title.trim()}*`)
    }
    for (const row of section.rows) {
      const rowId = row.id.trim()
      const rowTitle = row.title.trim()
      options.push({
        id: rowId,
        title: rowTitle,
        type: 'list',
      })
      const index = options.length
      const desc = row.description?.trim()
      sectionLines.push(
        desc ? `${index}. ${rowTitle} - ${desc}` : `${index}. ${rowTitle}`,
      )
    }
    if (sectionLines.length > 0) {
      lines.push(sectionLines.join('\n'))
    }
  }

  lines.push(
    options.length === 1
      ? '_Balas dengan angka *1* untuk memilih._'
      : `_Balas dengan angka pilihan Anda (*1-${options.length}*)._`,
  )

  return {
    text: lines.join('\n\n'),
    options,
  }
}

export function formatNumberedButtonsMessage(
  payload: OutboundButtonsPayload,
): { text: string; options: NumberedMenuOption[] } {
  const seenReplyIds = new Set<string>()
  const safeButtons: OutboundButtonItem[] = []

  for (const btn of payload.buttons) {
    if (safeButtons.length >= 10) break
    if (!btn.text.trim()) continue

    if (!btn.type || btn.type === 'reply') {
      const replyId = btn.id.trim()
      if (!replyId || seenReplyIds.has(replyId)) continue
      seenReplyIds.add(replyId)
    }

    safeButtons.push(btn)
  }

  if (safeButtons.length === 0) {
    return { text: payload.text, options: [] }
  }

  const lines: string[] = []
  if (payload.title?.trim()) {
    lines.push(`*${payload.title.trim()}*`)
  }
  if (payload.subtitle?.trim()) {
    lines.push(payload.subtitle.trim())
  }
  if (payload.text.trim()) {
    lines.push(payload.text.trim())
  }

  const actionLinks: string[] = []
  const options: NumberedMenuOption[] = []
  const optionLines: string[] = []

  for (const btn of safeButtons) {
    const label = btn.text.trim()
    if (btn.type === 'url') {
      actionLinks.push(`*${label}:* ${btn.url.trim()}`)
      continue
    }
    if (btn.type === 'call') {
      const cleanPhone = btn.phone.trim().replace(/^\+/, '')
      actionLinks.push(`*${label}:* +${cleanPhone}`)
      continue
    }
    if (btn.type === 'copy') {
      actionLinks.push(`*${label}:* ${btn.code.trim()}`)
      continue
    }

    options.push({
      id: btn.id.trim(),
      title: label,
      type: 'button',
    })
    optionLines.push(`${options.length}. ${label}`)
  }

  if (actionLinks.length > 0) {
    lines.push(actionLinks.join('\n'))
  }

  if (optionLines.length > 0) {
    lines.push(optionLines.join('\n'))
    lines.push(
      options.length === 1
        ? '_Balas dengan angka *1* untuk memilih._'
        : `_Balas dengan angka pilihan Anda (*1-${options.length}*)._`,
    )
  }

  return {
    text: lines.join('\n\n'),
    options,
  }
}

export class WhatsAppAdapter implements ChannelAdapter {
  readonly name = 'whatsapp' as const
  private client: Client | null = null
  private readonly options: WhatsAppAdapterOptions
  private readonly router: MessageRouter
  private readonly menuState = new Map<string, MenuState>()
  private readonly handledInteractionMsgIds = new Set<string>()
  private readonly log = logger.child({ component: 'whatsapp' })

  constructor(options: WhatsAppAdapterOptions, router: MessageRouter) {
    this.options = options
    this.router = router
  }

  async start(): Promise<void> {
    if (this.client) return

    const client = new Client({
      sessionId: this.options.sessionId,
      authType: this.options.authType,
      statusLog: true,
      logger: logger.child(
        { component: 'zaileys', sessionId: this.options.sessionId },
        { level: this.log.level === 'info' ? 'warn' : this.log.level },
      ),
      ...(this.options.authType === 'pairing' && this.options.phoneNumber
        ? { phoneNumber: this.options.phoneNumber }
        : {}),
    })

    this.client = client

    client.on('text', async (msg) => {
      let senderId = msg.senderId
      try {
        if (
          msg.chatType !== 'text' ||
          msg.isGroup ||
          msg.isStory ||
          msg.isNewsletter ||
          msg.isBroadcast ||
          msg.isOld ||
          msg.isBot ||
          msg.isSpam
        ) {
          return
        }

        const chatId = await this.normalizeChatId(msg.roomId ?? msg.senderId)
        senderId = chatId
        const command = msg.text.trim().toLowerCase()
        if (command === 'teks') {
          const menu = this.menuState.get(chatId)
          if (menu?.text) {
            await client.send(chatId).text(menu.text)
            this.saveMenuState(chatId, { ...menu, mode: 'text' })
            return
          }
          this.saveMenuState(chatId, { options: [], mode: 'text' })
        }
        const matchedOption = ['menu', 'kembali'].includes(command)
          ? null
          : this.resolveMenuSelection(chatId, msg.text)
        if (matchedOption) {
          await this.router.routeInteraction(this, {
            channel: 'whatsapp',
            chatId,
            senderId: chatId,
            senderName: msg.senderName ?? undefined,
            messageId: msg.chatId,
            actionId: matchedOption.id,
            label: matchedOption.title,
            interactionType: matchedOption.type,
            timestamp: msg.timestamp,
            raw: msg,
          })
          return
        }

        await this.router.routeMessage(this, {
          channel: 'whatsapp',
          chatId,
          senderId: chatId,
          senderName: msg.senderName ?? undefined,
          messageId: msg.chatId,
          text: msg.text,
          timestamp: msg.timestamp,
          raw: msg,
        })
      } catch (error) {
        this.log.error(
          {
            ...inboundLogContext({ channel: 'whatsapp', senderId, messageId: msg.chatId }),
            event: 'whatsapp.inbound_failed', source: 'text', err: error,
          },
          'Failed to handle incoming message',
        )
      }
    })

    client.on('list-select', async (pick) => {
      let senderId = pick.sender.pn ?? pick.sender.jid
      try {
        if (!this.markInteractionHandled(pick.key.id)) return
        const resolved = await this.resolveDirectChat(
          pick.key.remoteJid,
          pick.sender,
        )
        if (!resolved) return
        senderId = resolved.senderId

        await this.router.routeInteraction(this, {
          channel: 'whatsapp',
          chatId: resolved.chatId,
          senderId: resolved.senderId,
          senderName: pick.sender.pushName,
          messageId: pick.key.id ?? undefined,
          actionId: pick.rowId,
          label: pick.title,
          interactionType: 'list',
          timestamp: pick.timestamp,
          raw: pick,
        })
      } catch (error) {
        this.log.error(
          {
            ...inboundLogContext({ channel: 'whatsapp', senderId, messageId: pick.key.id ?? undefined }),
            event: 'whatsapp.inbound_failed', source: 'list-select', err: error,
          },
          'Failed to handle incoming interaction',
        )
      }
    })

    client.on('button-click', async (tap) => {
      let senderId = tap.sender.pn ?? tap.sender.jid
      try {
        if (!this.markInteractionHandled(tap.key.id)) return
        const resolved = await this.resolveDirectChat(
          tap.key.remoteJid,
          tap.sender,
        )
        if (!resolved) return
        senderId = resolved.senderId

        await this.router.routeInteraction(this, {
          channel: 'whatsapp',
          chatId: resolved.chatId,
          senderId: resolved.senderId,
          senderName: tap.sender.pushName,
          messageId: tap.key.id ?? undefined,
          actionId: tap.buttonId,
          label: tap.buttonText,
          interactionType: 'button',
          timestamp: tap.timestamp,
          raw: tap,
        })
      } catch (error) {
        this.log.error(
          {
            ...inboundLogContext({ channel: 'whatsapp', senderId, messageId: tap.key.id ?? undefined }),
            event: 'whatsapp.inbound_failed', source: 'button-click', err: error,
          },
          'Failed to handle incoming interaction',
        )
      }
    })

    client.on('message', async (msg) => {
      let senderId = msg.senderId
      try {
        if (msg.isOld) {
          this.markInteractionHandled(msg.message().key?.id)
          return
        }

        if (
          msg.isGroup ||
          msg.isStory ||
          msg.isNewsletter ||
          msg.isBroadcast ||
          msg.isBot ||
          msg.isSpam ||
          msg.isFromMe
        ) {
          return
        }

        const rawMsg = msg.message()
        const extracted = extractInteractiveAction(
          rawMsg.message as Record<string, unknown> | undefined,
        )
        if (!extracted) return
        if (!this.markInteractionHandled(rawMsg.key?.id)) return

        const chatId = await this.normalizeChatId(msg.roomId ?? msg.senderId)
        senderId = chatId
        await this.router.routeInteraction(this, {
          channel: 'whatsapp',
          chatId,
          senderId: chatId,
          senderName: msg.senderName ?? undefined,
          messageId: rawMsg.key?.id ?? msg.chatId,
          actionId: extracted.actionId,
          label: extracted.label,
          interactionType: extracted.interactionType,
          timestamp: msg.timestamp,
          raw: msg,
        })
      } catch (error) {
        this.log.error(
          {
            ...inboundLogContext({ channel: 'whatsapp', senderId, messageId: msg.chatId }),
            event: 'whatsapp.inbound_failed', source: 'message', err: error,
          },
          'Failed to handle incoming interaction',
        )
      }
    })
  }

  async stop(): Promise<void> {
    if (!this.client) return
    const current = this.client
    this.client = null
    await current.disconnect()
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const client = this.requireClient()
    await client.send(chatId).text(text)
  }

  async sendButtons(
    chatId: string,
    payload: OutboundButtonsPayload,
  ): Promise<void> {
    const { buttons, ...content } = payload
    await this.sendMenu(
      chatId,
      formatNumberedButtonsMessage(payload),
      async (client, jid) => {
        await client.send(jid).buttons(buttons, content)
      },
    )
  }

  async sendList(chatId: string, payload: OutboundListPayload): Promise<void> {
    await this.sendMenu(
      chatId,
      formatNumberedListMessage(payload),
      async (client, jid) => {
        let rowIndex = 0
        await client.send(jid).list({
          ...payload,
          sections: payload.sections.map((section) => ({
            title: section.title.slice(0, 24),
            rows: section.rows.map((row) => {
              rowIndex++
              return {
                ...row,
                title: row.title.length > 24 ? `Pilihan ${rowIndex}` : row.title,
                description: (
                  row.description ?? (row.title.length > 24 ? row.title : '')
                ).slice(0, 72),
              }
            }),
          })),
        })
      },
    )
  }

  private async sendMenu(
    chatId: string,
    menu: { text: string; options: NumberedMenuOption[] },
    sendNative: (client: Client, jid: string) => Promise<void>,
  ): Promise<void> {
    const client = this.requireClient()
    const jid = await this.normalizeChatId(chatId)
    const mode = this.menuState.get(jid)?.mode ?? this.options.menuMode ?? 'native'

    if (mode === 'native' && menu.options.length > 0) {
      await sendNative(client, jid)
    } else {
      await client.send(jid).text(menu.text)
    }

    this.saveMenuState(jid, { ...menu, mode })
  }

  public saveMenuOptions(
    chatId: string,
    options: NumberedMenuOption[],
  ): void {
    const previous = this.menuState.get(chatId)
    this.saveMenuState(chatId, {
      ...previous,
      options,
      mode: previous?.mode ?? this.options.menuMode ?? 'native',
    })
  }

  private saveMenuState(chatId: string, state: MenuState): void {
    if (
      !this.menuState.has(chatId) &&
      this.menuState.size >= MAX_MENU_STATE_ENTRIES
    ) {
      const oldestKey = this.menuState.keys().next().value
      if (oldestKey !== undefined) {
        this.menuState.delete(oldestKey)
      }
    }
    this.menuState.set(chatId, state)
  }

  public resolveMenuSelection(
    chatId: string,
    text: string,
  ): NumberedMenuOption | null {
    const options = this.menuState.get(chatId)?.options
    if (!options || options.length === 0) return null

    const trimmed = text.trim()
    const numberMatch = /^#?(\d+)\.?$/.exec(trimmed)
    if (numberMatch) {
      const index = Number.parseInt(numberMatch[1] ?? '', 10)
      if (index >= 1 && index <= options.length) {
        return options[index - 1] ?? null
      }
      return null
    }

    const lower = trimmed.toLowerCase()
    return (
      options.find((opt) => opt.title.toLowerCase() === lower) ?? null
    )
  }

  private markInteractionHandled(msgId: string | null | undefined): boolean {
    if (!msgId) return true
    if (this.handledInteractionMsgIds.has(msgId)) return false
    if (this.handledInteractionMsgIds.size >= MAX_HANDLED_IDS) {
      const oldest = this.handledInteractionMsgIds.values().next().value
      if (oldest !== undefined) {
        this.handledInteractionMsgIds.delete(oldest)
      }
    }
    this.handledInteractionMsgIds.add(msgId)
    return true
  }

  private async normalizeChatId(jid: string): Promise<string> {
    if (!jid.endsWith('@lid') || !this.client) return jid
    const pn = await this.client.lidToPn(jid)
    return pn ?? jid
  }

  private async resolveDirectChat(
    remoteJid: string | null | undefined,
    sender: { jid: string; pn?: string; lid?: string },
  ): Promise<{ chatId: string; senderId: string } | null> {
    if (remoteJid && isNonDirectJid(remoteJid)) return null
    if (isNonDirectJid(sender.jid)) return null

    const client = this.requireClient()
    let pnJid = sender.pn

    if (!pnJid) {
      if (remoteJid && !remoteJid.endsWith('@lid')) {
        pnJid = remoteJid
      } else {
        const lid =
          sender.lid ??
          (sender.jid.endsWith('@lid') ? sender.jid : undefined) ??
          (remoteJid?.endsWith('@lid') ? remoteJid : undefined)
        if (lid) {
          pnJid = (await client.lidToPn(lid)) ?? undefined
        }
      }
    }

    const resolved = pnJid ?? sender.jid
    return {
      chatId: resolved,
      senderId: resolved,
    }
  }

  private requireClient(): Client {
    if (!this.client) {
      throw new Error('WhatsAppAdapter has not been started yet.')
    }
    return this.client
  }
}
