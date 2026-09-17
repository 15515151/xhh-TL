/**
 * 参量质变仪 / 洞天宝钱 到期提醒的定时器
 *
 * 设计要点：**不额外打米游社接口**。数据全部来自用户查询体力时的那份快照
 * （dailyNote，见 apps/TL.js 的质变仪补拉），这里只做三件事：
 *   1. 把「剩余秒数」换算成绝对到期时刻 dueAt
 *   2. 落盘（进程重启后能重新挂上）
 *   3. 用 setTimeout 等到点，回调交给 resinPush 去 @ 人
 *
 * 为什么不放 apps/ 下：TL.js 和 resinPush.js 都要用它，放 utils 避免循环依赖。
 * 本模块**不 import** TL / resinPush / Bot —— 发送能力由 resinPush 通过
 * registerReminderHooks() 注册进来（依赖方向：apps → utils，单向）。
 */

import fs from 'fs'
import path from 'path'
import { config, pluginDir } from './pluginConfig.js'

const log = {
  info: (...a) => (typeof logger !== 'undefined' ? logger.info?.(...a) : console.log(...a)),
  mark: (...a) => (typeof logger !== 'undefined' ? logger.mark?.(...a) : console.log(...a)),
  error: (...a) => (typeof logger !== 'undefined' ? logger.error?.(...a) : console.error(...a)),
  debug: (...a) => (typeof logger !== 'undefined' ? logger.debug?.(...a) : null),
}

const DATA_DIR = path.join(pluginDir, 'data')
const TIMER_FILE = path.join(DATA_DIR, 'resin_timer.json')

/**
 * Node 的 setTimeout 超过 2^31-1 毫秒会溢出并「立即触发」，
 * 所以超长延时要分段续挂（见 arm）。24.8 天，质变仪最长 7 天，纯防御。
 */
const MAX_TIMEOUT = 2 ** 31 - 1

/** 重启时发现已过期：12 小时内的补发一次，更久的丢弃（等下次查询重算） */
const OVERDUE_GRACE_MS = 12 * 60 * 60 * 1000

/** 记录保鲜期：7 天没被任何一次查询更新过就清掉 */
const RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 发送失败后的重试间隔与次数上限。
 * 最典型的失败是「重启补发」：scheduleTimers() 在插件构造期就跑，那时适配器还没连上，
 * Bot 还是 undefined（日志时序：挂定时器 → 插件加载完 → 适配器连接，中间差好几秒）。
 * 这种失败不能把提醒标成 fired 吞掉，得留着等 Bot 上线。
 * 首次重试给 15 秒（适配器通常 10 秒内连上），之后退回 60 秒，避免真失败时刷屏。
 */
const RETRY_FIRST_MS = 15 * 1000
const RETRY_DELAY_MS = 60 * 1000
const MAX_RETRY = 5

/** 两种提醒类型（存储键名） */
const TYPES = ['transformer', 'homeCoin']

/** 内存缓存（首次读盘后常驻，写入时同步更新） */
let _store = null
/** 已挂的定时器：`${game}:${uid}:${type}` → Timeout */
const _timers = new Map()
/** 由 resinPush 注册：targets 同步反查订阅者，send 异步发送 */
let _hooks = { targets: null, send: null }

// ============ 存储 ============

function loadStore() {
  if (_store) return _store
  try {
    if (fs.existsSync(TIMER_FILE)) {
      _store = JSON.parse(fs.readFileSync(TIMER_FILE, 'utf8')) || {}
    } else {
      _store = {}
    }
  } catch (err) {
    log.error(`[xhh-TL][resinTimer] 读取 ${TIMER_FILE} 失败: ${err.message}`)
    _store = {}
  }
  if (!_store.gs) _store.gs = {}
  return _store
}

function saveStore(store = _store) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(TIMER_FILE, JSON.stringify(store, null, 2))
  } catch (err) {
    log.error(`[xhh-TL][resinTimer] 保存失败: ${err.message}`)
  }
}

// ============ 快照解析 ============

/**
 * 参量质变仪：从快照算出到期信息。
 * 只认带秒数的原始结构 —— 30 分钟缓存视图（transformerView）没有秒数，
 * 只能判「已可用」，绝不能用它去覆盖已算好的 dueAt。
 * @returns {{kind:'due', dueAt:number}|{kind:'ready'}|null} null = 本次快照没这个信息
 */
