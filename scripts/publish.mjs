// 一条命令发版：npm run release
// 前提：先把 package.json 的 version 改好、git 提交并 push，然后带 GH_TOKEN 跑这个脚本。
// 它会 npm pack 出新包，再把这个包挂到 GitHub Release（tag = v<version>），已存在就复用。
//
// 用法（Windows / PowerShell）：
//   $env:GH_TOKEN = "ghp_xxx"      # 只需 repo 权限的经典令牌，或 fine-grained 的 Contents: Read and write
//   npm run release

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''))
const REPO = (pkg.repository?.url ?? pkg.repository ?? '').replace(/^git\+/, '').replace(/\.git$/, '').replace(/^https:\/\/github\.com\//, '')
const VERSION = pkg.version
const TAG = 'v' + VERSION
const TOKEN = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOK ?? ''

if (!REPO.includes('/')) throw new Error('package.json 的 repository 必须是 github 仓库')
if (!TOKEN) throw new Error('先设 GH_TOKEN（需要 Contents: Read and write）')

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

// 1) 打包（npm 的全局缓存目录偶尔被占用，用临时缓存躲开）
const tgzName = `${pkg.name}-${VERSION}.tgz`
const tgz = join(root, tgzName)
if (!existsSync(tgz)) {
  const cache = mkdtempSync(join(tmpdir(), 'npm-pack-cache-'))
  try {
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--cache', cache], { cwd: root, stdio: 'inherit' })
  } finally {
    rmSync(cache, { recursive: true, force: true })
  }
}
if (!existsSync(tgz)) throw new Error('没打出 ' + tgzName)
console.log(`包：${tgzName}（${readFileSync(tgz).length} B）`)

const H = {
  authorization: 'Bearer ' + TOKEN,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'dsh-release',
}
const api = async (path, init = {}) => {
  const res = await fetch('https://api.github.com' + path, { ...init, headers: { ...H, ...(init.headers ?? {}) } })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, json }
}

// 2) release：有就复用，没有就建
const body = `见 [SUBMIT.md](https://github.com/${REPO}/blob/main/SUBMIT.md) 的「变更」一节。\n\n发行包 \`${tgzName}\` 在本页 Assets 里。`
let rel = null
const found = await api(`/repos/${REPO}/releases/tags/${TAG}`)
if (found.status === 200) {
  rel = found.json
  console.log('release 已存在：' + rel.html_url)
} else {
  const created = await api(`/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tag_name: TAG, target_commitish: 'main', name: TAG, body, draft: false, prerelease: false }),
  })
  if (created.status !== 201) throw new Error(`建 release 失败：${created.status} ${JSON.stringify(created.json)}`)
  rel = created.json
  console.log('release 已创建：' + rel.html_url)
}

// 3) 挂包
//    挂两份：带版本号的（钉 tag 用）和不带版本号的（releases/latest/download 用）。
//    市场条目（awesome-dsh-plugin）指向不带版本号的那份，否则下次发版就 404。
const assetNames = [tgzName, `${pkg.name}.tgz`]
const bytes = readFileSync(tgz)
const assets = await api(`/repos/${REPO}/releases/${rel.id}/assets`)
const have = new Set((Array.isArray(assets.json) ? assets.json : []).map((a) => a.name))
for (const name of assetNames) {
  if (have.has(name)) {
    console.log('资产已在：' + name)
    continue
  }
  const up = await fetch(`https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/gzip' },
    body: bytes,
  })
  const j = await up.json()
  if (j.state !== 'uploaded') throw new Error(`上传失败：${up.status} ${JSON.stringify(j)}`)
  console.log('资产已上传：' + j.name + ' ' + j.size + ' B')
}

console.log('下载直链（钉 tag）：' + `https://github.com/${REPO}/releases/download/${TAG}/${tgzName}`)
console.log('稳定直链（始终最新）：' + `https://github.com/${REPO}/releases/latest/download/${pkg.name}.tgz`)
