#!/bin/bash
cd ~/deva-linux || exit 1
export PATH="$HOME/.local/node/node-v22.14.0-linux-x64/bin:$PATH"
node .deva/qa/driver.cjs wtlock 2>&1 | grep -E '^(PASS|FAIL)|汇总|pass=|大小写|尾斜杠'
