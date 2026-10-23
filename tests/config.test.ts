import { describe, expect, test } from 'bun:test'
import { loadConfig } from '../src/config/env.ts'

describe('Application configuration', () => {
  test('enables FAQ by default and supports explicitly disabling it', () => {
    expect(loadConfig({}).features.faq).toBe(true)
    expect(loadConfig({ FAQ_ENABLED: ' TRUE ' }).features.faq).toBe(true)
    expect(loadConfig({ FAQ_ENABLED: ' False ' }).features.faq).toBe(false)
  })

  test('rejects invalid FAQ feature flags', () => {
    for (const value of ['', '0', '1', 'yes', 'disabled']) {
      expect(() => loadConfig({ FAQ_ENABLED: value })).toThrow('FAQ_ENABLED')
    }
  })

  test('uses native menus by default and retains an explicit text fallback', () => {
    expect(loadConfig({}).whatsapp.menuMode).toBe('native')
    expect(loadConfig({ WA_MENU_MODE: ' Native ' }).whatsapp.menuMode).toBe('native')
    expect(loadConfig({ WA_MENU_MODE: 'text' }).whatsapp.menuMode).toBe('text')
  })

  test('rejects invalid menu modes', () => {
    expect(() => loadConfig({ WA_MENU_MODE: 'auto' })).toThrow('WA_MENU_MODE')
  })

  test('validates application log levels', () => {
    expect(loadConfig({}).logLevel).toBe('info')
    expect(loadConfig({ LOG_LEVEL: ' WARN ' }).logLevel).toBe('warn')
    expect(loadConfig({ LOG_LEVEL: 'silent' }).logLevel).toBe('silent')
    expect(() => loadConfig({ LOG_LEVEL: 'invalid' })).toThrow('LOG_LEVEL')
  })
})
