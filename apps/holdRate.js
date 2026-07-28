/**
 * 原神 #角色持有率
 * 展示各角色在深渊参与者中的持有率（own_rate），改用体力插件（毛玻璃）风格渲染。
 *
 * 数据源：提瓦特小助手 api.yshelper.com/getAbyssRank.php（has_list.own_rate）。
 * 该持有率为「参与本期深渊统计的玩家」中的持有比例，样本量最大、最具代表性。
 * 按星级（5★ / 4★）分组，组内按持有率降序。
 * 绑定 CK 后：高亮你已持有的角色，未持有半透明显示。
 *
 * 命令：#角色持有率 / #持有率 / #角色拥有率
 * 支持 @某人：用被 @ 的人的账号来标记持有。
 */

import moment from 'moment'
import lodash from 'lodash'
import path from 'path'
import { Character, MysApi, Player } from '../../miao-plugin/models/index.js'
import { prepareMysContext } from '../utils/runtimePatch.js'
import { config, getRenderScaleStyle, pluginDir, toFileUrl, pickRoleCombatBgImage } from '../utils/pluginConfig.js'
import { extractRenderBuffer } from '../utils/renderImage.js'
import { replyProgress, replyQuote } from '../utils/replyHelper.js'
import { getAbyssRank, pickHasList } from '../utils/yshelperApi.js'

const miaoRes = process.cwd() + '/plugins/miao-plugin/resources'

/** 解析被 @ 的 QQ（排除 bot 自身） */
function resolveTargetQq(e) {
  const selfId = String(e.self_id || e.bot?.uin || (typeof Bot !== 'undefined' ? Bot.uin : '') || '')
  if (e?.at && String(e.at) !== selfId) return String(e.at)
  for (const msg of e?.message || []) {
    if (msg?.type === 'at' && String(msg.qq) !== selfId) return String(msg.qq)
  }
  return ''
}

/** 取群昵称 / 名片 */
async function resolveDisplayName(e, qq) {
  const id = String(qq || '')
  if (!id) return ''
  let name = ''
  try {
    if (e.isGroup || e.group) {
      const member = e.group?.pickMember?.(id) || e.group?.pickMember?.(Number(id))
      if (member?.card || member?.nickname) name = member.card || member.nickname
      if (!name) {
        const bot = e.bot || (typeof Bot !== 'undefined' ? Bot : null)
        let info = null
        if (bot?.getGroupMemberInfo) {
          info = await bot.getGroupMemberInfo(String(e.group_id), id)
        } else if (bot?.sendApi) {
          const res = await bot.sendApi('get_group_member_info', {
            group_id: String(e.group_id),
            user_id: id,
          })
          info = res?.data || res
        }
        if (info?.card || info?.nickname) name = info.card || info.nickname
      }
    }
  } catch (_) {}
  if (!name) {
    const s = e.sender || {}
    if (String(e.user_id) === id) {
      name = (s.card && String(s.card).length < 20 ? s.card : '') || s.nickname || id
    } else {
      name = id
    }
  }
  return String(name)
}

