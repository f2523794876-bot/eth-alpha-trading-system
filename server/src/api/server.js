import http from 'node:http';
import { HEALTH_STATES, INTERVALS, MARKET_TYPES, MAX_QUERY_RANGE_MS, MAX_QUERY_ROWS, SYMBOLS } from '../domain/constants.js';
import { buildRealtimeDashboard } from '../dashboard/build-realtime-dashboard.js';
import { REALTIME_DASHBOARD_PAGE_HTML } from '../dashboard/realtime-page.js';
import { readD8DisplayStatus } from '../validation-replay/d8-status-reader.js';

const json=(res,status,body)=>{const payload=JSON.stringify(body);res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(payload),'cache-control':'no-store'});res.end(payload);};
const html=(res,status,body)=>{res.writeHead(status,{'content-type':'text/html; charset=utf-8','content-length':Buffer.byteLength(body),'cache-control':'no-store'});res.end(body);};
const error=(res,status,code,message)=>json(res,status,{ok:false,error:{code,message}});
const oneOf=(value,allowed,name)=>{if(!allowed.includes(value))throw Object.assign(new Error(`${name}不在白名单内`),{status:400,code:`INVALID_${name.toUpperCase()}`});return value;};
const integer=(value,fallback,min,max,name)=>{const n=value===null?fallback:Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw Object.assign(new Error(`${name}超出范围`),{status:400,code:`INVALID_${name.toUpperCase()}`});return n;};
function range(params){const now=Date.now();const to=integer(params.get('to'),now,0,Number.MAX_SAFE_INTEGER,'to');const from=integer(params.get('from'),to-7*86400000,0,to,'from');if(to-from>MAX_QUERY_RANGE_MS)throw Object.assign(new Error('时间范围超过366天'),{status:400,code:'RANGE_TOO_LARGE'});return{from,to};}

export function createApiServer({collector,repository,host='127.0.0.1',port=8787,d8ArtifactRoot,d8RunStatusRoot}){
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.method!=='GET')return error(res,405,'METHOD_NOT_ALLOWED','仅支持只读GET请求');
      const url=new URL(req.url,'http://localhost');const p=url.pathname;
      if(p==='/'||p==='/dashboard')return html(res,200,REALTIME_DASHBOARD_PAGE_HTML);
      if(p==='/health/live')return json(res,200,{ok:true,status:'LIVE',time:new Date().toISOString()});
      if(p==='/health/ready'){const readiness=await collector.readiness();return json(res,readiness.ok?200:503,readiness.ok?{ok:true,status:readiness.status,checks:readiness.checks}:{ok:false,error:{code:'NOT_READY',message:'采集服务尚未就绪'},status:readiness.status,checks:readiness.checks});}
      if(p==='/api/v1/collector/status')return json(res,200,{ok:true,data:collector.status()});
      if(p==='/api/v1/data-health')return json(res,200,{ok:true,data:await repository.latestHealth()});
      if(p==='/api/v1/gaps')return json(res,200,{ok:true,data:await repository.listGaps(integer(url.searchParams.get('limit'),100,1,MAX_QUERY_ROWS,'limit'))});
      if(p==='/api/v1/sources')return json(res,200,{ok:true,data:await repository.listSources()});
      if(p==='/api/v1/bars'){const q={instrument:oneOf(url.searchParams.get('instrument'),SYMBOLS,'instrument'),marketType:oneOf(url.searchParams.get('marketType')||'spot',MARKET_TYPES,'marketType'),interval:oneOf(url.searchParams.get('interval'),INTERVALS,'interval'),...range(url.searchParams),limit:integer(url.searchParams.get('limit'),500,1,MAX_QUERY_ROWS,'limit')};return json(res,200,{ok:true,data:await repository.listBars(q)});}
      if(p==='/api/v1/derivatives/funding'||p==='/api/v1/derivatives/open-interest'){const q={instrument:oneOf(url.searchParams.get('instrument'),SYMBOLS,'instrument'),...range(url.searchParams),limit:integer(url.searchParams.get('limit'),100,1,MAX_QUERY_ROWS,'limit')};const table=p.endsWith('funding')?'funding_rates':'open_interest';return json(res,200,{ok:true,data:await repository.listSimple(table,q)});}
      if(p==='/api/v1/features/by-id'){const featureId=url.searchParams.get('featureId');if(!featureId)throw Object.assign(new Error('featureId不能为空'),{status:400,code:'FEATURE_ID_REQUIRED'});return json(res,200,{ok:true,data:await repository.getFeatureById(featureId)});}
      if(p==='/api/v1/features'){const q={symbol:oneOf(url.searchParams.get('symbol')||'ETHUSDT',SYMBOLS,'symbol'),targetInterval:oneOf(url.searchParams.get('interval')||'15m',INTERVALS,'interval'),...range(url.searchParams),limit:integer(url.searchParams.get('limit'),100,1,MAX_QUERY_ROWS,'limit')};return json(res,200,{ok:true,data:await repository.listFeatures(q)});}
      if(p==='/api/v1/features/lineage'||p==='/api/v1/features/quality'){const featureId=url.searchParams.get('featureId');if(!featureId)throw Object.assign(new Error('featureId不能为空'),{status:400,code:'FEATURE_ID_REQUIRED'});return json(res,200,{ok:true,data:p.endsWith('lineage')?await repository.getFeatureLineage(featureId):await repository.listFeatureQuality(featureId)});}
      if(p==='/api/v1/features/runs')return json(res,200,{ok:true,data:await repository.listFeatureRuns(integer(url.searchParams.get('limit'),100,1,MAX_QUERY_ROWS,'limit'))});
      if(p==='/api/v1/features/issues')return json(res,200,{ok:true,data:await repository.listFeatureIssues({symbol:oneOf(url.searchParams.get('symbol')||'ETHUSDT',SYMBOLS,'symbol'),limit:integer(url.searchParams.get('limit'),100,1,MAX_QUERY_ROWS,'limit')})});
      // 实时看板：实时市场状态+24H/72H UP/DOWN/RANGE方向预测+独立交易许可，三层严格分离（见
      // server/src/dashboard/*.js顶部说明）。本路由只读repository.latestBars/latestProvisionalBar/
      // latestForecastSnapshot与collector.readiness()，不触发采集或预测生成，不写入任何行。
      if(p==='/api/v1/dashboard/realtime'){const instrument=oneOf(url.searchParams.get('instrument')||'ETHUSDT',SYMBOLS,'instrument');return json(res,200,{ok:true,data:await buildRealtimeDashboard({repository,collector,instrument})});}
      // D8正式研究只读展示：只读取D7已发布产物+编排运行状态遥测，不查询业务表、不调用D8求值函数、
      // 不触发任何研究/发布/交易动作（见d8-status-reader.js头部红线）。json()统一设置no-store。
      if(p==='/api/v1/research/d8/status')return json(res,200,{ok:true,data:readD8DisplayStatus({artifactRoot:d8ArtifactRoot,statusRoot:d8RunStatusRoot})});
      return error(res,404,'NOT_FOUND','接口不存在');
    }catch(e){return error(res,e.status||500,e.code||'INTERNAL_ERROR',e.status?e.message:'服务暂时不可用');}
  });
  return {server,start:()=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>resolve(server.address()));}),stop:()=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()))};
}
