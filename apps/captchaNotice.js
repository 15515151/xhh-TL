/**
 * 米游社撞验证码 → 自动过码并重试
 *
 * 为什么走 Handler 而不是改各插件源码：
 *   genshin / miao-plugin 都是第三方插件，直接改会被 #更新 覆盖。
 *   但这两家撞码时都会汇到 genshin 的 MysInfo.checkCode，那里会调
 *   runtime.handler.call("mys.req.err")。在本插件注册同一个 key，
 *   即可一次覆盖两家所有会撞码的指令，且更新不掉。
 *
 * 行为分两种：
 *   - 配了 auto_verify_addr（本地过码服务）：**直接过码 + 重试原请求**，用户无感
 *   - 没配：退回提醒「发 #过码」，用户自己点链接手划
 *
 * 为什么要「吃掉」紧随其后的旧提示：
 *   checkCode 在 handler 全部 reject 之后，会自己补一句
 *   「UID:xxx，米游社查询遇到验证码，请稍后再试」。自动过码成功时那句是多余的
 *   （查询已经成功了），失败时它也没告诉用户下一步发什么 —— 两种情况都该换成
 *   本插件的话术。这里在返回前短暂接管 e.reply，把那条吞掉。
 */

import plugin from '../../../lib/plugins/plugin.js'
import { config } from '../utils/pluginConfig.js'
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

/** 同一个号 60 秒内只处理一次（一次查询可能连撞几码，重复过码没意义还费时） */
const BUSY_TTL = 60_000
const recent = new Map()

function isBusy(key) {
  const now = Date.now()
  const last = recent.get(key)
  if (last && now - last < BUSY_TTL) return true
  recent.set(key, now)
  if (recent.size > 500) {
    for (const [k, t] of recent) {
      if (now - t > BUSY_TTL) recent.delete(k)
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
      name: '[小火花]米游社撞码处理',
      dsc: '撞米游社验证码时自动过码并重试',
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

    const uid = String(args?.mysInfo?.uid || args?.data?.uid || '')
    const game = args?.mysApi?.game || args?.mysInfo?.e?.game || 'gs'
    const cookie = args?.mysApi?.cookie || args?.mysInfo?.ckInfo?.ck || ''
    const autoAddr = config().auto_verify_addr || ''

    // 没配过码服务，或拿不到 ck / 没有可回复的事件 → 退回提醒
    if (!autoAddr || !cookie || !e?.reply) {
      return this.noticeOnly(e, uid, game)
    }

    // 同号 60 秒内不重复过码（一次查询会连撞几码）
    const key = `${e.user_id}:${uid}:${game}`
    if (isBusy(key)) return reject()

    // ★ 全自动：过码成功后重试原请求
    try {
      log.mark(`[xhh-TL][撞码] uid=${uid} 自动过码中…`)
      const { solveByLocalService } = await import('../utils/mysVerify.js')
      const ok = await solveByLocalService({ cookie, autoVerifyAddr: autoAddr })
      if (!ok) return this.noticeOnly(e, uid, game)

      log.mark(`[xhh-TL][撞码] uid=${uid} 过码成功，重试原请求`)
      // 用原参数重打一次；MysApi.getData 内部有缓存，过码后需要绕过，
      // 所以这里带 Getfp 标记之外再换个 cache 场景：直接重试即可（风控码本就不缓存）
      const retry = await args.mysApi.getData(args.type, args.data || {})
      if (retry && Number(retry.retcode) === 0) {
        log.mark(`[xhh-TL][撞码] uid=${uid} 重试成功`)
        suppressLegacyNotice(e)
        return retry
      }
      log.mark(`[xhh-TL][撞码] uid=${uid} 过码后重试仍失败: retcode=${retry?.retcode}`)
      return this.noticeOnly(e, uid, game)
    } catch (err) {
      log.error(`[xhh-TL][撞码] 自动过码异常: ${err?.message}`)
      return this.noticeOnly(e, uid, game)
    }
  }

  /** 兜底：只提醒用户发 #过码（过码服务没配/没成功时） */
  async noticeOnly(e, uid, game) {
    if (!e?.reply) return
    try {
      await e.reply(`${uid ? `UID:${uid} ` : ''}${captchaTip(game)}`, quoteEnabled())
    } catch (err) {
      log.error(`[xhh-TL][撞码提醒] 发送失败: ${err?.message}`)
    }
    suppressLegacyNotice(e)
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