function readTransformerDeadline(data, now) {
  const raw = data?.transformer
  if (raw && typeof raw === 'object') {
    if (raw.obtained === false) return null // 尚未获得，没有「到期」概念
    const rt = raw.recovery_time
    if (rt && typeof rt === 'object') {
      const sec =
        (((Number(rt.Day) || 0) * 24 + (Number(rt.Hour) || 0)) * 60 + (Number(rt.Minute) || 0)) * 60 +
        (Number(rt.Second) || 0)
      if (rt.reached || sec <= 0) return { kind: 'ready' }
      return { kind: 'due', dueAt: now + sec * 1000 }
    }
    if (raw.reached) return { kind: 'ready' }
    // 旧结构：rec_time 是绝对时刻串 "YYYY-MM-DD HH:mm:ss"（补 T 后按本地时区解析）
    const str = String(raw.rec_time || '')
    const t = new Date(str.replace(' ', 'T')).getTime()
    if (Number.isFinite(t)) {
      return t <= now ? { kind: 'ready' } : { kind: 'due', dueAt: t }
    }
  }
  // 只有归一视图（缓存命中，无秒数）：只能判「已可用」
  if (data?.transformerView?.ok === true) return { kind: 'ready' }
  return null
}

/**
 * 洞天宝钱：满了才提醒。
 * home_coin_recovery_time 是**字符串**剩余秒（实测 dailyNote 返回 "200255"），要 Number 强转。
 * widget 接口不返回该字段 → 返回 null，等下次走 dailyNote 的查询，不猜速率。
 */
function readHomeCoinDeadline(data, now) {
  const cur = Number(data?.current_home_coin)
  const max = Number(data?.max_home_coin)
  if (!Number.isFinite(cur) || !Number.isFinite(max) || max <= 0) return null
  if (cur >= max) return { kind: 'ready' }
  const sec = Number(data?.home_coin_recovery_time)
  if (!Number.isFinite(sec) || sec <= 0) return null
  return { kind: 'due', dueAt: now + sec * 1000 }
}

/**
 * armed / fired 翻转的唯一出口。
 * @param {object|undefined} prev 上次的状态 { dueAt, state, notifiedAt }
 * @param {{kind:'due',dueAt:number}|{kind:'ready'}} info 本次快照算出的信息
 */
function mergeDeadline(prev, info, now) {
  if (info.kind === 'ready') {
    // 已挂过未来时刻、数据却说到期了（快到了 / 时钟抖动）→ 提前到当下，别丢这次提醒
    if (prev?.state === 'armed' && prev.dueAt > now) {
      return { dueAt: now, state: 'armed', notifiedAt: prev.notifiedAt || 0 }
    }
    // 提醒过、用户还没用掉 → 保持 fired，不重复打扰
    if (prev?.state === 'fired') return prev
    // 新记录且查询时就已经满/已可用 → 静默（用户刚在图上看见了，不该立刻被 @）
    return { dueAt: 0, state: 'fired', notifiedAt: now }
  }
  // 出现新的未来到期时刻 = 用户用掉了，重新武装
  if (prev?.state === 'fired') {
    return { dueAt: info.dueAt, state: 'armed', notifiedAt: prev.notifiedAt || 0 }
  }
  return { dueAt: info.dueAt, state: 'armed', notifiedAt: 0 }
}

// ============ 定时器 ============

function timerKey(game, uid, type) {
  return `${game}:${uid}:${type}`
}

function clearTimer(game, uid, type) {
  const key = timerKey(game, uid, type)
  const id = _timers.get(key)
  if (id) {
    clearTimeout(id)
    _timers.delete(key)
  }
}

function clearAllTimers() {
  for (const id of _timers.values()) clearTimeout(id)
  _timers.clear()
}

/** 该账号有没有人订阅（没有就不空转，等订阅了 scheduleTimers 会重挂） */
function hasTargets(game, uid) {
  try {
    return !!_hooks.targets?.(game, uid)?.length
  } catch (err) {
    log.debug(`[xhh-TL][resinTimer] targets 查询失败: ${err?.message}`)
    return false
  }
}

function enabled() {
  const cfg = config()
  return cfg.resin_timer_enable !== false && cfg.resin_push_enable !== false
}

/**
 * 挂一个定时器。超 MAX_TIMEOUT 的延时分段续挂
 * （Node 超过 2^31-1ms 会溢出立即触发，不能直接 setTimeout）。
 */
