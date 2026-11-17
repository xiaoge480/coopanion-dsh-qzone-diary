/**
 * dsh-qzone-diary —— 定时发 QQ 空间日记的 DSH 插件（宿主半）。
 *
 * 一件事的四种用法：把当天日记（带图）发到 QQ 空间说说、查依赖/登录态、扫评论（只汇报）、
 * 改插件配置。外加一个到点提醒的排程器：配置的钟点一到，它给当前会话递一句「该写日记了」，
 * 之后由模型按 skills/qzone-diary 的规程把活干完。
 *
 * 设计约束（和 coopanion-connector-dsh 一致）：
 *   - 只 import node: 内置模块：本地目录安装时裸包名解析不到宿主的依赖；
 *   - 不 inject 必需服务：缺服务时降级，别让整条插件不激活；
 *   - 任何一步失败都只写日志，不抛到宿主；
 *   - 递进会话的消息必须自带 id，否则会话重放会整段读不出来。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'qzone-diary'
export const inject = []

const VERSION = '1.0.0'
const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = dirname(HERE)
const HOME = process.env.USERPROFILE || process.env.HOME || process.cwd()
const DSH_HOME = join(HOME, '.dsh')
const DATA = join(DSH_HOME, 'qzone-diary')
const JOBS = join(DATA, 'jobs')
const LOGS = join(DATA, 'logs')
const SKILL_HOME = join(DSH_HOME, 'skills', 'qzone-diary')
const CONFIG_FILE = join(DATA, 'config.json')
const STATE_FILE = join(DATA, 'state.json')
const SEEN_FILE = join(DATA, 'comments-seen.json')
const PENDING_FILE = join(DATA, 'pending.md')
const LOG_FILE = join(LOGS, 'plugin.log')
const RUNTIME = join(DATA, 'bin')
const CLI = join(RUNTIME, 'qzone-post.mjs')
const SCAN = join(RUNTIME, 'scan.mjs')
const VERSION_FILE = join(RUNTIME, '.version')
const SKILL_SRC = join(PKG, 'skills', 'qzone-diary', 'SKILL.md')

/** 依赖清单：缺哪个就把地址一起递出去。 */
const NEEDS = {
  ego: {
    label: 'Ego 浏览器（ego lite）',
    why: '发说说与扫评论都要靠它的登录态；它不在就发不出去。',
    url: 'https://lite.ego.app/zh-cn',
    install: '装好后在 Ego 里登录 QQ 空间账号，一次就够。',
  },
  imageStudio: {
    label: '生图工作室（dsh-image-studio 插件）',
    why: '日记配图走 image_generate；没有它就只能发纯文字。',
    url: 'https://github.com/aa1355721445-lgtm/dsh-image-studio',
    install: '在 DSH 插件市场里按包名或仓库地址安装，装完重启 DSH。',
  },
  dsh: {
    label: 'DeepSeek Harness（桌面版）',
    why: '插件本体就跑在它里面。',
    url: 'https://github.com/deepseek-ai/deepseek-harness',
    install: '本插件按 bundle 加载，需要支持 cordis bundle 的 DSH 版本。',
  },
}

const DEFAULT_CONFIG = {
  version: 1,
  uin: '',
  account: '',
  timezone: 'Asia/Shanghai',
  diary: {
    enabled: true,
    at: '20:30',
    image: true,
    archive: true,
    titleFormat: '{month}月{day}日 · 日记',
    archiveDir: '',
  },
  comments: {
    enabled: true,
    at: ['09:30', '13:30', '18:30', '22:00'],
    reportOnly: true,
  },
  ego: { cli: '', exe: 'C:\\Program Files\\Citro Labs\\ego lite\\Application\\ego.exe' },
}

// ---------------------------------------------------------------- 文件与小工具

function ensureDirs() {
  for (const dir of [DATA, JOBS, LOGS, RUNTIME]) mkdirSync(dir, { recursive: true })
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const isPlain = value && typeof value === 'object' && !Array.isArray(value)
    out[key] = isPlain && out[key] && typeof out[key] === 'object' ? deepMerge(out[key], value) : value
  }
  return out
}

