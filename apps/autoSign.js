/**
 * 米游社自动签到（原神 / 星铁 / 绝区零）
 *
 * - 用户 opt-in 订阅：发 #原神自动签到 后才纳入每日自动签，仿体力推送的显式订阅
 * - 手动签到：#原神签到 / #星铁签到 / #绝区零签到 —— 立即签一次并回报结果
 * - 每日 cron 定时对所有订阅者的对应游戏全部绑定 UID 逐个签到
 * - 签到走 utils/signClient.js（稳定 device_id + 真 device_fp），弹验证码概率低
 *
 * 指令：
 *   #原神签到 / #星铁签到 / #绝区零签到        立即签一次
 *   #原神自动签到 / #原神自动签到开启          开启每日自动签（星铁/绝区零同理）
 *   #原神自动签到关闭                          关闭
 *   #签到列表 / #自动签到列表                  查看自己的订阅
 */

import fs from 'fs'
import path from 'path'
import plugin from '../../../lib/plugins/plugin.js'
import { createUser } from '../utils/userBind.js'
import { resolveAuth } from '../utils/runtimePatch.js'
import { signOne, GAME_LABEL } from '../utils/signClient.js'
import { runBbsVerify } from '../utils/mysVerify.js'
import LiteMysApi from '../utils/mysClient.js'
import { config, pluginDir } from '../utils/pluginConfig.js'

const DATA_DIR = path.join(pluginDir, 'data')
const CONFIG_FILE = path.join(DATA_DIR, 'auto_sign.json')

// 默认凌晨随机分钟，避开整点风控高峰
const DEFAULT_CRON = '23 0 * * *'

const GAMES = ['gs', 'sr', 'zzz']

const GAME_ALIAS = {
  gs: '(?:原神|ys)',
  sr: '(?:星铁|崩铁|星穹铁道|xt)',
  zzz: '(?:绝区零|zzz)',
}

// ============ 配置读写 ============
// 结构：{ gs: { "<qq>": { group: "123"|"" } }, sr: {...}, zzz: {...} }
function ensureDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  } catch (_) {}
}

function loadSubs() {
  const empty = () => {
    const o = {}
    for (const g of GAMES) o[g] = {}
    return o
  }
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}
      const subs = {}
      for (const g of GAMES) subs[g] = data[g] || {}
      return subs
    }
  } catch (err) {
    logger?.error?.(`[xhh-TL][自动签到] 读取配置失败: ${err.message}`)
  }
  return empty()
}

function saveSubs(subs) {
  try {
    ensureDir()
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(subs, null, 2))
  } catch (err) {
    logger?.error?.(`[xhh-TL][自动签到] 保存配置失败: ${err.message}`)
  }
}

export class autoSign extends plugin {
  constructor() {
    const cfg = config()
    const cron = cfg.auto_sign_cron || DEFAULT_CRON

    super({
      name: '[小花火]米游社自动签到',
      dsc: '原神/星铁/绝区零 每日自动签到',
      event: 'message',
      priority: -Infinity,
      rule: [
        // 自动签到（关闭）— 先于开启匹配
        { reg: `^\\s*#?${GAME_ALIAS.gs}自动签到\\s*(?:关闭|关|取消|停止)\\s*$`, fnc: 'offGs' },
        { reg: `^\\s*#?${GAME_ALIAS.sr}自动签到\\s*(?:关闭|关|取消|停止)\\s*$`, fnc: 'offSr' },
        { reg: `^\\s*#?${GAME_ALIAS.zzz}自动签到\\s*(?:关闭|关|取消|停止)\\s*$`, fnc: 'offZzz' },
        // 自动签到（开启）
        { reg: `^\\s*#?${GAME_ALIAS.gs}自动签到\\s*(?:开启|开|打开)?\\s*$`, fnc: 'onGs' },
        { reg: `^\\s*#?${GAME_ALIAS.sr}自动签到\\s*(?:开启|开|打开)?\\s*$`, fnc: 'onSr' },
        { reg: `^\\s*#?${GAME_ALIAS.zzz}自动签到\\s*(?:开启|开|打开)?\\s*$`, fnc: 'onZzz' },
        // 立即签到
        { reg: `^\\s*#?${GAME_ALIAS.gs}签到\\s*$`, fnc: 'signGs' },
        { reg: `^\\s*#?${GAME_ALIAS.sr}签到\\s*$`, fnc: 'signSr' },
        { reg: `^\\s*#?${GAME_ALIAS.zzz}签到\\s*$`, fnc: 'signZzz' },
        // 手动过码（主动清风险；可带游戏名指定，默认原神）
        { reg: `^\\s*#?(?:${GAME_ALIAS.gs}|${GAME_ALIAS.sr}|${GAME_ALIAS.zzz})?(?:米游社验证|过码|手动过码)\\s*$`, fnc: 'manualVerify' },
        // 列表
        { reg: '^\\s*#?(?:自动)?签到(?:列表|状态|查询)\\s*$', fnc: 'listSubs' },
      ],
    })

    if (cfg.auto_sign_enable !== false) {
      this.task = {
        name: 'xhh-TL-米游社自动签到',
        cron,
        fnc: () => this.runAll(),
        log: false,
      }
    } else {
      this.task = { name: '', fnc: '', cron: '' }
    }
  }

