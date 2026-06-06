#!/bin/sh
# 编辑任意 .ts 后跑项目 typecheck;失败则把 tsc 输出回喂给 Claude(exit 2)。
fp=$(node -e 'try{process.stdout.write((JSON.parse(require("fs").readFileSync(0,"utf8")).tool_input||{}).file_path||"")}catch{}')
case "$fp" in
  *.ts)
    cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0
    if ! out=$(npm run -s typecheck 2>&1); then
      printf 'Type check failed after editing %s:\n%s\n' "$fp" "$out" >&2
      exit 2
    fi
    ;;
esac
exit 0
