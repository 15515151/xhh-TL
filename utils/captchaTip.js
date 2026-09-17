/**
 * 米游社撞验证码的提示文案。
 *
 * 单独抽出来是因为有两个调用方、两种排版：
 *   - apps/captchaNotice.js：Handler 提醒，单条消息，自己带 UID 前缀
 *   - utils/signClient.js：签到结果按「· UID：消息」逐行列，不能再带 UID
 * 所以这里只出「下一步发什么」，UID 由调用方决定加不加。
 *
 * 文案只写做什么，不解释为什么。
 */

/** 过码指令按游戏带前缀；原神是默认值，不带前缀 */
const GAME_CMD = { gs: '#过码', sr: '#星铁过码', zzz: '#绝区零过码' }

/**
 * 撞码提示（**尚未过码**时用）——此时确实要用户自己点链接手划。
 *
 * ⚠️ 已经过过码的场景不要用这条：那件事刚做完，再让用户手划是重复劳动，
 *    改说「重发本条即可」（见 signClient.js / captchaNotice.js 的 blockedOnly）。
 *
 * @param {string} [game] gs / sr / zzz
 * @returns {string} 撞码提示（不含 UID）
 */
export function captchaTip(game = 'gs') {
  const cmd = GAME_CMD[game] || GAME_CMD.gs
  return `米游社要验证码啦，发 ${cmd} 点链接手划一下`
}

export { GAME_CMD }
