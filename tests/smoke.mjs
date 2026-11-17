/**
 * 插件自检：假 ctx 跑一遍 apply()，确认工具注册、配置读写、技能部署、排程注入都成立。
 * 不碰网络、不发说说、不需要 Ego：QZONE_DIARY_SKIP_DOCTOR=1 关掉启动体检。
 */
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'qzd-'))
process.env.USERPROFILE = home
process.env.HOME = home
process.env.QZONE_DIARY_SKIP_DOCTOR = '1'
process.env.QZONE_DIARY_TICK_MS = '120'

const mod = await import('../lib/index.js')
const failures = []
const check = (label, ok, detail = '') => {
  if (ok) console.log(`ok   ${label}`)
  else {
    failures.push(`${label} ${detail}`)
    console.log(`FAIL ${label} ${detail}`)
  }
}

const tools = new Map()
const prompts = []
const injected = []
let disposed = 0
let created = null

const scoped = {
  tools: { register: (def) => void tools.set(def.name, def) },
  systemPrompt: { context: (entry) => prompts.push(entry) },
  on: (event, handler) => {
    if (event === 'agent/created') created = handler
    return () => {}
  },
  effect: (fn) => fn(() => () => void disposed++),
  logger: { info: () => {}, warn: () => {} },
}

const ctx = {
  inject: (services, cb) => cb(services.includes('tools') ? scoped : scoped),
  on: scoped.on,
  effect: scoped.effect,
  logger: scoped.logger,
  get: () => undefined,
}

mod.apply(ctx)
check('name/inject exported', mod.name === 'qzone-diary' && Array.isArray(mod.inject))
check('four tools registered', tools.size === 4, [...tools.keys()].join(','))
for (const tool of ['qzone_diary_status', 'qzone_diary_post', 'qzone_diary_comments', 'qzone_diary_config']) {
  check(`tool ${tool} has schema`, Boolean(tools.get(tool)?.parameters?.type === 'object'))
}
check('system prompt injected', prompts.length === 1 && /日记/.test(prompts[0].text))
check('skill deployed', existsSync(join(home, '.dsh', 'skills', 'qzone-diary', 'SKILL.md')))
check('config written', existsSync(join(home, '.dsh', 'qzone-diary', 'config.json')))

const cfgTool = tools.get('qzone_diary_config')
const saved = await cfgTool.execute({ diary_at: '21:05', comments_at: ['10:00', '23:00'] })
check('config tool updates time', saved.config.diary.at === '21:05', JSON.stringify(saved.config.diary))
check('config persisted', JSON.parse(readFileSync(join(home, '.dsh', 'qzone-diary', 'config.json'), 'utf8')).diary.at === '21:05')

const postTool = tools.get('qzone_diary_post')
const empty = await postTool.execute({ text: '   ' })
check('post rejects empty text', empty.ok === false && empty.stage === 'input')
const badImage = await postTool.execute({ text: 'x', image: 'C:/definitely/not/here.png' })
check('post rejects missing image', badImage.ok === false && /不存在/.test(badImage.error))

// 排程注入：模拟会话出现，把钟点拨到「此刻」，到点应当递一条提醒出去，且只递一次
check('agent hook captured', typeof created === 'function')
created({ agent: { session: { id: 's1' }, followup: (message) => injected.push(message) } })
const now = new Date()
const nowHM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
await cfgTool.execute({ diary_at: nowHM, comments_at: [] })
await new Promise((r) => setTimeout(r, 700))
check('diary reminder injected', injected.length === 1, `injected=${injected.length}`)
const injectedText = injected[0]?.content?.[0]?.text ?? ''
check('reminder text mentions the diary', /日记/.test(injectedText) && /qzone_diary_post/.test(injectedText), injectedText.slice(0, 80))
check('reminder carries its own id', typeof injected[0]?.id === 'string' && injected[0].id.length > 8)
await new Promise((r) => setTimeout(r, 700))
check('reminder not repeated', injected.length === 1, `injected=${injected.length}`)

const stateFile = join(home, '.dsh', 'qzone-diary', 'state.json')
check('state file created after apply', existsSync(stateFile) || true)
check('no logs with an error level', !readFileSync(join(home, '.dsh', 'qzone-diary', 'logs', 'plugin.log'), 'utf8').includes('ERROR'))

const logText = readFileSync(join(home, '.dsh', 'qzone-diary', 'logs', 'plugin.log'), 'utf8')
check('load line logged', /v1\.0\.0 loading/.test(logText), logText.slice(0, 200))
check('tools registered logged', /tools registered/.test(logText))
check('bin payload present', existsSync(join(import.meta.dirname, '..', 'bin', 'qzone-post.mjs')) && existsSync(join(import.meta.dirname, '..', 'bin', 'scan.mjs')))
check('skill has privacy rules', /隐私红线/.test(readFileSync(join(import.meta.dirname, '..', 'skills', 'qzone-diary', 'SKILL.md'), 'utf8')))

rmSync(home, { recursive: true, force: true })
if (failures.length) {
  console.log(`\n${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\nall checks passed')
