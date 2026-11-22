# coding: utf-8
"""P1 反向验证 ②：把 unmanaged 的主检出排除改回旧写法（repoKeyOf 比较），
应出现「每条记录旁多一个假 unmanaged 条目」。

用法：python .deva/qa/revert-p1-unmanaged.py <apply|undo>
"""
import io
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LIST = 'apps/desktop/src/main/services/worktree/list.ts'

OLD = """      if (primaryKey !== null && key === primaryKey) continue"""
BROKEN = """      // [反向验证] 退回旧写法：用 repoKeyOf（sha1 摘要）比路径键，永不相等 → 主检出混进 unmanaged
      if (primaryKey !== null && repoKeyOf(state.repoRoot) === key) continue"""

action = sys.argv[1]
path = os.path.join(REPO, LIST)
if action == 'apply':
    src = io.open(path, encoding='utf-8').read()
    if OLD not in src:
        print('NOT_FOUND')
        sys.exit(3)
    io.open(path, 'w', encoding='utf-8').write(src.replace(OLD, BROKEN, 1))
    print('REVERTED unmanaged')
else:
    subprocess.check_call(['git', 'checkout', '--', LIST], cwd=REPO)
    out = subprocess.check_output(['git', 'diff', '--stat', '--', LIST], cwd=REPO, text=True)
    print('RESTORED diff -> ' + (out.strip() or '(empty)'))