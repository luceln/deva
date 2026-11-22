# coding: utf-8
"""P1 反向验证：把 projectMemoryRootOf 改成恒返回入参（bug 版），A35 断言应红。

用法：python .deva/qa/revert-p1-a35.py <apply|undo>
"""
import io
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCOPE = 'apps/desktop/src/main/services/worktree/scope.ts'

OLD = """export function projectMemoryRootOf(root: string | null): string | null {
  if (!root) return null
  let rec
  try {"""
BROKEN = """export function projectMemoryRootOf(root: string | null): string | null {
  // [反向验证] 恒返回入参：等价于「没有共享记忆」的 bug 版
  return root
  if (!root) return null
  let rec
  try {"""

action = sys.argv[1]
path = os.path.join(REPO, SCOPE)
if action == 'apply':
    src = io.open(path, encoding='utf-8').read()
    if OLD not in src:
        print('NOT_FOUND')
        sys.exit(3)
    io.open(path, 'w', encoding='utf-8').write(src.replace(OLD, BROKEN, 1))
    print('REVERTED a35')
else:
    subprocess.check_call(['git', 'checkout', '--', SCOPE], cwd=REPO)
    out = subprocess.check_output(['git', 'diff', '--stat', '--', SCOPE], cwd=REPO, text=True)
    print('RESTORED diff -> ' + (out.strip() or '(empty)'))