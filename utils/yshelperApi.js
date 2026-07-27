/**
 * 提瓦特小助手（yshelper）深渊统计数据源
 * 上游 miao-plugin fork 的 HutaoApi 已改用此接口，替代已下线的
 * lelaer /Statistics/Team/Combination。
 *
 * getAbyssRank 返回体量较大（~180KB），做 1 小时内存缓存。
 */

import fetch from 'node-fetch'

const ABYSS_RANK_URL =
  'https://api.yshelper.com/ys/getAbyssRank.php?star=all&role=all&lang=zh-Hans'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

let _cache = null
let _cacheAt = 0
const CACHE_MS = 60 * 60 * 1000

/** 拉取原神深渊统计（含使用率 has_list + 配队 result[3]） */
export async function getAbyssRank({ force = false } = {}) {
  if (!force && _cache && Date.now() - _cacheAt < CACHE_MS) return _cache
  const res = await fetch(ABYSS_RANK_URL, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`yshelper HTTP ${res.status}`)
  const data = await res.json()
  if (!data || !data.result || !Array.isArray(data.result)) {
    throw new Error('yshelper 返回结构异常')
  }
  _cache = data
  _cacheAt = Date.now()
  return data
}

/**
 * 从 result 数组中定位「配队组合」列表。
 * 该列表元素形如 { role: [{avatar,star}...], up_use_num, down_use_num, use_rate, has_rate, attend_rate }
 */
export function pickTeamList(data) {
  if (!data || !Array.isArray(data.result)) return null
  for (const list of data.result) {
    if (
      Array.isArray(list) &&
      list.length &&
      Array.isArray(list[0]?.role) &&
      list[0].role.length
    ) {
      return list
    }
  }
  return null
}

/** has_list：角色使用率明细，用于把 role.avatar(图片URL) 反查到角色 */
export function pickHasList(data) {
  return Array.isArray(data?.has_list) ? data.has_list : []
}