  _disabled(e) {
    if (config().auto_sign_enable === false) {
      e.reply('自动签到功能已被管理员关闭~', true)
      return true
    }
    return false
  }

  // -------- 立即签到 --------
  async signGs(e) { return this._signNow(e, 'gs') }
  async signSr(e) { return this._signNow(e, 'sr') }
  async signZzz(e) { return this._signNow(e, 'zzz') }

  async _signNow(e, game) {
    if (this._disabled(e)) return true
    const label = GAME_LABEL[game]
    const results = await this.signUserGame(e, e.user_id, game, e)
    if (!results.length) {
      e.reply(`你还没有绑定${label}账号，请先【扫码绑定】米游社~`, true)
      return true
    }
    const lines = [`${label}签到结果：`]
    for (const r of results) lines.push(`· ${r.uid}：${r.msg}`)
    if (results.some((r) => r.code === 'captcha')) {
      lines.push(`（部分账号触发验证码，过码未成功；请稍后重发 #${label}签到，撞码时按提示点链接手动划过）`)
    }
    e.reply(lines.join('\n'), true)
    return true
  }

  // -------- 手动过码（主动清风险）--------
  // 不必等撞码，用户可主动跑一次过码清掉该设备风险分，之后签到更顺。
  // 从消息里识别游戏（默认原神）；对该游戏名下每个绑定 UID 逐个走过码。
  async manualVerify(e) {
    if (this._disabled(e)) return true
    const verifyAddr = config().auto_sign_verify_addr || ''
    if (!verifyAddr) {
      e.reply('未配置过码服务地址（auto_sign_verify_addr），无法手动过码~', true)
      return true
    }

    // 识别游戏：消息命中哪个别名就用哪个，默认 gs
    const msg = String(e.msg || '')
    let game = 'gs'
    for (const g of GAMES) {
      if (new RegExp(GAME_ALIAS[g]).test(msg)) { game = g; break }
    }
    const label = GAME_LABEL[game]

    // 枚举该游戏绑定 UID
    let uidList = []
    try {
      const user = await createUser(e.user_id, e)
      uidList = (user.getUidList(game) || []).map((x) => String(x.uid || x)).filter(Boolean)
    } catch (err) {
      logger?.error?.(`[xhh-TL][过码] 枚举 UID 失败 ${e.user_id}: ${err.message}`)
    }
    if (!uidList.length) {
      e.reply(`你还没有绑定${label}账号，请先【扫码绑定】米游社~`, true)
      return true
    }

    e.reply(`开始为${label} ${uidList.length} 个账号过码，撞到验证时请按提示点链接手划~`, true)

    const lines = [`${label}过码结果：`]
    for (const uid of uidList) {
      try {
        const authE = Object.assign(
          Object.create(Object.getPrototypeOf(e) || Object.prototype), e, { uid },
        )
        const auth = await resolveAuth(authE, { needCookie: true, game })
        if (!auth?.ck || !/cookie_token|account_id=/.test(auth.ck)) {
          lines.push(`· ${uid}：无有效登录，请重新扫码绑定`)
          continue
        }
        const realUid = auth.uid || uid
        // 取稳定 device_id + 真 device_fp，保证与签到同设备（清风险才有效）
        let device = ''
        let deviceFp = ''
        try {
          const api = new LiteMysApi(realUid, auth.ck, { game, log: false })
          device = api.device
          const fpRes = await api.getData('getFp', { seed_id: String(Date.now()).slice(0, 16), Getfp: true })
          deviceFp = fpRes?.data?.device_fp || ''
        } catch (_) {}

        const ok = await runBbsVerify(e, { uid: realUid, cookie: auth.ck, game, device, deviceFp, verifyAddr })
        lines.push(`· ${realUid}：${ok ? '过码成功，可去签到了' : '过码未成功（超时/取消/服务不可用）'}`)
      } catch (err) {
        logger?.error?.(`[xhh-TL][过码] ${e.user_id}/${uid} 异常: ${err.message}`)
        lines.push(`· ${uid}：过码异常`)
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    lines.push(`过码后发 #${label}签到 即可`)
    e.reply(lines.join('\n'), true)
    return true
  }

  // -------- 开启订阅 --------
  async onGs(e) { return this._on(e, 'gs') }
  async onSr(e) { return this._on(e, 'sr') }
  async onZzz(e) { return this._on(e, 'zzz') }

  async _on(e, game) {
    if (this._disabled(e)) return true
    const label = GAME_LABEL[game]

    // 校验：必须真能取到该游戏至少一个绑定 UID
    let uidList = []
    try {
      const user = await createUser(e.user_id, e)
      uidList = (user.getUidList(game) || []).map((x) => String(x.uid || x)).filter(Boolean)
    } catch (err) {
      logger?.error?.(`[xhh-TL][自动签到] 枚举 UID 失败 ${e.user_id}: ${err.message}`)
    }
    if (!uidList.length) {
      e.reply(`你还没有绑定${label}账号，请先【扫码绑定】米游社后再开启自动签到~`, true)
      return true
    }

    const subs = loadSubs()
    subs[game][String(e.user_id)] = { group: e.isGroup ? String(e.group_id) : '' }
    saveSubs(subs)
    e.reply(
      `✅ 已开启${label}每日自动签到（名下 ${uidList.length} 个 UID）\n每天将自动签到，签到结果${e.isGroup ? '在本群' : '私聊'}回报\n发送 #${label}签到 可立即签一次`,
      true,
    )
    return true
  }

  // -------- 关闭订阅 --------
  async offGs(e) { return this._off(e, 'gs') }
  async offSr(e) { return this._off(e, 'sr') }
  async offZzz(e) { return this._off(e, 'zzz') }

  async _off(e, game) {
    const label = GAME_LABEL[game]
    const subs = loadSubs()
    const qq = String(e.user_id)
    if (subs[game][qq]) {
      delete subs[game][qq]
      saveSubs(subs)
      e.reply(`已关闭${label}自动签到`, true)
    } else {
      e.reply(`你还没有开启${label}自动签到`, true)
    }
    return true
  }

  // -------- 列表 --------
  async listSubs(e) {
    const subs = loadSubs()
    const qq = String(e.user_id)
    const lines = ['📋 你的自动签到订阅：']
    let has = false
    for (const game of GAMES) {
      if (subs[game][qq]) {
        has = true
        const g = subs[game][qq].group
        lines.push(`· ${GAME_LABEL[game]}：已开启${g ? `（群 ${g} 回报）` : '（私聊回报）'}`)
      }
    }
    if (!has) lines.push('（暂无，发送 #原神自动签到 试试）')
    e.reply(lines.join('\n'), true)
    return true
  }

  /**
   * 对某 QQ 某游戏名下全部绑定 UID 逐个签到。
   * @returns {Promise<Array<{uid,code,msg,game}>>}
   */
  async signUserGame(e, qq, game, realE = null) {
    const results = []
    let user
    try {
      user = await createUser(qq, realE || e)
    } catch (err) {
      logger?.error?.(`[xhh-TL][自动签到] createUser 失败 ${qq}: ${err.message}`)
      return results
    }
    // 只对「有 ck 的 UID」签到：ck 属主(ltuid)绑定的 UID 才带 ltuid；
    // 注册/redis 来源的 UID 没有 ck，签到必然 -10002，直接过滤掉不进结果
    const uidList = (user.getUidList(game) || [])
      .filter((x) => x && typeof x === 'object' && x.ltuid)
      .map((x) => String(x.uid))
      .filter(Boolean)
    if (!uidList.length) return results

    for (const uid of uidList) {
      try {
        // 为每个 uid 构造带该 uid 的 e，让 resolveAuth 精确取该账号完整 cookie
        const authE = realE
          ? Object.assign(Object.create(Object.getPrototypeOf(realE) || Object.prototype), realE, { uid })
          : { user_id: qq, self_id: e?.self_id, message: [], msg: String(uid), uid }
        const auth = await resolveAuth(authE, { needCookie: true, game })
        if (!auth?.ck || !/cookie_token|account_id=/.test(auth.ck)) {
          results.push({ uid, code: 'expired', msg: `${GAME_LABEL[game]} 无有效登录，请重新扫码绑定`, game })
          continue
        }
        // 手动签到(realE 为真实事件)且配了打码地址时，撞码可当场过码重试；
        // 自动 cron(realE=null)无人手划，不传 e，撞码只跳过
        const opts = realE
          ? { e: realE, verifyAddr: config().auto_sign_verify_addr || '' }
          : {}
        const r = await signOne(auth.uid || uid, auth.ck, game, opts)
        results.push(r)
      } catch (err) {
        logger?.error?.(`[xhh-TL][自动签到] ${qq}/${uid} 签到异常: ${err.message}`)
        results.push({ uid, code: 'fail', msg: `${GAME_LABEL[game]} 签到异常`, game })
      }
      // 账号间轻微间隔，降低风控
      await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 700)))
    }
    // 兜底：resolved ck 若仍不属主(-10002)，同样过滤掉不进结果
    return results.filter((r) => r.code !== 'no_role')
  }

  // ============ 定时全量签到 ============
  async runAll() {
    const cfg = config()
    if (cfg.auto_sign_enable === false) return
    const subs = loadSubs()

    for (const game of GAMES) {
      for (const qq of Object.keys(subs[game])) {
        const sub = subs[game][qq]
        if (!sub) continue
        try {
          const fakeE = this.makeFakeE(qq, sub.group)
          const results = await this.signUserGame(fakeE, qq, game, null)
          if (!results.length) continue
          await this.report(qq, sub.group, game, results)
        } catch (err) {
          logger?.error?.(`[xhh-TL][自动签到] ${GAME_LABEL[game]} ${qq} 定时签到失败: ${err.message}`)
        }
        // 用户间间隔
        await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 1500)))
      }
    }
  }

  /** 回报签到结果：有群则群里@，否则私聊 */
  async report(qq, groupId, game, results) {
    const label = GAME_LABEL[game]
    const lines = results.map((r) => `· ${r.uid}：${r.msg}`)
    // 撞验证码：自动 cron 无人手划，无法当场过码，引导用户手动重签（重签时会触发内置过码）
    if (results.some((r) => r.code === 'captcha')) {
      lines.push('（部分账号触发验证码，自动签失败；请手动发送 #' + label + '签到，撞码时按提示点链接手动划过）')
    }
    const text = `${label}自动签到结果：\n${lines.join('\n')}`
    try {
      if (groupId) {
        const group = Bot.pickGroup(Number(groupId))
        await group.sendMsg([segment.at(Number(qq)), ` ${text}`])
      } else {
        const friend = Bot.pickFriend(Number(qq))
        await friend.sendMsg(text)
      }
      logger?.mark?.(`[xhh-TL][自动签到] 已回报 ${label} 给 ${qq}`)
    } catch (err) {
      logger?.error?.(`[xhh-TL][自动签到] 回报失败 ${qq}: ${err.message}`)
    }
  }

  /** 构造假 e，供定时场景 resolveAuth/createUser 复用 */
  makeFakeE(qq, groupId) {
    const bot = Bot
    let group = null
    if (groupId) {
      try { group = bot.pickGroup?.(Number(groupId)) } catch (_) {}
    }
    return {
      user_id: qq,
      self_id: bot?.uin,
      isGroup: !!groupId,
      group_id: groupId || undefined,
      group,
      message: [],
      msg: '',
      reply: () => {},
      sender: { nickname: String(qq) },
    }
  }
}

export default autoSign