function arm(game, uid, type, delay, attempt = 0) {
  const key = timerKey(game, uid, type)
  clearTimer(game, uid, type)
  const wait = Math.max(1, Math.min(Number(delay) || 0, MAX_TIMEOUT))
  const id = setTimeout(() => {
    _timers.delete(key)
    const st = loadStore()?.[game]?.[uid]?.[type]
    // 分段醒来：还没到点就续挂；状态已被改（用户用掉/关订阅）则不再管
    if (!st || st.state !== 'armed') return
    const left = st.dueAt - Date.now()
    // 分段续挂要带上 attempt，否则重试计数被清零（质变仪最长 7 天碰不到 24.8 天阈值，纯防御）
    if (left > 1000) return arm(game, uid, type, left, attempt)
    // fire 是 async 且内部已捕获发送错误，这里再兜一层防 unhandled rejection
    fire(game, uid, type, attempt).catch((err) =>
      log.error(`[xhh-TL][resinTimer] 提醒处理异常 ${game}/${uid}/${type}: ${err?.message}`),
    )
  }, wait)
  _timers.set(key, id)
}

/**
 * 把一条提醒标成「已提醒」并落盘。
 * armed/fired 的写入点统一走这里，别在别处手改 state（容易漏 updatedAt）。
 * 注意 loadStore() 返回的是内存缓存引用，重复调用拿到的是同一份，不必反复取。
 */
function markFired(game, uid, type) {
  const store = loadStore()
  const st = store?.[game]?.[uid]?.[type]
  if (!st) return
  st.state = 'fired'
  st.notifiedAt = Date.now()
  store[game][uid].updatedAt = Date.now()
  saveStore(store)
}

/**
 * 到点：发送成功才落盘 fired。
 *
 * ⚠️ 顺序不能反。原先写成「先落盘 fired 再发送」，一旦发送失败这条提醒就**永久丢了**
 * —— 重启补发必然踩中：scheduleTimers() 在插件构造期跑，那时适配器还没连上、
 * Bot 是 undefined，发送直接抛错，而 state 已经变成 fired 不会再重试。
 * 代价是「发送成功后、落盘前」崩溃会重复提醒一次，概率极低且比漏发温和。
 *
 * @param {number} attempt 已重试次数；失败时按 RETRY_DELAY_MS 重挂，超过 MAX_RETRY 才放弃
 */
async function fire(game, uid, type, attempt = 0) {
  const store = loadStore()
  const st = store?.[game]?.[uid]?.[type]
  if (!st || st.state !== 'armed') return

  const targets = hasTargets(game, uid) ? _hooks.targets(game, uid) || [] : []
  // 出图用的精简快照（记录里存的那份，不重查接口）
  const item = store[game][uid].snap || { uid: String(uid) }

  // 没有订阅者：直接标 fired，不必重试（用户可能刚关掉推送）
  if (!targets.length) {
    markFired(game, uid, type)
    return
  }

  try {
    await _hooks.send?.({ game, uid, type, targets, item })
  } catch (err) {
    const n = attempt + 1
    // 重新取一次状态：这期间可能已被新一轮查询改写（用户用掉了 → 重新 armed）
    const cur = loadStore()?.[game]?.[uid]?.[type]
    if (n <= MAX_RETRY && cur?.state === 'armed') {
      const delay = n === 1 ? RETRY_FIRST_MS : RETRY_DELAY_MS
      log.error(
        `[xhh-TL][resinTimer] 提醒发送失败 ${game}/${uid}/${type}（第 ${n} 次），` +
          `${delay / 1000} 秒后重试: ${err?.message}`,
      )
      arm(game, uid, type, delay, n)
    } else {
      log.error(
        `[xhh-TL][resinTimer] 提醒发送失败 ${game}/${uid}/${type}，放弃: ${err?.message}`,
      )
      if (cur?.state === 'armed') markFired(game, uid, type)
    }
    return
  }

  // 发送成功才落盘（先重取状态，避免覆盖这期间别的更新）
  if (loadStore()?.[game]?.[uid]?.[type]?.state === 'armed') markFired(game, uid, type)
}

// ============ 对外 API ============

/** resinPush 构造时注册「发给谁 / 怎么发」 */
export function registerReminderHooks(hooks = {}) {
  _hooks = { targets: hooks.targets || null, send: hooks.send || null }
}

/**
 * TL.finishNote 每次拿到 gs 快照后调用。
 * 解析 → 更新记录 → 落盘 → 挂定时器（就是「首次获取之后开个定时器」）。
 */