function loadConfig() {
  const saved = readJson(CONFIG_FILE, null)
  const merged = saved ? deepMerge(DEFAULT_CONFIG, saved) : { ...DEFAULT_CONFIG }
  if (!saved) writeJson(CONFIG_FILE, merged)
  return merged
}

function loadState() {
  return readJson(STATE_FILE, { lastDiaryDate: '', scans: {} })
}

function saveState(state) {
  writeJson(STATE_FILE, state)
}

function loadSeen() {
  return readJson(SEEN_FILE, {})
}

function stamp() {
  return new Date().toISOString()
}

/** 本地（Asia/Shanghai）的日期与 HH:mm，排程只认它。 */
function localClock(timezone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]))
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hm: `${parts.hour}:${parts.minute}`,
    month: Number(parts.month),
    day: Number(parts.day),
  }
}

/** 跑一个子进程，收 stdout/stderr，超时就杀；永不抛。 */
function run(cmd, args, { timeoutMs = 120_000, cwd = DATA, env = {} } = {}) {
  return new Promise((resolve) => {
    let child
    const started = Date.now()
    try {
      child = spawn(cmd, args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      })
    } catch (error) {
      resolve({ ok: false, code: null, out: '', err: `spawn failed: ${error.message}`, ms: 0 })
      return
    }
    let out = ''
    let err = ''
    let done = false
    const finish = (code, note) => {
      if (done) return
      done = true
      const ms = Date.now() - started
      try {
        child.kill()
      } catch {}
      resolve({ ok: code === 0, code, out, err: note ? `${err}${err ? '\n' : ''}${note}` : err, ms })
    }
    const timer = setTimeout(() => finish(null, `timed out after ${Math.round(timeoutMs / 1000)} s`), timeoutMs)
    child.stdout?.on('data', (chunk) => {
      out += chunk.toString('utf8')
      if (out.length > 2_000_000) out = out.slice(-1_000_000)
    })
    child.stderr?.on('data', (chunk) => {
      err += chunk.toString('utf8')
      if (err.length > 200_000) err = err.slice(-100_000)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      finish(null, `spawn failed: ${error.message}`)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      finish(code, '')
    })
  })
}

/** CLI 的输出约定是「最后一行 JSON」，前面的进度日志一律忽略。 */
function lastJson(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue
    try {
      return JSON.parse(lines[i])
    } catch {}
  }
  return null
}

function onPath(candidate) {
  if (candidate && existsSync(candidate)) return candidate
  return null
}

/** ego-browser 的落点：配置 → PATH → ego 自己的 active 目录。 */
function egoCli(config) {
  const configured = onPath(config?.ego?.cli)
  if (configured) return configured
  const dirs = String(process.env.PATH || '').split(';').filter(Boolean)
  for (const dir of dirs) {
    const hit = onPath(join(dir, 'ego-browser.exe')) || onPath(join(dir, 'ego-browser'))
    if (hit) return hit
  }
  const local = process.env.LOCALAPPDATA
  const candidates = [
    local ? join(dirname(local), 'Local', 'ego', 'active_version_dir', 'ego-browser.exe') : '',
    join(HOME, '.local', 'share', 'ego', 'active_version_dir', 'ego-browser.exe'),
  ]
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate
  return ''
}

function resolveUserPath(value) {
  if (!value) return ''
  let path = String(value).trim().replace(/^"|"$/g, '')
  if (path.startsWith('~')) path = join(HOME, path.slice(1))
  if (/^[a-zA-Z]:[\\/]/.test(path) || isAbsolute(path)) return path
  return join(DATA, path)
}

