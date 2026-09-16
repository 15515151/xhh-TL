/**
 * 米游社撞验证码 → 提醒「可以发 #过码」
 *
 * 为什么走 Handler 而不是改各插件源码：
 *   genshin / miao-plugin 都是第三方插件，直接改会被 #更新 覆盖。
 *   但这两家撞码时都会汇到 genshin 的 MysInfo.checkCode，那里会调
 *   runtime.handler.call("mys.req.err")。在本插件注册同一个 key，
 *   即可一次覆盖两家所有会撞码的指令，且更新不掉。
 *
 * 为什么还要「吃掉」紧随其后的旧提示：
 *   checkCode 在 handler 全部 reject 之后，会自己补一句
 *   「UID:xxx，米游社查询遇到验证码，请稍后再试」——那句只说了出什么事，
 *   没告诉用户下一步发什么。这里在返回前短暂接管 e.reply，把那条吞掉，
 *   只留本插件这句带 #过码 的。接管失败最坏也只是多发一条旧文案，
 *   不影响查询本身（每个事件一个 e，包装不跨消息串台）。
 */

import plugin from '../../../lib/plugins/plugin.js'
import { quoteEnabled } from '../utils/replyHelper.js'
import { captchaTip } from '../utils/captchaTip.js'

const log = {
  mark: (...a) => (typeof logger !== 'undefined' ? logger.mark(...a) : console.log(...a)),
  error: (...a) => (typeof logger !== 'undefined' ? logger.error(...a) : console.error(...a)),
}

/** 米游社风控码：撞到这些基本就是要过码 */
const CAPTCHA_RC = [1034, 5003, 10035, 10041]

/** 旧提示的正文特征。范围收得很窄，只吞这一条，避免误伤正常回复 */
const LEGACY_NOTICE_RE = /米游社查询遇到验证码/

/** 同一个人同一个号，一分钟内只提醒一次（一次查询可能连撞几码） */
const NOTICE_TTL = 60_000
const recentNotice = new Map()

function isThrottled(key) {
  const now = Date.now()
  const last = recentNotice.get(key)
  if (last && now - last < NOTICE_TTL) return true
  recentNotice.set(key, now)
  if (recentNotice.size > 500) {
    for (const [k, t] of recentNotice) {
      if (now - t > NOTICE_TTL) recentNotice.delete(k)
    }
  }
  return false
}

function isLegacyNotice(msg) {
  if (typeof msg === 'string') return LEGACY_NOTICE_RE.test(msg)
  if (Array.isArray(msg)) {
    return msg.some((m) => typeof m === 'string' && LEGACY_NOTICE_RE.test(m))
  }
  return false
}

export class captchaNotice extends plugin {
  constructor() {
    super({
      name: '[小火花]米游社撞码提醒',
      dsc: '撞米游社验证码时提醒可发 #过码',
      namespace: 'xhh-TL',
      handler: [{ key: 'mys.req.err', fn: 'onMysReqErr' }],
    })
  }

  /**
   * @param e 实时事件
   * @param args { mysApi, type, res, data, mysInfo }
   * @param reject 调用即表示「本 handler 不处理，交给下一个」
   */
  async onMysReqErr(e, args, reject) {
    const rc = Number(args?.res?.retcode)
    // 非风控码：不是过码能解决的事，原样放行
    if (!CAPTCHA_RC.includes(rc)) return reject()
    // 没有可回复的事件（如定时任务）就没法提醒，也不该吞提示
    if (!e?.reply) return reject()

    const uid = String(args?.mysInfo?.uid || args?.data?.uid || '')
    const game = args?.mysApi?.game || args?.mysInfo?.e?.game || 'gs'
    // 节流按「人 + 游戏」：一个号撞码后其它号大概率也撞，只提醒一次就够；
    // 不同游戏给的指令不同（#过码 / #星铁过码），所以分开计。
    const key = `${e.user_id}:${game}`
    if (isThrottled(key)) return reject()

    // 先发提醒，再接管 e.reply —— 顺序反了会把咱自己这条也拦掉
    try {
      await e.reply(`${uid ? `UID:${uid} ` : ''}${captchaTip(game)}`, quoteEnabled())
    } catch (err) {
      log.error(`[xhh-TL][撞码提醒] 发送失败: ${err?.message}`)
    }

    suppressLegacyNotice(e)
    return reject()
  }
}

/**
 * 短暂接管 e.reply：把 checkCode 紧随其后要发的那条旧提示吞掉。
 * 无论后续走哪个分支，下一轮事件循环一定恢复，不会长期占着 e.reply。
 */
function suppressLegacyNotice(e) {
  const orig = e?.reply
  if (typeof orig !== 'function') return
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    e.reply = orig
  }
  e.reply = function (msg, ...rest) {
    const hit = isLegacyNotice(msg)
    restore()
    if (hit) return Promise.resolve()
    return orig.call(this, msg, ...rest)
  }
  setTimeout(restore, 0)
}
