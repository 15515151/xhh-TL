/**
 * #过码部署 — 一键装好全自动过码服务
 *
 * 过码服务放在仓库的 solver 分支（依赖 xdotool/openbox/cv2，多数用户用不上，
 * 不塞进 master）。这个指令替用户把那几步做完：
 *   拉 service/ → 建 venv 装依赖 → pm2 起服务 → 写回配置
 *
 * 只做 Linux：服务靠 X11 + 系统级鼠标指针，Windows/macOS 没有等价物。
 */

import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import plugin from '../../../lib/plugins/plugin.js'
import { config, pluginDir, writeUserConfig } from '../utils/pluginConfig.js'
import { quoteEnabled } from '../utils/replyHelper.js'

const exec = promisify(execFile)
const SERVICE_DIR = path.join(pluginDir, 'service', 'geetest')
const PM2_NAME = 'geetest-solver'
const PORT = 8766

const log = {
  mark: (...a) => (typeof logger !== 'undefined' ? logger.mark(...a) : console.log(...a)),
  error: (...a) => (typeof logger !== 'undefined' ? logger.error(...a) : console.error(...a)),
}

/** 跑一条命令，返回 { ok, out }，不抛 */
async function run(cmd, args, opts = {}) {
  try {
    const { stdout, stderr } = await exec(cmd, args, { timeout: 300000, ...opts })
    return { ok: true, out: String(stdout || '') + String(stderr || '') }
  } catch (err) {
    return { ok: false, out: String(err?.stdout || '') + String(err?.stderr || '') + String(err?.message || '') }
  }
}

/** 服务是否已经在正常响应（探 /health，比看 pm2 状态更准） */
async function isServiceAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(4000) })
    return res.ok
  } catch (_) {
    return false
  }
}

async function has(cmd, args = ['--version']) {
  const r = await run(cmd, args)
  return r.ok
}

/** 逐个 remote 试 fetch solver，返回能用的那个 remote 名 */
async function fetchSolver() {
  // ★ 必须带 cwd：不带就跑到云崽根目录去了，那里的 remote 是宿主仓库的 origin，
  //   跟本插件没关系，会取不到 solver 分支
  const r = await run('git', ['remote'], { cwd: pluginDir })
  if (!r.ok) return { ok: false, msg: '取不到 git remote（这目录不是 git 仓库？）' }
  const remotes = r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (!remotes.length) return { ok: false, msg: '没有配置任何 git remote' }
  const tried = []
  for (const remote of remotes) {
    // ★ 显式写 refspec：用户多是 `git clone --depth=1`（浅克隆 + 单分支），
    //   这种仓库 `fetch <remote> solver` 只会写 FETCH_HEAD，**不会建出 <remote>/solver 引用**，
    //   后面按引用名检出就会失败。写上 refspec 才能把引用真正建出来。
    const refspec = `solver:refs/remotes/${remote}/solver`
    const f = await run('git', ['fetch', '--depth=1', remote, refspec], { cwd: pluginDir })
    if (f.ok) return { ok: true, remote }
    tried.push(remote)
  }
  return { ok: false, msg: `这些 remote 都取不到 solver 分支：${tried.join(', ')}` }
}

export class solverDeploy extends plugin {
  constructor() {
    super({
      name: '[小火花]过码服务部署',
      dsc: '一键部署米游社全自动过码服务',
      event: 'message',
      priority: 5000,
      rule: [
        {
          // # 必带：这条会真去拉服务、装依赖、起进程，不能让裸词在群里误触发
          reg: '^\\s*#(?:过码|验证码)(?:服务)?(?:部署|安装|一键部署)\\s*$',
          fnc: 'deploy',
          permission: 'master',
        },
        {
          reg: '^\\s*#(?:过码|验证码)服务(?:状态|查看)\\s*$',
          fnc: 'status',
          permission: 'master',
        },
      ],
    })
  }

  /** 前置检查：平台 + 系统依赖。返回缺失项数组 */
  async precheck() {
    const missing = []
    if (process.platform === 'win32') {
      missing.push({ name: 'Windows', fix: '本服务需要 X11 桌面环境与系统级鼠标，Windows 装不了' })
      return missing
    }
    for (const [cmd, pkg, args] of [
      ['xdotool', 'xdotool', ['-h']],
      ['Xvfb', 'xvfb', ['-help']],
      ['openbox', 'openbox', ['--version']],
      ['python3', 'python3-venv', ['--version']],
    ]) {
      if (!(await has(cmd, args))) {
        missing.push({ name: pkg, fix: `apt install -y ${pkg}` })
      }
    }
    if (!(await has('pm2', ['--version']))) {
      missing.push({ name: 'pm2', fix: 'npm i -g pm2' })
    }
    return missing
  }

