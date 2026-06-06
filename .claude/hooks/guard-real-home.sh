#!/bin/sh
# 这个 CLI 的铁律是"绝不碰真实 ~/.persona、~/.claude"——把它延伸到开发期 Edit/Write。
# 只拦真实 $HOME 下的这两个目录;项目内的 .claude/(在 repo 路径下)不受影响。
node -e '
const fs=require("fs"),path=require("path"),os=require("os");
let j;try{j=JSON.parse(fs.readFileSync(0,"utf8"))}catch{process.exit(0)}
const ti=j.tool_input||{}, fp=ti.file_path||ti.path;
if(!fp)process.exit(0);
const abs=path.resolve(j.cwd||process.cwd(),fp), home=os.homedir();
const guarded=[path.join(home,".persona"),path.join(home,".claude")];
const hit=guarded.find(g=>abs===g||abs.startsWith(g+path.sep));
if(hit)console.log(JSON.stringify({hookSpecificOutput:{
  hookEventName:"PreToolUse",
  permissionDecision:"deny",
  permissionDecisionReason:`拒绝写入 ${abs}:这是你真实的 ${hit}。persona 测试纪律要求绝不触碰真实库/配置——请用临时 HOME 集成 harness(test/harness.ts)。`
}}));
'
