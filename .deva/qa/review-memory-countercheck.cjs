// Uses a controlled provider only in the test bundle; production sources are untouched.
const fs=require('fs'),os=require('os'),path=require('path'),esbuild=require('esbuild');
const repo=process.cwd(),root=fs.mkdtempSync(path.join(os.tmpdir(),'deva-review-memory-'));
process.env.DEVA_HOME=path.join(root,'target');process.env.TEST_HOME=root;process.env.TEST_APPDATA=path.join(root,'appdata');
fs.mkdirSync(process.env.DEVA_HOME,{recursive:true});fs.mkdirSync(process.env.TEST_APPDATA,{recursive:true});
(async()=>{
const output=await esbuild.build({stdin:{contents:`
export * as memory from './apps/desktop/src/main/services/memory';
export {condenseMemories} from './apps/desktop/src/main/services/memory-consolidate';
`,resolveDir:repo,loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent',alias:{electron:path.join(repo,'.deva/qa/stub-electron.cjs')},plugins:[{name:'controlled-provider',setup(build){build.onLoad({filter:/main[\\/]providers[\\/]index\.ts$/},()=>({loader:'ts',contents:`export async function* streamChat() {globalThis.__reviewEntered(); await globalThis.__reviewGate; yield {type:'text_delta',text:globalThis.__reviewText};yield {type:'done',stopReason:'end_turn'};}`}));}}]});
const m={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(require,m,m.exports);
const {memory,condenseMemories}=m.exports,scope={kind:'global'},model={adapter:'openai',providerId:'test',model:'test'};
async function check(mode){
 memory.clearMemories(scope);const seed=memory.writeMemory('旧偏好：使用方案甲',undefined,scope);if(!seed.ok)throw Error('fixture failed');
 let entered;const started=new Promise(r=>entered=r);let release;globalThis.__reviewGate=new Promise(r=>release=r);globalThis.__reviewEntered=entered;
 globalThis.__reviewText=JSON.stringify({entries:[{id:mode==='update'?seed.entry.id:null,content:'旧偏好整理后：方案甲'}]});
 const running=condenseMemories(scope,model);await started;
 if(mode==='update')console.log('user update ok='+memory.writeMemory('用户刚纠正：改用方案乙',seed.entry.id,scope).ok);
 else console.log('user delete written='+memory.deleteMemory(seed.entry.id,scope).written);
 release();const result=await running;
 console.log(mode+' condense ok='+result.ok+' final='+JSON.stringify(memory.listMemories(scope).map(e=>e.content)));
}
await check('update');await check('delete');console.log('fixture root='+root);
})().catch(e=>{console.error(e);process.exitCode=1;});