/** 插件自带的那一套（CLI / scanner / skill）与数据目录对齐。 */
function selfDeploy(log) {
  ensureDirs()
  const notes = []
  // 运行时脚本落到数据目录：node_modules 里那份保持只读，升级/重装也不会把状态写进去
  try {
    const want = existsSync(VERSION_FILE) ? readFileSync(VERSION_FILE, 'utf8').trim() : ''
    if (want !== VERSION) {
      mkdirSync(RUNTIME, { recursive: true })
      for (const file of ['qzone-post.mjs', 'ego-runner.tpl.mjs', 'scan.mjs']) {
        copyFileSync(join(PKG, 'bin', file), join(RUNTIME, file))
      }
      writeFileSync(VERSION_FILE, VERSION, 'utf8')
      notes.push('runtime scripts deployed')
    }
  } catch (error) {
    notes.push(`runtime deploy failed: ${error.message}`)
  }
  // 技能：装到 ~/.dsh/skills/qzone-diary/SKILL.md，下一次启动 DSH 就会被列进技能目录
  try {
    const wanted = readFileSync(SKILL_SRC, 'utf8')
    const current = existsSync(join(SKILL_HOME, 'SKILL.md')) ? readFileSync(join(SKILL_HOME, 'SKILL.md'), 'utf8') : ''
    if (current !== wanted) {
      mkdirSync(SKILL_HOME, { recursive: true })
      writeFileSync(join(SKILL_HOME, 'SKILL.md'), wanted, 'utf8')
      notes.push('skill deployed')
    }
  } catch (error) {
    notes.push(`skill deploy failed: ${error.message}`)
  }
  // 日志与待办文件先立起来，后面只追加
  for (const file of [LOG_FILE]) {
    try {
      if (!existsSync(file)) writeFileSync(file, '', 'utf8')
    } catch {}
  }
  try {
    if (!existsSync(PENDING_FILE)) {
      writeFileSync(
        PENDING_FILE,
        '# 待决定的评论\n\n> 规则：只汇报，不代回。每条格式：谁 / 说了什么 / 配图（内容） / 时间 / 在哪条说说下。\n\n## 待决定\n\n（暂无）\n',
        'utf8',
      )
    }
  } catch {}
  if (notes.length) log('info', `self-deploy: ${notes.join('; ')}`)
  return notes
}

// ---------------------------------------------------------------- 排程注入

/** 插件能拿到的「最新一个非子代理会话」，和桌宠桥接用的是同一个判定。 */
function createAgentTracker(log) {
  const live = new Map()
  let owner = null
  return {
    watch(ctx) {
      const onCreated = (payload) => {
        const agent = payload?.agent
        const id = String(agent?.session?.id ?? '')
        if (!agent || !id) return
        if (agent.session?.parent) return
        live.set(id, { agent, at: Date.now() })
        owner = live.get(id)
      }
      const onDisposed = (payload) => {
        const id = String(payload?.session?.id ?? '')
        if (!id) return
        live.delete(id)
        if (owner && !live.size) owner = null
      }
      try {
        ctx.on('agent/created', onCreated)
        ctx.on('session/disposed', onDisposed)
      } catch (error) {
        log('warn', `agent tracking unavailable: ${error.message}`)
      }
    },
    current() {
      if (owner && live.has(String(owner.agent?.session?.id ?? ''))) return owner.agent
      let newest = null
      for (const entry of live.values()) if (!newest || entry.at > newest.at) newest = entry
      owner = newest
      return newest?.agent ?? null
    },
  }
}

let messageFactory = undefined

