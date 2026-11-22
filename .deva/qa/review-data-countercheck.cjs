// Read-only to production/user data. All fixture writes stay in a fresh os.tmpdir.
const fs = require('fs'); const os = require('os'); const path = require('path');
const esbuild = require('esbuild');
const repo = process.cwd();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deva-review-counter-'));
const target = path.join(root, 'target'), source = path.join(root, 'source');
for (const dir of [target, source, path.join(root, 'appdata')]) fs.mkdirSync(dir, {recursive:true});
process.env.DEVA_HOME=target;
process.env.TEST_HOME=root; process.env.TEST_APPDATA=path.join(root, 'appdata');
const output = esbuild.buildSync({stdin:{contents:`
  export * as store from './apps/desktop/src/main/services/chat-store';
  export { importSessions } from './apps/desktop/src/main/importer-sessions';
`,resolveDir:repo,sourcefile:'countercheck-entry.ts',loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,
 alias:{electron:path.join(repo,'.deva/qa/stub-electron.cjs')},logLevel:'silent'});
const moduleBox={exports:{}};
new Function('require','module','exports',output.outputFiles[0].text)(require,moduleBox,moduleBox.exports);
const {store,importSessions}=moduleBox.exports;
const dst=path.join(target,'data','chats'),src=path.join(source,'data','chats');
for(const d of [dst,src]) fs.mkdirSync(d,{recursive:true});
const msg=content=>({role:'user',content});
const record=(id,messages,more={})=>({id,title:id,createdAt:1,updatedAt:2,messages,...more});
const put=(dir,id,s)=>fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify(s));
const disk=id=>JSON.parse(fs.readFileSync(path.join(dst,id+'.json'),'utf8'));

// #1: production load, production import, exact production finalizer, production save.
put(dst,'cachecase',record('cachecase',[msg('before')]));
put(src,'cachecase',record('cachecase',[msg('before'),msg('source appended')]));
store.getSession('cachecase');
const r1=importSessions(source); store.invalidateIndexOnly();
console.log('#1 report.updated='+JSON.stringify(r1.updated));
console.log('#1 disk after import='+disk('cachecase').messages.length+' cache='+store.getSession('cachecase').messages.length);
console.log('#1 subsequent save='+store.save('cachecase')+' disk messages='+disk('cachecase').messages.length);

// #2: different early histories, same live prefix; no preloaded cache at import time.
const localFile='historycase.compacted-local.jsonl',upstreamFile='historycase.compacted-source.jsonl';
put(dst,'historycase',record('historycase',[msg('same recent')],{compacted:{count:1,file:localFile},title:'local title',model:'local:model'}));
put(src,'historycase',record('historycase',[msg('same recent'),msg('source appended')],{compacted:{count:1,file:upstreamFile},title:'source title',model:'source:model'}));
fs.writeFileSync(path.join(dst,localFile),JSON.stringify(msg('LOCAL ONLY EARLY HISTORY'))+'\n');
fs.writeFileSync(path.join(src,upstreamFile),JSON.stringify(msg('SOURCE DIFFERENT EARLY HISTORY'))+'\n');
const r2=importSessions(source); store.invalidateIndexOnly();
const loaded=store.getSession('historycase');
console.log('#2 report.updated='+JSON.stringify(r2.updated));
console.log('#2 loaded full history='+JSON.stringify(loaded.messages.map(x=>x.content)));
console.log('#2 old local history file still exists='+fs.existsSync(path.join(dst,localFile)));
console.log('#2 disk title/model='+disk('historycase').title+'/'+disk('historycase').model);

// #6a: only the disposable fixture's index path is blocked. Session file remains writable.
const ix=path.join(dst,'_index.json');
store.listSessions();
if(fs.existsSync(ix)) fs.unlinkSync(ix);
fs.mkdirSync(ix);
const s=store.getSession('cachecase');
const old=s.model; s.model='new:model';
const wrote=store.save('cachecase');
if(!wrote) s.model=old; // exact caller behavior in model-swap.ts
console.log('#6a save returned='+wrote+' disk model='+disk('cachecase').model+' cached model='+String(store.getSession('cachecase').model));
console.log('fixture root='+root);
// Deliberately retain this dedicated fixture for inspection; never remove any user path.
