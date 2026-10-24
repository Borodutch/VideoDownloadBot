import { expect, test } from 'bun:test'
import type { Message } from 'grammy/types'
import { links, urls } from './bot'
import { lang } from './i18n'

test('urls: entities, text links, bare domains, dedupe, non-http dropped', () => {
  const text = 'look youtu.be/x and https://x.com/a/status/1 youtu.be/x ftp://a.b'
  const at = (s: string) => ({ offset: text.indexOf(s), length: s.length })
  const msg = {
    text,
    entities: [
      { type: 'url', ...at('youtu.be/x') },
      { type: 'url', ...at('https://x.com/a/status/1') },
      { type: 'url', offset: text.lastIndexOf('youtu.be/x'), length: 10 },
      { type: 'url', ...at('ftp://a.b') },
      { type: 'text_link', offset: 0, length: 4, url: 'https://vimeo.com/1' },
    ],
  } as Message
  expect(urls(msg)).toEqual([
    'https://youtu.be/x',
    'https://x.com/a/status/1',
    'https://vimeo.com/1',
  ])
})

test('urls: internal hosts dropped, numeric IPs caught after normalizing', () => {
  const links = [
    'http://127.0.0.1:8081/x.mp4',
    'http://2130706433/x.mp4',
    'http://0x7f.1/x.mp4',
    'http://[::1]/x.mp4',
    'http://videodownloadbot-api:8081/x',
    'http://videodownloadbot-api.:8081/x',
    'localhost.:3000',
    'http://127.0.0.1./x',
    'https://nas.local./x',
    'localhost:3000',
    'https://nas.local/x.mp4',
    'http://metadata.google.internal/x',
    'https://youtube.com/watch?v=1',
  ]
  const msg = {
    text: links.join(' '),
    entities: links.map((u) => ({
      type: 'text_link',
      offset: 0,
      length: 1,
      url: u,
    })),
  } as Message
  expect(urls(msg)).toEqual(['https://youtube.com/watch?v=1'])
})

test('lang: telegram codes map to the right locale', () => {
  expect(lang('pt-br')).toBe('pt-br')
  expect(lang('pt')).toBe('pt')
  expect(lang('PT-PT')).toBe('pt')
  expect(lang('zh-hans')).toBe('zh')
  expect(lang('fa')).toBe('fa')
  expect(lang('de')).toBe('en')
  expect(lang(undefined)).toBe('en')
})

test('links: replied-to links only when summoned', () => {
  const reply_to_message = {
    text: 'youtu.be/a here',
    entities: [{ type: 'url', offset: 0, length: 10 }],
  } as Message
  const ask = (text: string) => ({ text, reply_to_message }) as Message
  expect(links(ask('@VidBot please'), 'vidbot')).toEqual(['https://youtu.be/a'])
  expect(links(ask('nice video'), 'vidbot')).toEqual([])
  expect(links(ask('@vidbotx'), 'vidbot')).toEqual([])
  expect(links(ask('hey'), 'vidbot', true)).toEqual(['https://youtu.be/a'])
})