export function recordResinTimer(game, uid, data) {
  if (game !== 'gs' || !uid || !data || typeof data !== 'object') return
  if (!enabled()) return

  const now = Date.now()
  const tf = readTransformerDeadline(data, now)
  const hc = readHomeCoinDeadline(data, now)
  if (!tf && !hc) return

  const store = loadStore()
  const key = String(uid)
  const rec = store.gs[key] || (store.gs[key] = { uid: key, updatedAt: now })
  if (data._ownerSid) rec.sid = String(data._ownerSid)
  if (tf) rec.transformer = mergeDeadline(rec.transformer, tf, now)
  if (hc) rec.homeCoin = mergeDeadline(rec.homeCoin, hc, now)
  // 精简快照：到点要出提醒卡，但那时手上只有记录（不重查接口）。
  // 只存渲染用得上的几个字段，别把整个 data（含 expeditions 等）塞进来。
  rec.snap = {
    uid: key,
    current_home_coin: Number(data.current_home_coin) || 0,
    max_home_coin: Number(data.max_home_coin) || 0,
    transformerView: data.transformerView
      ? { ok: !!data.transformerView.ok, text: String(data.transformerView.text || '') }
      : null,
  }
  rec.updatedAt = now
  saveStore(store)

  // 立刻挂/换定时器（到期时刻可能刚被刷新）
  for (const type of TYPES) {
    const st = rec[type]
    if (!st) continue
    if (st.state === 'armed' && hasTargets(game, key)) {
      const left = st.dueAt - Date.now()
      if (left > 0) arm(game, key, type, left)
    } else {
      clearTimer(game, key, type)
    }
  }
}

/**
 * 重算全部定时器（幂等：先 clear 再 set）。
 * 调用时机：插件加载时（重启恢复）、订阅变更后、每轮 checkAll 收尾。
 */
export function scheduleTimers() {
  if (!enabled()) {
    clearAllTimers()
    return
  }
  const store = loadStore()
  const now = Date.now()
  let armed = 0
  let dirty = false

  for (const game of Object.keys(store)) {
    for (const uid of Object.keys(store[game] || {})) {
      const rec = store[game][uid]
      if (!rec) continue
      // 陈旧记录清理
      if (now - (rec.updatedAt || 0) > RECORD_TTL_MS) {
        delete store[game][uid]
        for (const type of TYPES) clearTimer(game, uid, type)
        dirty = true
        continue
      }
      for (const type of TYPES) {
        const st = rec[type]
        if (!st || st.state !== 'armed' || !hasTargets(game, uid)) {
          clearTimer(game, uid, type)
          continue
        }
        const left = st.dueAt - now
        if (left > 0) {
          arm(game, uid, type, left)
          armed++
        } else if (left > -OVERDUE_GRACE_MS) {
          // 停机期间到期（12 小时内）→ 立刻补一次
          arm(game, uid, type, 0)
          armed++
        } else {
          // 过期太久：丢弃，等下次查询重算
          st.state = 'fired'
          st.notifiedAt = now
          clearTimer(game, uid, type)
          dirty = true
        }
      }
    }
  }

  if (dirty) saveStore(store)
  if (armed) log.info(`[xhh-TL][resinTimer] 已挂 ${armed} 个到期提醒`)
}

/** 单个 uid 重算（订阅变更后用，比全量轻） */
export function refreshUidTimers(game, uid) {
  if (!enabled()) {
    clearTimer(game, uid, 'transformer')
    clearTimer(game, uid, 'homeCoin')
    return
  }
  const rec = loadStore()?.[game]?.[String(uid)]
  if (!rec) return
  const now = Date.now()
  for (const type of TYPES) {
    const st = rec[type]
    if (!st || st.state !== 'armed' || !hasTargets(game, String(uid))) {
      clearTimer(game, String(uid), type)
      continue
    }
    const left = st.dueAt - now
    if (left > 0) arm(game, String(uid), type, left)
    else if (left > -OVERDUE_GRACE_MS) arm(game, String(uid), type, 0)
  }
}

/** 供「体力推送列表」展示用：该 uid 的两个到期状态 */
export function timerStats(game, uid) {
  const rec = loadStore()?.[game]?.[String(uid || '')]
  if (!rec) return null
  const out = {}
  for (const type of TYPES) {
    const st = rec[type]
    if (st) out[type] = { dueAt: st.dueAt, state: st.state }
  }
  return Object.keys(out).length ? out : null
}

export default { registerReminderHooks, recordResinTimer, scheduleTimers, refreshUidTimers, timerStats }