function faceUrl(face) {
  if (!face) return ''
  if (/^https?:\/\//i.test(face) || face.startsWith('file://') || face.startsWith('base64://')) return face
  const rel = String(face).replace(/^[/\\]+/, '')
  return toFileUrl(path.join(miaoRes, rel))
}

/**
 * 把 has_list 整理成按星级分组的持有率列表。
 * ownedIds：本人持有的角色 id 集合（无 CK 时为空）。
 * 返回 { groups:[{star, rate, avg, chars:[...]}], total, hasCk }
 */
function buildGroups(data, ownedIds) {
  const hasList = pickHasList(data)
  const rows = []
  for (const ds of hasList) {
    const char = Character.get(ds.name)
    if (!char) continue
    const rate = Number(ds.own_rate)
    if (!Number.isFinite(rate)) continue
    const star = ds.star || char.star || 4
    rows.push({
      id: String(char.id),
      name: char.name || ds.name,
      star,
      rate,
      face: faceUrl(char.face),
      owned: ownedIds.has(String(char.id)),
    })
  }
  if (!rows.length) return null

  const groups = []
  for (const star of [5, 4]) {
    const chars = rows
      .filter((r) => r.star === star)
      .sort((a, b) => b.rate - a.rate)
      .map((r) => ({ ...r, rateText: r.rate.toFixed(1) }))
    if (!chars.length) continue
    groups.push({
      star,
      count: chars.length,
      chars,
    })
  }
  return { groups, total: rows.length }
}

function pickBgImage() {
  const gsNames = new Set()
  try {
    Character.forEach((char) => {
      if (char?.game === 'gs' && char.name) gsNames.add(char.name)
      return true
    }, 'release', 'gs')
  } catch (_) {}
  return pickRoleCombatBgImage({
    logTag: 'xhh-TL/holdRate',
    filterDir: gsNames.size ? (name) => gsNames.has(name) : null,
  })
}

export class holdRate extends plugin {
  constructor() {
    super({
      name: '[小花火]原神角色持有率',
      dsc: '原神角色持有率（提瓦特小助手深渊统计）',
      event: 'message',
      priority: config().hold_rate_priority ?? -98,
      rule: [
        {
          reg: '^\\s*#?角色(持有率|拥有率|持有|拥有)\\s*$',
          fnc: 'query',
        },
        {
          reg: '^\\s*#?持有率\\s*$',
          fnc: 'query',
        },
      ],
    })
  }

  async query(e) {
    if (config().hold_rate === false) return false

    const targetQq = resolveTargetQq(e)
    if (targetQq) e.at = targetQq

    await replyProgress(e, '正在获取角色持有率…')

    // 拉数据源
    let data
    try {
      data = await getAbyssRank()
    } catch (err) {
      logger.error('[xhh][holdRate] 数据源失败:', err)
      return e.reply('角色持有率数据获取失败，请稍后重试~')
    }

    // 取本人持有（有 CK 才能标记）
    const ownedIds = new Set()
    let hasCk = false
    try {
      await prepareMysContext(e, 'gs')
      const mys = await MysApi.init(e, 'cookie')
      if (mys && (await mys.checkCk())) {
        hasCk = true
        const player = Player.create(e)
        try {
          await player.refresh({ detail: 1 })
        } catch (_) {}
        const raw = player.getAvatarData() || {}
        if (Array.isArray(raw)) {
          for (const a of raw) if (a?.id) ownedIds.add(String(a.id))
        } else {
          for (const k of Object.keys(raw)) ownedIds.add(String(k))
        }
      }
    } catch (err) {
      logger.debug('[xhh][holdRate] 持有信息获取跳过:', err?.message)
    }

    const built = buildGroups(data, ownedIds)
    if (!built || !built.groups.length) {
      return e.reply('暂无可用的角色持有率数据，请稍后重试~')
    }

    // 本人已持有数量（仅统计榜单内角色）
    let ownedCount = 0
    if (hasCk) {
      for (const g of built.groups) for (const c of g.chars) if (c.owned) ownedCount++
    }

    const qq = targetQq || e.user_id || e.sender?.user_id || ''
    const qqname = await resolveDisplayName(e, qq)
    const bgImage = pickBgImage()
    const renderScale = getRenderScaleStyle(config(), 2.0)
    const cfg = config()
    const themeRaw = String(cfg.hold_rate_theme || cfg.gs_all_abyss_theme || 'light').toLowerCase()
    const theme = themeRaw === 'dark' ? 'dark' : 'light'
    const tplFile = pluginDir + '/resources/hold_rate/hold_rate.html'
    const ppath = '../../../../plugins/xhh-TL/resources/'

    const version = data.now_version || data.version || ''
    const renderData = {
      qq,
      qqname,
      bgImage,
      theme,
      version,
      hasCk,
      ownedCount,
      total: built.total,
      generatedAt: moment().format('MM-DD HH:mm'),
      lastUpdate: data.last_update || '',
      groups: built.groups,
    }

    try {
      const renderResult = await e.runtime.render('xhh-TL', 'hold_rate', renderData, {
        retType: 'base64',
        imgType: 'png',
        beforeRender({ data }) {
          return {
            ...data,
            imgType: 'png',
            sys: { scale: renderScale },
            ppath,
            tplFile,
            saveId: 'hold_rate',
          }
        },
      })
      const image = extractRenderBuffer(renderResult)
      if (!image) throw new Error('渲染结果中没有图片数据')
      return replyQuote(e, segment.image(image))
    } catch (err) {
      logger.error('[xhh][holdRate] 渲染失败:', err)
      return e.reply(`渲染失败：${err.message || err}`)
    }
  }
}
