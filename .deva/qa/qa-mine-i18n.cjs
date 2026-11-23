/** 验收者自建：核对 BackupPane 用到的 i18n key 在 fork.ts 各语言段是否齐全。 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const pane = fs.readFileSync(
  path.join(ROOT, 'apps/desktop/src/renderer/src/redesign/BackupPane.tsx'), 'utf8'
)
const keys = [...new Set([...pane.matchAll(/t\('cf\.backup\.([^']+)'\)/g)].map((m) => m[1]))]
console.log(`BackupPane 用到 ${keys.length} 个 cf.backup.* key`)

const lines = fs.readFileSync(
  path.join(ROOT, 'apps/desktop/src/renderer/src/i18n/fork.ts'), 'utf8'
).split('\n')

let lang = '?'
const blocks = []
for (let i = 0; i < lines.length; i++) {
  const langM = /^export const (\w+) = \{\r?$/.exec(lines[i])
  if (langM) lang = langM[1]
  if (/^    backup: \{\r?$/.test(lines[i])) {
    let depth = 0
    const body = []
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') depth++
        else if (ch === '}') depth--
      }
      body.push(lines[j])
      if (depth === 0 && j > i) break
    }
    blocks.push({ lang, at: i + 1, text: body.join('\n') })
  }
}

console.log(`找到 ${blocks.length} 个 backup 段: ${blocks.map((b) => `${b.lang}@${b.at}`).join(', ')}`)
if (blocks.length === 0) {
  console.log('FAIL 一个 backup 段都没找到 —— 脚本本身有问题，不能算通过')
  process.exitCode = 1
} else {
  let bad = 0
  for (const b of blocks) {
    const missing = keys.filter((k) => {
      const re = new RegExp(`^      ${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`, 'm')
      return !re.test(b.text)
    })
    if (missing.length) {
      bad++
      console.log(`FAIL ${b.lang} 缺 ${missing.length}/${keys.length}: ${missing.join(', ')}`)
    } else {
      console.log(`PASS ${b.lang} 齐全 ${keys.length}/${keys.length}`)
    }
  }
  // 反向自检：故意查一个不存在的 key，确认脚本会报缺（避免假绿）
  const ghost = 'definitely-not-a-key-xyz'
  const re = new RegExp(`^      ${ghost}:`, 'm')
  const ghostFound = blocks.some((b) => re.test(b.text))
  console.log(ghostFound ? 'FAIL 反向自检失败：脚本连不存在的 key 也认' : 'PASS 反向自检：不存在的 key 会被判定为缺')
  console.log(bad ? `\n==RESULT== ${bad} 个语言段缺词条` : '\n==RESULT== 所有语言段都齐全')
  process.exitCode = bad || ghostFound ? 1 : 0
}