  async deploy(e) {
    if (process.platform === 'win32') {
      await e.reply('过码服务只能在 Linux 上跑（需要桌面环境），Windows 用不了~', quoteEnabled())
      return true
    }

    // 首次要装 Python 依赖（慢），之后只是检查一下（快）
    const firstTime = !fs.existsSync(path.join(SERVICE_DIR, '.venv', 'bin', 'python'))
    await e.reply(
      firstTime ? '开始部署过码服务（首次要装依赖，可能要几分钟）~' : '检查过码服务中，稍等~',
      quoteEnabled(),
    )

    // ① 系统依赖
    const missing = await this.precheck()
    if (missing.length) {
      const lines = ['缺少这些依赖，请先在机器人所在设备执行：', '']
      for (const m of missing) lines.push(`· ${m.name}：${m.fix}`)
      lines.push('', '装完再发一次本指令')
      await e.reply(lines.join('\n'), quoteEnabled())
      return true
    }

    // ② 拉服务文件（检查全部必需文件，缺任何一个都要重新检出）
    const need = ['server.mjs', 'start.sh', 'gap.py', 'gt.js']
    const missingFiles = need.filter((f) => !fs.existsSync(path.join(SERVICE_DIR, f)))
    if (missingFiles.length) {
      log.mark(`[xhh-TL][部署] 缺少 ${missingFiles.join(', ')}，从 solver 分支检出`)
      const f = await fetchSolver()
      if (!f.ok) {
        await e.reply(`拉取服务失败：${f.msg}`, quoteEnabled())
        return true
      }
      // ★ 用 restore 而不是 checkout：`checkout <ref> -- service` 会把 service 写进暂存区，
      //   之后插件目录任何一次 commit 都会把服务代码带进 master（master 就是这么被污染的）。
      //   restore 只写工作区、不碰索引，service 才能老老实实待在 gitignore 里。
      //   先试引用名（fetch 已按 refspec 建出来），旧版 git 不支持 --source 就退回 checkout。
      let co = await run('git', ['restore', '--source', `${f.remote}/solver`, '--', 'service'], { cwd: pluginDir })
      if (!co.ok) {
        co = await run('git', ['checkout', `${f.remote}/solver`, '--', 'service'], { cwd: pluginDir })
        // checkout 会污染索引，立刻清掉，别让它跟着下次提交进 master
        if (co.ok) await run('git', ['reset', '-q', '--', 'service'], { cwd: pluginDir })
      }
      if (!co.ok || !fs.existsSync(path.join(SERVICE_DIR, 'server.mjs'))) {
        await e.reply('检出服务文件失败，请把插件目录更新到最新再试', quoteEnabled())
        return true
      }
    }

    // ③ Python 依赖（venv 里装 cv2，不动系统环境）
    const py = path.join(SERVICE_DIR, '.venv', 'bin', 'python')
    if (!fs.existsSync(py)) {
      const v = await run('python3', ['-m', 'venv', '.venv'], { cwd: SERVICE_DIR })
      if (!v.ok) {
        await e.reply('创建 Python 环境失败，请确认装了 python3-venv', quoteEnabled())
        return true
      }
    }
    // 依赖已在就跳过（pip install 要跑几十秒，没必要每次重来）
    const depOk = await run(path.join('.venv', 'bin', 'python'), ['-c', 'import cv2, numpy'])
    if (!depOk.ok) {
      const pip = await run(
        path.join('.venv', 'bin', 'pip'),
        ['install', '-q', 'opencv-python-headless', 'numpy'],
        { cwd: SERVICE_DIR },
      )
      if (!pip.ok) {
        await e.reply('安装识别依赖失败，请检查网络后重试', quoteEnabled())
        return true
      }
    }

    // ④ 起服务。已经在跑就别动它 —— 重启会打断正在进行的过码，
    //    也会让 start.sh 重复创建 Xvfb/openbox。
    const running = await isServiceAlive()
    if (!running) {
      await run('pm2', ['delete', PM2_NAME]) // 清掉残留的失败进程，避免端口占用
      const start = await run('pm2', ['start', 'start.sh', '--name', PM2_NAME, '--interpreter', 'bash'], {
        cwd: SERVICE_DIR,
      })
      if (!start.ok) {
        log.error('[xhh-TL][部署] pm2 启动失败:', start.out.slice(0, 300))
        await e.reply('启动服务失败，请检查 pm2 是否正常', quoteEnabled())
        return true
      }
    }

    // ⑤ 写回配置并持久化 pm2
    try {
      writeUserConfig({ auto_verify_addr: `http://127.0.0.1:${PORT}/solve` })
    } catch (err) {
      log.error('[xhh-TL][部署] 写配置失败:', err?.message)
    }
    await run('pm2', ['save'])

    // ⑥ 验活
    await new Promise((r) => setTimeout(r, 8000))
    const alive = await isServiceAlive()

    if (alive && running) {
      await e.reply('过码服务本来就在跑，配置已确认，不用再管~', quoteEnabled())
    } else if (alive) {
      await e.reply('过码服务装好了，撞码会自动处理，不用再管~', quoteEnabled())
    } else {
      await e.reply('服务已启动但没连上，请发 #过码服务状态 看看，或稍后再试', quoteEnabled())
    }
    return true
  }

  async status(e) {
    const lines = []
    // pm2 状态
    const r = await run('pm2', ['jlist'])
    let info = null
    try {
      const list = JSON.parse(r.out)
      info = list.find((p) => p.name === PM2_NAME)
    } catch (_) {}
    lines.push(info ? `服务进程：${info.pm2_env?.status || '未知'}` : '服务进程：未部署')

    // 健康检查
    let alive = false
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(5000) })
      alive = res.ok
    } catch (_) {}
    lines.push(`端口 ${PORT}：${alive ? '正常' : '连不上'}`)
    lines.push(`插件配置：${config().auto_verify_addr ? '已指向本机服务' : '未启用自动过码'}`)

    if (!alive && !info) lines.push('', '发 #过码部署 可以一键装好')
    else if (!alive) lines.push('', '发 #过码部署 重新装一次')

    await e.reply(lines.join('\n'), quoteEnabled())
    return true
  }
}

export { SERVICE_DIR, PM2_NAME, PORT }
