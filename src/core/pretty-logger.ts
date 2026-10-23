import pretty from 'pino-pretty'
import type { Writable } from 'node:stream'

export function createPrettyDestination(
  destination: number | Writable = 2,
  colorize = Boolean(process.stderr.isTTY),
) {
  return pretty({
    destination,
    colorize,
    singleLine: true,
    sync: true,
    translateTime: 'SYS:HH:MM:ss.l',
    ignore: 'pid,hostname,name,component,event',
    messageFormat: (record, messageKey) => {
      const component = record.component ?? record.name ?? 'channels'
      return `[${component}] ${record.event ?? record[messageKey]}`
    },
  })
}
