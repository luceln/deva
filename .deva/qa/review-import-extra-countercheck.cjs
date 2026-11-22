// Every write/fault is restricted to a freshly created temporary fixture directory.
const fs=require('fs'),os=require('os'),path=require('path'),esbuild=require('esbuild');
const repo=process.cwd(),root=fs.mkdtempSync(path.join(os.tmpdir(),'deva-review-extra-'));
const built=esbuild.buildSync({stdin:{contents:`
export * as config from './apps/desktop/src/main/services/config';
export * as store from './apps/desktop/src/main/services/chat-store';
export {mergeProviders} from './apps/desktop/src/main/importer-config';
export {importSessions} from './apps/desktop/src/main/importer-sessions';
`,loader:'ts',resolveDir:repo},bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent',alias:{electron:path.join(repo,'.deva/qa/stub-electron.cjs')}}).outputFiles[0].text;
function fixture(name){
 const base=path.join(root,name),dst=path.join(base,'target'),src=path.join(base,'source');
 for(const d of [dst,src,path.join(base,'appdata')])fs.mkdirSync(d,{recursive:true});
 process.env.DEVA_HOME=dst;process.env.TEST_HOME=base;process.env.TEST_APPDATA=path.join(base,'appdata');
 const m={exports:{}};new Function('require','module','exports',built)(require,m,m.exports);
 return {dst,src,...m.exports};
}
const msg=content=>({role:'user',content});
// Main JSON diverges; source and target share the old imported compacted filename.
{
 const f=fixture('skipped-history'),file='diverged.compacted-original.jsonl';
 const dst=path.join(f.dst,'data','chats'),src=path.join(f.src,'data','chats');
 for(const d of [dst,src])fs.mkdirSync(d,{recursive:true});
 const target={id:'diverged',title:'local',createdAt:1,updatedAt:2,messages:[msg('local recent')],compacted:{count:2,file}};
 const source={...target,title:'source',messages:[msg('source recent')],compacted:{count:1,file}};
 const json=path.join(dst,'diverged.json');
 fs.writeFileSync(json,JSON.stringify(target));fs.writeFileSync(path.join(src,'diverged.json'),JSON.stringify(source));
 fs.writeFileSync(path.join(dst,file),[msg('shared early'),msg('LOCAL APPENDED EARLY')].map(JSON.stringify).join('\n')+'\n');
 fs.writeFileSync(path.join(src,file),JSON.stringify(msg('shared early'))+'\n');
 const before=fs.readFileSync(json,'utf8'),r=f.importSessions(f.src);
 console.log('history skipped='+JSON.stringify(r.skipped)+' copiedCompacted='+JSON.stringify(r.compacted)+' failed='+JSON.stringify(r.failed));
 console.log('history mainJSON unchanged='+(before===fs.readFileSync(json,'utf8'))+' pointer.count='+JSON.parse(fs.readFileSync(json)).compacted.count+' actual lines='+fs.readFileSync(path.join(dst,file),'utf8').trim().split('\n').length);
 console.log('history loaded messages='+JSON.stringify(f.store.getSession('diverged').messages.map(x=>x.content)));
 console.log('history backup present='+fs.readdirSync(dst).some(n=>n.includes('.bad-')));
}
for(const mode of ['corrupt','unreadable-once']){
 const f=fixture(mode),file=path.join(f.dst,'config.json');
 const raw=mode==='corrupt'?'{'+'"userPreferences":{"keep":"LOCAL IMPORTANT"},"models":':JSON.stringify({userPreferences:{keep:'LOCAL IMPORTANT'},models:{providers:[{id:'local-only',models:[]}]}});
 fs.writeFileSync(file,raw);fs.writeFileSync(path.join(f.src,'config.json'),JSON.stringify({models:{providers:[{id:'source-custom',kind:'custom',models:[{id:'m'}]}]}}));
 const read=fs.readFileSync;
 if(mode==='unreadable-once')fs.readFileSync=function(p,...args){if(path.resolve(String(p))===path.resolve(file)){const e=Error('isolated fixture EACCES');e.code='EACCES';throw e;}return read.call(fs,p,...args);};
 let kind;try{kind=f.config.getConfigLoadKind();}finally{fs.readFileSync=read;}
 const r=f.mergeProviders(f.src),after=fs.readFileSync(file,'utf8');
 console.log(mode+' initialKind='+kind+' copied='+JSON.stringify(r.copied)+' failures='+JSON.stringify(r.failed||[])+' originalPreserved='+(raw===after)+' localPreferencesPreserved='+after.includes('LOCAL IMPORTANT')+' targetFiles='+JSON.stringify(fs.readdirSync(f.dst)));
}
console.log('fixture root='+root);