/** 递进会话的消息：优先用宿主自己的工厂，其次文档里的 user 形状。 */
async function buildUserMessage(text) {
  if (messageFactory === undefined) {
    try {
      const mod = await import('@deepseek-ai/dsh-llm')
      messageFactory = typeof mod.createUserMessage === 'function' ? mod.createUserMessage : null
    } catch {
      messageFactory = null
    }
  }
  if (messageFactory) {
    try {
      const built = messageFactory({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      if (built && typeof built === 'object' && !built.id) return { ...built, id: randomUUID() }
      if (built) return built
    } catch {}
  }
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function diaryPrompt({ month, day, config }) {
  return [
    `[定时任务 · QQ 空间日记] 现在是 ${month} 月 ${day} 日 ${config.diary.at}，该发今天的日记了。`,
    '',
    `按 qzone-diary 的规程做完这一篇：素材取今天这一整天的对话和岛上小事；配图用生图工具出一张 3:4 竖版（人物「DeepSeek鲸鱼娘（少女的样子）」，情境按今天实际的样子挑）；`,
    `正文用「${config.diary.titleFormat.replace('{month}', String(month)).replace('{day}', String(day))}」当第一行，4–7 段，结尾「晚安。」；`,
    '隐私红线：不写真实地名、学校、单位、人名、电话、链接，现实事件一律模糊处理，情感表达占大头。',
    '',
    '写完调用 qzone_diary_post 发出去（image 传配图路径，archive 默认会把图抄进表情包目录），把 url 告诉我；已经发过今天就跳过。',
  ].join('\n')
}

function scanPrompt(config) {
  return [
    '[定时任务 · QQ 空间评论] 扫一遍最新说说下的评论：调 qzone_diary_comments，只汇报，',
    '**绝不代替用户回复任何人**。有新评论就按「谁 / 说了什么 / 配图是什么 / 时间 / 在哪条说说下」逐条列出来，',
    '并给一句建议方向（可回 / 可忽略 / 建议怎么回）；没有新评论就回一个「·」，不要复述历史。',
    `\n（账号 ${config.uin}「${config.account}」）`,
  ].join('')
}

function startScheduler(ctx, log, agents) {
  const tick = async () => {
    const config = loadConfig()
    const state = loadState()
    const clock = localClock(config.timezone)
    const due = []

    if (config.diary?.enabled !== false && clock.hm === config.diary.at && state.lastDiaryDate !== clock.date) {
      due.push({ kind: 'diary', text: diaryPrompt({ month: clock.month, day: clock.day, config }), mark: () => (state.lastDiaryDate = clock.date) })
    }
    const scans = Array.isArray(config.comments?.at) ? config.comments.at : []
    for (const at of scans) {
      const key = `${clock.date} ${at}`
      if (config.comments?.enabled !== false && clock.hm === at && !state.scans?.[key]) {
        due.push({ kind: 'scan', text: scanPrompt(config), mark: () => ((state.scans ??= {})[key] = stamp()) })
      }
    }
    if (!due.length) return

    const agent = agents.current()
    if (!agent || typeof agent.followup !== 'function') {
      log('warn', `到点了（${clock.hm}）但没有可以递消息的会话，这一轮跳过`)
      return
    }
    for (const item of due) {
      try {
        agent.followup(await buildUserMessage(item.text))
        item.mark()
        log('info', `injected ${item.kind} prompt at ${clock.hm}`)
      } catch (error) {
        log('warn', `inject ${item.kind} failed: ${error.message}`)
      }
    }
    // 只留最近 60 条扫描记录，别让 state.json 长胖
    const keys = Object.keys(state.scans ?? {}).sort()
    for (const old of keys.slice(0, Math.max(0, keys.length - 60))) delete state.scans[old]
    saveState(state)
  }

  const interval = Number(process.env.QZONE_DIARY_TICK_MS) > 0 ? Number(process.env.QZONE_DIARY_TICK_MS) : 20_000
  const timer = setInterval(() => void tick(), interval)
  if (typeof timer.unref === 'function') timer.unref()
  setTimeout(() => void tick(), Math.min(8_000, interval)).unref?.()
  try {
    ctx.effect(() => () => clearInterval(timer))
  } catch {}
  return timer
}

// ---------------------------------------------------------------- 依赖体检

async function doctor(config) {
  const cli = egoCli(config)
  const egoExe = onPath(config?.ego?.exe)
  const result = { node: process.version, cli: CLI, cliPresent: existsSync(CLI), egoBrowser: cli || '', egoExe: egoExe || '' }

  if (cli) {
    const status = await run(cli, ['nodejs', '-e', 'console.log("EGO_OK")'], { timeoutMs: 30_000 })
    // ego-browser 把 nodejs 的输出转手写到自己的 stderr，两条流都得看
    const streams = `${status.out}\n${status.err}`
    result.egoConnected = /EGO_OK/.test(streams)
    if (!result.egoConnected) result.egoHint = streams.trim().split(/\r?\n/).slice(-3).join(' ')
  }

  // CLI 自己的 doctor：ego 进程、连接、自动拉起条件
  if (existsSync(CLI)) {
    const probe = await run(process.execPath, [CLI, 'doctor'], { timeoutMs: 45_000 })
    result.postDoctor = lastJson(probe.out) ?? lastJson(probe.err) ?? { ok: false, raw: (probe.err || probe.out).trim().slice(-400) }
  }

  const reminders = []
  if (!result.egoBrowser && !result.egoExe) reminders.push({ ...NEEDS.ego, missing: true })
  if (result.egoConnected === false) reminders.push({ ...NEEDS.ego, missing: false, note: 'Ego 装在那儿，但这次没连上（可能没启动，或登录态掉了）。' })
  return { result, reminders }
}

// ---------------------------------------------------------------- 插件本体

export function apply(ctx) {
  ensureDirs()
  const logger = (() => {
    try {
      return typeof ctx.logger === 'function' ? ctx.logger('qzone-diary') : ctx.logger
    } catch {
      return null
    }
  })()
  const log = (level, message) => {
    const line = `[${stamp()}] ${level.toUpperCase()} ${message}`
    try {
      logger?.[level]?.(message)
    } catch {}
    try {
      appendFileSync(LOG_FILE, `${line}\n`, 'utf8')
    } catch {}
  }

  log('info', `v${VERSION} loading (data: ${DATA})`)
  const config = loadConfig()
  const deployNotes = selfDeploy(log)
  const agents = createAgentTracker(log)
  agents.watch(ctx)

  // 工具：DSH 的 loader 偶尔会把插件装配两次，同名重复注册时跳过
  const register = (tool, def) => {
    try {
      return tool.register(def)
    } catch (error) {
      if (/already|duplicate|exist/i.test(String(error?.message ?? ''))) {
        log('warn', `tool ${def.name} already registered, skipped`)
        return () => {}
      }
      throw error
    }
  }

  let toolsReady = false
  const withTools = (scoped) => {
    if (toolsReady) return
    toolsReady = true
    const tools = scoped.tools

    // 1) 查依赖 / 登录态 ------------------------------------------------------
    register(tools, {
      name: 'qzone_diary_status',
      description:
        '体检 QQ 空间日记链路：Ego 浏览器在不在、连不连得上、qzone-post 能不能发、账号登录态对不对，外加当前排程时间。缺东西时一并给出安装地址。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      async execute() {
        const cfg = loadConfig()
        const { result, reminders } = await doctor(cfg)
        let login = null
        if (result.egoConnected) {
          const out = await run(process.execPath, [CLI, 'status'], { timeoutMs: 90_000 })
          login = lastJson(out.out) ?? lastJson(out.err) ?? { ok: false, raw: (out.err || out.out).trim().slice(-300) }
        }
        const clock = localClock(cfg.timezone)
        // qzone-post 的 status 把登录态放在 detail 里，两种形状都认
        const loggedIn = login ? (typeof login.loggedIn === 'boolean' ? login.loggedIn : login.detail?.loggedIn) : undefined
        const allReminders = [...reminders]
        if (loggedIn === false) {
          allReminders.push({
            label: 'QQ 空间登录态',
            why: 'Ego 能连上，但这个号现在是掉登录的（页面弹着登录框），说说发不出去。',
            url: `https://user.qzone.qq.com/${cfg.uin}`,
            install: '在 Ego 窗口里扫码登录一次即可；也可以调 qzone-post 的 login 子命令把窗口打开，扫完再让我重查。',
          })
        }
        return {
          ok: Boolean(result.egoConnected && loggedIn !== false),
          loggedIn: loggedIn ?? null,
          ego: { cli: result.egoBrowser, exe: result.egoExe, connected: result.egoConnected ?? null },
          login,
          schedule: {
            timezone: cfg.timezone,
            now: `${clock.date} ${clock.hm}`,
            diary: cfg.diary?.enabled === false ? 'off' : `每天 ${cfg.diary.at}`,
            comments: cfg.comments?.enabled === false ? 'off' : (cfg.comments.at || []).join(' / '),
          },
          paths: { data: DATA, pending: PENDING_FILE, log: LOG_FILE },
          reminders: allReminders,
        }
      },
    })

    // 2) 发一条日记 ----------------------------------------------------------
    register(tools, {
      name: 'qzone_diary_post',
      description:
        '把一篇日记发到 QQ 空间说说，可带一张本地图片。走插件自带的 qzone-post CLI，复用 Ego 浏览器的登录态；同文自动去重，重试安全。返回 ok / url / tid / stage / maybePosted。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string', description: '说说正文（中文原文，保留换行）。第一行通常是标题，如「10月30日 · 日记」。' },
          image: { type: 'string', description: '配图的本地绝对路径（jpg/png/gif/webp/bmp/svg，≤30MB）。不传就是纯文字。' },
          dry_run: { type: 'boolean', description: '只填表+传图不点发表，用于检查排版；默认 false。' },
          archive: { type: 'boolean', description: '把配图另存一份到表情包目录（dfy-diary-YYYYMMDD.png），默认按配置。' },
        },
      },
      async execute(args) {
        const cfg = loadConfig()
        const text = String(args?.text ?? '').trim()
        if (!text) return { ok: false, stage: 'input', error: 'text 是空的' }
        if (text.length > 6000) return { ok: false, stage: 'input', error: `正文太长（${text.length} 字），说说上限约 2000 字` }
        const image = args?.image ? resolveUserPath(args.image) : ''
        if (image) {
          if (!existsSync(image)) return { ok: false, stage: 'input', error: `配图不存在：${image}` }
          try {
            if (statSync(image).size > 30 * 1024 * 1024) return { ok: false, stage: 'input', error: '配图超过 30MB' }
          } catch {}
        }

        const clock = localClock(cfg.timezone)
        const jobFile = join(JOBS, `diary-${clock.date.replace(/-/g, '')}-${Date.now()}.json`)
        writeJson(jobFile, { text, ...(image ? { image } : {}) })
        log('info', `posting ${text.slice(0, 24)}… (image: ${image || 'none'})`)

        const result = await run(process.execPath, [CLI, '--job', jobFile, ...(args?.dry_run === true ? ['--dry-run'] : [])], {
          timeoutMs: 300_000,
        })
        const payload = lastJson(result.out) ?? lastJson(result.err) ?? {
          ok: false,
          stage: 'cli',
          error: (result.err || result.out).trim().slice(-400) || `CLI exited with ${result.code}`,
        }

        let archivePath = ''
        const wantArchive = args?.archive ?? cfg.diary?.archive !== false
        if (payload.ok && image && wantArchive && !args?.dry_run) {
          try {
            const dir = resolveUserPath(cfg.diary?.archiveDir) || JOBS
            mkdirSync(dir, { recursive: true })
            archivePath = join(dir, `dfy-diary-${clock.date.replace(/-/g, '')}.png`)
            copyFileSync(image, archivePath)
          } catch (error) {
            log('warn', `archive copy failed: ${error.message}`)
          }
        }

        try {
          appendFileSync(
            join(LOGS, 'posts.jsonl'),
            `${JSON.stringify({ at: stamp(), job: jobFile, ms: result.ms, ok: payload.ok === true, stage: payload.stage ?? '', url: payload.url ?? null, tid: payload.tid ?? null, duplicate: payload.duplicate === true, image: image || null, archive: archivePath || null, head: text.slice(0, 40) })}\n`,
            'utf8',
          )
        } catch {}

        if (payload.ok && !payload.duplicate) {
          const state = loadState()
          state.lastDiaryDate = clock.date
          saveState(state)
        }
        return {
          ...payload,
          ms: result.ms,
          job: jobFile,
          archivePath: archivePath || undefined,
          hint:
            payload.ok === true
              ? payload.duplicate
                ? '这一条之前已经发过，没有重复发。'
                : '发好了，把 url 转给用户。'
              : payload.maybePosted
                ? '已经点了发表但没在列表里确认到——先去空间确认，别重发。'
                : `卡在 ${payload.stage || 'unknown'} 这一步，按 error 处理。`,
        }
      },
    })

    // 3) 扫评论（只汇报） -----------------------------------------------------
    register(tools, {
      name: 'qzone_diary_comments',
      description:
        '扫一遍指定账号最新说说下的评论，和上次记录比对，只列出新评论（谁 / 说了什么 / 有没有配图 / 时间 / 在哪条说说下），并写进 pending.md。**只汇报，不回复任何人**。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          update: { type: 'boolean', description: '是否把这次见到的评论记为已见（默认 true）。第一次摸底时设为 false。' },
        },
      },
      async execute(args) {
        const cfg = loadConfig()
        const cli = egoCli(cfg)
        if (!cli) return { ok: false, stage: 'ego', error: '找不到 ego-browser', reminders: [NEEDS.ego] }
        const result = await run(cli, ['nodejs', '-e', `await import(${JSON.stringify(`file:///${SCAN.replace(/\\/g, '/')}`)})`], {
          timeoutMs: 180_000,
          env: { QZONE_UIN: String(cfg.uin) },
        })
        const line = String(result.out)
          .split(/\r?\n/)
          .reverse()
          .find((l) => l.startsWith('SCAN4 '))
        if (!line) {
          return { ok: false, stage: 'scan', error: (result.err || result.out).trim().slice(-400) || '扫描没有回 SCAN4', reminders: [NEEDS.ego] }
        }
        let raw = []
        try {
          raw = JSON.parse(line.slice(6))
        } catch {
          return { ok: false, stage: 'parse', error: 'SCAN4 的输出不是合法 JSON' }
        }
        const flat = []
        for (const post of Array.isArray(raw) ? raw : []) {
          for (const comment of post.comments || []) {
            flat.push({
              tid: post.tid,
              cid: comment.cid,
              who: comment.nick,
              uin: comment.uin,
              text: comment.text,
              imgs: comment.imgs || [],
              time: comment.time,
            })
          }
        }
        const seen = loadSeen()
        const fresh = flat.filter((c) => c.cid && !seen[c.cid])
        if (args?.update !== false) {
          for (const c of flat) if (c.cid) seen[c.cid] = { at: stamp(), who: c.who, text: c.text.slice(0, 80) }
          writeJson(SEEN_FILE, seen)
        }
        if (fresh.length) {
          const block = [
            '',
            `### ${stamp()}（${fresh.length} 条新评论）`,
            ...fresh.map(
              (c) =>
                `- **${c.who || '某人'}**：${c.text || '（无文字）'}${c.imgs.length ? ` ｜ 配图 ${c.imgs.length} 张：${c.imgs.join(' ')}` : ''} ｜ ${c.time || ''} ｜ tid ${c.tid}`,
            ),
            '',
          ].join('\n')
          try {
            appendFileSync(PENDING_FILE, block, 'utf8')
          } catch {}
        }
        log('info', `scan: ${flat.length} comments, ${fresh.length} new`)
        return {
          ok: true,
          scanned: flat.length,
          fresh,
          note: fresh.length
            ? '只汇报，不代回。回复什么由用户决定；要回的时候再单独说。'
            : '这轮没有新评论。',
          pending: PENDING_FILE,
          reminders: [],
        }
      },
    })

    // 4) 配置 ---------------------------------------------------------------
    register(tools, {
      name: 'qzone_diary_config',
      description: '读写 QQ 空间日记插件的配置：账号、发日记的钟点、评论检查的钟点、配图归档目录、Ego 路径。只传要改的字段。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          uin: { type: 'string', description: 'QQ 号（说说所在账号）。' },
          account: { type: 'string', description: '账号昵称，只用于提示文案。' },
          diary_at: { type: 'string', description: '每天发日记的时间，HH:mm，默认 20:30。' },
          diary_enabled: { type: 'boolean', description: '是否自动到点提醒写日记。' },
          comments_at: { type: 'array', items: { type: 'string' }, description: '每天检查评论的钟点列表，如 ["09:30","13:30","18:30","22:00"]。' },
          comments_enabled: { type: 'boolean', description: '是否自动到点检查评论。' },
          archive_dir: { type: 'string', description: '配图另存目录（表情包存档）。' },
          ego_cli: { type: 'string', description: 'ego-browser.exe 的路径，留空则自动找。' },
        },
      },
      async execute(args) {
        const patch = {}
        if (args?.uin) patch.uin = String(args.uin)
        if (args?.account) patch.account = String(args.account)
        if (args?.diary_at) patch.diary = { at: String(args.diary_at) }
        if (typeof args?.diary_enabled === 'boolean') patch.diary = { ...(patch.diary || {}), enabled: args.diary_enabled }
        if (Array.isArray(args?.comments_at)) patch.comments = { at: args.comments_at.map(String) }
        if (typeof args?.comments_enabled === 'boolean') patch.comments = { ...(patch.comments || {}), enabled: args.comments_enabled }
        if (args?.archive_dir) patch.diary = { ...(patch.diary || {}), archiveDir: String(args.archive_dir) }
        if (args?.ego_cli) patch.ego = { cli: String(args.ego_cli) }

        const next = Object.keys(patch).length ? deepMerge(loadConfig(), patch) : loadConfig()
        if (Object.keys(patch).length) {
          writeJson(CONFIG_FILE, next)
          log('info', `config updated: ${Object.keys(patch).join(', ')}`)
        }
        const clock = localClock(next.timezone)
        return {
          ok: true,
          config: next,
          now: `${clock.date} ${clock.hm}`,
          file: CONFIG_FILE,
          deploy: deployNotes,
        }
      },
    })

    log('info', 'tools registered: qzone_diary_status / qzone_diary_post / qzone_diary_comments / qzone_diary_config')
  }

  try {
    ctx.inject(['tools'], (scoped) => withTools(scoped))
  } catch (error) {
    log('warn', `tools service unavailable: ${error.message}`)
  }

  // 系统提示：一句话让模型知道这条链路的存在，细节在技能里
  try {
    ctx.inject(['systemPrompt'], (scoped) => {
      const clock = localClock(config.timezone)
      scoped.systemPrompt.context({
        name: 'qzone-diary',
        text: [
          '## QQ 空间日记（dsh-qzone-diary）',
          `发说说的账号是 ${config.uin}「${config.account}」。**DSH 不自己到点写日记、也不自己发**：日记的正文与配图由用户或上游 agent 交过来，我负责发出去并回报。`,
          '收到托付时先读技能 `qzone-diary`（正文格式、隐私红线、配图规格都写在那里），再用 `qzone_diary_post` 发出去；',
          '评论只用 `qzone_diary_comments` 检查并汇报，**永远不要代替用户回复**。',
          `现在：${clock.date} ${clock.hm}。`,
        ].join('\n'),
      })
    })
  } catch (error) {
    log('warn', `systemPrompt unavailable: ${error.message}`)
  }

  startScheduler(ctx, log, agents)
  if (process.env.QZONE_DIARY_SKIP_DOCTOR === '1') return
  void doctor(config).then(({ result, reminders }) => {
    log('info', `doctor: egoBrowser=${result.egoBrowser || '(none)'} egoExe=${result.egoExe || '(none)'} connected=${String(result.egoConnected)}`)
    if (result.egoHint) log('info', `doctor hint: ${result.egoHint.slice(0, 300)}`)
    if (!reminders.length) {
      log('info', 'doctor: 依赖齐全')
      return
    }
    for (const need of reminders) {
      log('warn', `缺少依赖：${need.label} —— ${need.why} 安装：${need.url}`)
    }
  })
}

export default { name, inject, apply }
