import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import { createRouter } from '../src/app.ts'
import { loadConfig } from '../src/config/env.ts'
import { StaticFaqRepository } from '../src/modules/faq/faq.repository.ts'

afterEach(() => mock.restore())

function topic() {
  return {
    id: 'general', title: 'Informasi Umum', label: 'Umum',
    questions: [{
      id: 'gen-hours', label: 'Jam Operasional',
      question: 'Kapan jam operasional layanan?',
      answer: 'Senin–Jumat\n\n• *08.00–21.00 WIB*\nhttps://example.com',
    }],
  }
}

describe('FAQ JSON repository', () => {
  test('loads bundled JSON and preserves Unicode, formatting, and line breaks', async () => {
    const data = JSON.parse(fs.readFileSync(new URL('../src/modules/faq/faq.data.json', import.meta.url), 'utf8'))
    const repo = new StaticFaqRepository()
    expect(await repo.getAllTopics()).toEqual(data)
    const hours = await repo.getQuestionById('gen-hours')
    expect(hours?.question.answer).toContain('\n\n• *Senin – Jumat:* 08.00 – 21.00 WIB\n')
    expect((await repo.findTopicByQuery('pembayaran'))?.id).toBe('payment')
    expect((await repo.findQuestionByQuery('jam operasional'))?.question.id).toBe('gen-hours')
  })

  test('reads the file once per repository, with no filesystem access during lookups', async () => {
    const read = spyOn(fs, 'readFileSync')
    const repo = new StaticFaqRepository()
    expect(read).toHaveBeenCalledTimes(1)
    await repo.getAllTopics()
    await repo.getTopicById('general')
    await repo.getQuestionById('gen-hours')
    await repo.findTopicByQuery('pembayaran')
    await repo.findQuestionByQuery('jam operasional')
    expect(read).toHaveBeenCalledTimes(1)
  })

  test('accepts optional labels and empty menus', async () => {
    const data = [{
      id: 'general', title: 'Umum',
      questions: [{ id: 'hours', question: 'Jam layanan?', answer: 'Setiap hari.' }],
    }]
    expect(await new StaticFaqRepository(data).getAllTopics()).toEqual(data)
    expect(await new StaticFaqRepository([]).getAllTopics()).toEqual([])
    const empty = [{ id: 'empty', title: 'Kosong', questions: [] }]
    expect(await new StaticFaqRepository(empty).getAllTopics()).toEqual(empty)
  })

  test('rejects invalid root, topic, and question structures', () => {
    for (const value of [null, {}, 'topics', 1]) {
      expect(() => new StaticFaqRepository(value)).toThrow('topics must be an array')
    }
    for (const value of [null, [], 'topic', 1]) {
      expect(() => new StaticFaqRepository([value])).toThrow('topics[0] must be an object')
      expect(() => new StaticFaqRepository([{ ...topic(), questions: [value] }]))
        .toThrow('topics[0].questions[0] must be an object')
    }
    for (const questions of [undefined, null, {}, 'questions']) {
      expect(() => new StaticFaqRepository([{ ...topic(), questions }]))
        .toThrow('topics[0].questions must be an array')
    }
  })

  test('rejects missing, empty, and non-string content with the affected field path', () => {
    for (const value of [undefined, null, '', ' \n ', 1, {}, []]) {
      for (const field of ['id', 'title', 'label']) {
        if (field === 'label' && value === undefined) continue
        expect(() => new StaticFaqRepository([{ ...topic(), [field]: value }]))
          .toThrow(`topics[0].${field}`)
      }
      for (const field of ['id', 'question', 'answer', 'label']) {
        if (field === 'label' && value === undefined) continue
        expect(() => new StaticFaqRepository([{
          ...topic(), questions: [{ ...topic().questions[0], [field]: value }],
        }])).toThrow(`topics[0].questions[0].${field}`)
      }
    }
  })

  test('rejects IDs that would break interaction routing or exact ID lookup', () => {
    for (const id of ['faq:home', 'has space', ' leading', 'trailing ', 'with/slash', 'baris\nbaru', 'trailing\n']) {
      expect(() => new StaticFaqRepository([{ ...topic(), id }])).toThrow('topics[0].id')
      expect(() => new StaticFaqRepository([{
        ...topic(), questions: [{ ...topic().questions[0], id }],
      }])).toThrow('topics[0].questions[0].id')
    }
  })

  test('rejects duplicate topic IDs and question IDs across all topics, ignoring case', () => {
    expect(() => new StaticFaqRepository([topic(), { ...topic(), questions: [] }]))
      .toThrow('duplicate topic ID at topics[1].id')
    expect(() => new StaticFaqRepository([topic(), { ...topic(), id: 'GENERAL', questions: [] }]))
      .toThrow('duplicate topic ID at topics[1].id')
    const question = topic().questions[0]!
    expect(() => new StaticFaqRepository([{ ...topic(), questions: [question, question] }]))
      .toThrow('duplicate question ID at topics[0].questions[1].id')
    expect(() => new StaticFaqRepository([
      topic(), { ...topic(), id: 'other', questions: [{ ...question, id: 'GEN-HOURS' }] },
    ])).toThrow('duplicate question ID at topics[1].questions[0].id')
  })

  test('identifies malformed JSON and preserves its original error as the cause', () => {
    spyOn(fs, 'readFileSync').mockReturnValueOnce('{')
    let failure: unknown
    try {
      new StaticFaqRepository()
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) throw new Error('Expected a JSON loading error')
    expect(failure.message).toBe('Failed to load faq.data.json.')
    expect(failure.cause).toBeInstanceOf(SyntaxError)
  })

  test('does not read FAQ data when the feature is disabled', () => {
    const read = spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('file unavailable')
    })
    expect(() => createRouter(loadConfig({ FAQ_ENABLED: 'false' }))).not.toThrow()
    expect(read).not.toHaveBeenCalled()
    expect(() => createRouter(loadConfig({ FAQ_ENABLED: 'true' }))).toThrow('Failed to load faq.data.json.')
    expect(read).toHaveBeenCalledTimes(1)
  })
})
