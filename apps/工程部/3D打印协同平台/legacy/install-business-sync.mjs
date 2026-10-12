import {readFileSync,writeFileSync,copyFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const target=process.argv[2];if(!target)throw Error('用法：node legacy/install-business-sync.mjs 原3d-server目录（先停止原服务）');
const file=path.resolve(target,'server.js'),raw=readFileSync(file,'utf8'),nl=raw.includes('\r\n')?'\r\n':'\n';
const anchor='  } else if (!requireAuth(req, res)) return;';
const marker='// PRINTLINK_BUSINESS_SYNC_V1';
if(!raw.includes(marker)&&raw.split(anchor).length!==2)throw Error('原 server.js 版本不匹配，未修改任何文件');
for(const symbol of ['_syncEnabled','_role','DATA_FILE','function loadData()','function saveData(data)'])if(!raw.includes(symbol))throw Error('原 server.js 缺少适配接口：'+symbol+'；未修改文件');
const configPath=path.resolve(target,'config.json');const config=JSON.parse(readFileSync(configPath,'utf8'));
if(config.sync?.enabled||config.role==='slave')throw Error('请先停用旧主从同步；不能同时运行两套同步');
const backup=file+'.before-business-sync';if(!existsSync(backup))copyFileSync(file,backup);
copyFileSync(path.join(here,'business-sync-adapter.cjs'),path.resolve(target,'business-sync-adapter.cjs'));
copyFileSync(path.join(here,'../shared/business-sync.cjs'),path.resolve(target,'business-sync-core.cjs'));
if(!raw.includes(marker)){
 const hook=`${anchor}\n  ${marker}\n  if(req.url==='/api/business-sync'){\n    require('./business-sync-adapter.cjs')(req,res,{load:loadData,save:saveData,readDisk:()=>JSON.parse(fs.readFileSync(DATA_FILE,'utf8')),enabled:_config.businessSync===true&&!_syncEnabled&&_role!=='slave'});return;\n  }`;
 writeFileSync(file,raw.replace(anchor,hook.replaceAll('\n',nl)));
}
console.log('适配器已安装；未修改业务资料或配置。请在原 config.json 与桥接配置中设置 businessSync: true，再启动服务。备份：'+backup);
