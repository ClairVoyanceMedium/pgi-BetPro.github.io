
const SOURCES=[
 ['Foot Mercato','footmercato.net','soccer','football'],
 ['Maxifoot','maxifoot.fr','soccer','football'],
 ['RMC Sport','rmcsport.bfmtv.com','soccer','football'],
 ['Eurosport','eurosport.fr','tennis','tennis'],
 ['Basket USA','basketusa.com','basketball','NBA'],
 ['Tennis Actu','tennisactu.net','tennis','tennis'],
 ['Rugbyrama','rugbyrama.fr','rugby','rugby'],
 ['beIN SPORTS','beinsports.com','handball','handball'],
 ['Motorsport.com','fr.motorsport.com','formula1','"Formule 1" OR F1'],
 ['AUTOhebdo','autohebdo.fr','formula1','"Formule 1" OR F1'],
 ['F1i','f1i.autojournal.fr','formula1','"Formule 1" OR F1']
];
const headers={'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'https://clairvoyancemedium.github.io','Cache-Control':'public, max-age=1800','X-Content-Type-Options':'nosniff'};
function decode(v){return String(v||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>{const i=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return i>0&&i<=0x10ffff&&!(i>=0xd800&&i<=0xdfff)?String.fromCodePoint(i):'';}).replace(/&(amp|lt|gt|quot|apos|nbsp);/g,(_,k)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '})[k]).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();}
function field(x,k){return decode(x.match(new RegExp('<'+k+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+k+'>','i'))?.[1]);}
function host(v){try{return new URL(v).hostname.toLowerCase().replace(/^www\./,'');}catch(_){return '';}}
function key(v){return String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
async function readSource([name,domain,sport,query]){
 const url=new URL('https://news.google.com/rss/search');
 url.search=new URLSearchParams({q:'site:'+domain+' ('+query+') when:3d',hl:'fr',gl:'FR',ceid:'FR:fr'}).toString();
 const res=await fetch(url,{signal:AbortSignal.timeout(8500),headers:{Accept:'application/rss+xml, application/xml, text/xml'}});
 if(!res.ok)throw Error('HTTP '+res.status);
 const xml=await res.text();if(xml.length>1200000||!/<rss\b/i.test(xml))throw Error('RSS invalide');
 const out=[],now=Date.now();
 for(const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)){
  const item=m[1],sourceTag=item.match(/<source\b[^>]*\burl="([^"]+)"[^>]*>/i),h=host(decode(sourceTag?.[1]));
  if(h!==domain&&!h.endsWith('.'+domain))continue;
  const pub=Date.parse(field(item,'pubDate')),link=field(item,'link');
  if(!Number.isFinite(pub)||pub>now+300000||now-pub>72*3600000)continue;
  if(host(link)!=='news.google.com'||!/^https:\/\/news\.google\.com\/rss\/articles\//i.test(link))continue;
  let title=field(item,'title').replace(/\s+-\s+[^-]+$/,'').trim();
  if(title.length<12||title.length>300||/[<>]/.test(title))continue;
  if(sport==='formula1'&&!/\b(?:F1|formule 1|grand prix|pilote|écurie|qualification|sprint|FIA)\b/i.test(title))continue;
  if(/\b(?:bonus|code promo|offre de bienvenue|freebet|pari gratuit)\b/i.test(title))continue;
  out.push({title,link,published:new Date(pub).toISOString(),source:name,sport,language:'fr',is_match:false,editorial_extra:true});
 }
 return out.sort((a,b)=>Date.parse(b.published)-Date.parse(a.published)).slice(0,3);
}
let memory=null,pending=null;
export default {async fetch(req,env,ctx){
 const u=new URL(req.url);
 if(req.method!=='GET'||u.pathname!=='/news')return new Response('Not found',{status:404});
 const cacheKey=new Request(u.origin+'/news'),cached=await caches.default.match(cacheKey);
 if(cached)return cached;
 if(memory&&Date.now()-memory.at<1800000)return Response.json(memory.payload,{headers});
 if(!pending)pending=(async()=>{
  const settled=await Promise.allSettled(SOURCES.map(readSource)),seen=new Set(),news=[],coverage=[];
  for(let i=0;i<settled.length;i++){
   const r=settled[i],items=r.status==='fulfilled'?r.value:[];
   coverage.push({source:SOURCES[i][0],sport:SOURCES[i][2],count:items.length,ok:r.status==='fulfilled'});
   for(const item of items){const k=key(item.title);if(!seen.has(k)){seen.add(k);news.push(item);}}
  }
  const p={ok:news.length>0,news,coverage,fetched_at:new Date().toISOString()};
  if(p.ok)memory={at:Date.now(),payload:p};
  return p;
 })().finally(()=>{pending=null;});
 const p=await pending;
 const response=Response.json(p,{headers:{...headers,'Cache-Control':p.ok?'public, max-age=1800':'public, max-age=120'}});
 ctx.waitUntil(caches.default.put(cacheKey,response.clone()).catch(()=>{}));return response;
}};
