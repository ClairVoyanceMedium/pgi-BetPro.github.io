
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

/* Independent expanded Google News feed. Existing /news endpoint remains intact. */
const EXPANDED_SPORTS=[
 ['soccer','football OR "Ligue 1" OR "Ligue des champions" OR "Premier League"',/\b(foot(?:ball)?|ligue 1|ligue 2|ligue des champions|premier league|liga|serie a|bundesliga|psg|om|mercato|equipe de france|champions league)\b/],
 ['basketball','basketball OR NBA OR EuroLeague OR "Betclic Elite"',/\b(basket(?:ball)?|nba|eurol(?:eague|igue)|betclic elite|wnba|eurocup|asvel)\b/],
 ['tennis','tennis OR ATP OR WTA OR "Coupe Davis"',/\b(tennis|atp|wta|coupe davis|roland garros|grand chelem|wimbledon|open d australie|us open)\b/],
 ['formula1','"Formule 1" OR F1 OR "Grand Prix de F1"',/\b(formule 1|f1|grand prix|fia|ecurie|paddock)\b/],
 ['rugby','rugby OR "Top 14" OR "Champions Cup rugby" OR "Pro D2"',/\b(rugby|top 14|pro d2|six nations|6 nations|all blacks|xv de france)\b/],
 ['handball','handball OR "Starligue" OR "Ligue des champions handball"',/\b(handball|starligue|ehf|liqui moly|ligue feminine de handball)\b/],
 ['mma','MMA OR UFC OR "combat MMA" OR PFL',/\b(mma|ufc|pfl|cage warriors|octogone|bellator|ares fc)\b/],
 ['boxing','boxe OR "boxe anglaise" OR "champion du monde boxe"',/\b(boxe|boxeur|boxeuse|wbc|wba|wbo|ibf|poids lourds)\b/],
 ['icehockey','"hockey sur glace" OR NHL OR "Ligue Magnus"',/\b(hockey|nhl|ligue magnus|stanley cup|coupe stanley)\b/],
 ['baseball','baseball OR MLB OR "World Series baseball"',/\b(baseball|mlb|world series|serie mondiale|ligues majeures)\b/],
 ['americanfootball','"football américain" OR NFL OR "Super Bowl"',/\b(football americain|nfl|super bowl|quarterback|touchdown)\b/],
 ['volleyball','"volley-ball" OR volleyball OR "Ligue des champions volley"',/\b(volley(?: ball|ball)?|ligue a volley|vnl|fivb|marmara spikeleague)\b/]
];
const EXPANDED_PUBLISHERS=[
 ['lequipe.fr',"L’Équipe"],['rmcsport.bfmtv.com','RMC Sport'],['eurosport.fr','Eurosport'],['sport.fr','Sport.fr'],['leparisien.fr','Le Parisien'],['ouest-france.fr','Ouest-France'],['franceinfo.fr','Franceinfo'],['francetvinfo.fr','Franceinfo'],['francetv.fr','France Télévisions'],['sports.fr','Sports.fr'],['beinsports.com','beIN SPORTS'],
 ['footmercato.net','Foot Mercato','soccer'],['maxifoot.fr','Maxifoot','soccer'],['sofoot.com','So Foot','soccer'],['onze-mondial.com','Onze Mondial','soccer'],['basketusa.com','Basket USA','basketball'],['basketeurope.com','Basket Europe','basketball'],['tennisactu.net','Tennis Actu','tennis'],['welovetennis.fr','We Love Tennis','tennis'],['rugbyrama.fr','Rugbyrama','rugby'],['midi-olympique.fr','Midi Olympique','rugby'],['handnews.fr','HandNews','handball'],['ffhandball.fr','FFHandball','handball'],['fr.motorsport.com','Motorsport.com','formula1'],['autohebdo.fr','AUTOhebdo','formula1'],['f1i.autojournal.fr','F1i','formula1'],['lasueur.com','La Sueur'],['boxemag.com','Boxemag'],['hockeyfrance.com','FFHG','icehockey'],['ffbs.fr','FFBS','baseball'],['touchdownactu.com','Touchdown Actu','americanfootball'],['ffvolley.org','FFVolley','volleyball'],['lnv.fr','Ligue nationale de volley','volleyball']
];
function expandedPublisher(domain){return EXPANDED_PUBLISHERS.find(([d])=>domain===d||domain.endsWith('.'+d));}
async function readExpanded([sport,query,pattern]){
 const url=new URL('https://news.google.com/rss/search');
 url.search=new URLSearchParams({q:'('+query+') when:3d',hl:'fr',gl:'FR',ceid:'FR:fr'}).toString();
 const res=await fetch(url,{signal:AbortSignal.timeout(7000),headers:{Accept:'application/rss+xml, application/xml, text/xml'}});
 if(!res.ok)throw Error('HTTP '+res.status);
 const xml=await res.text();if(xml.length>1500000||!/<rss\b/i.test(xml))throw Error('RSS invalide');
 const now=Date.now(),items=[],seen=new Set();
 for(const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)){
  const item=m[1],sourceTag=item.match(/<source\b[^>]*\burl="([^"]+)"[^>]*>/i),publisher=expandedPublisher(host(decode(sourceTag?.[1])));
  if(!publisher)continue;
  const pub=Date.parse(field(item,'pubDate')),link=field(item,'link');
  if(!Number.isFinite(pub)||pub>now+300000||now-pub>72*3600000||!/^https:\/\/news\.google\.com\/rss\/articles\//i.test(link)||host(link)!=='news.google.com')continue;
  let title=field(item,'title');const suffix=field(item,'source');if(suffix&&title.endsWith(' - '+suffix))title=title.slice(0,-suffix.length-3).trim();
  const k=key(title);if(title.length<12||title.length>300||/[<>]/.test(title)||seen.has(k))continue;
  if(/\b(bonus|code promo|offre de bienvenue|freebet|pari gratuit|pronostic gratuit)\b/.test(k))continue;
  if(publisher[2]!==sport&&!pattern.test(k))continue;
  if(publisher[2]&&publisher[2]!==sport)continue;
  if(/\b(?:live stream|watch live|how to watch|odds and picks)\b/i.test(title))continue;
  seen.add(k);items.push({title,link,published:new Date(pub).toISOString(),source:'Google Actualités · '+publisher[1],publisher:publisher[1],sport,language:'fr',is_match:false,editorial_extra:true,google_expanded:true});
 }
 items.sort((a,b)=>Date.parse(b.published)-Date.parse(a.published));
 const chosen=[],publishers=new Set();
 for(const item of items){if(publishers.has(item.publisher))continue;publishers.add(item.publisher);chosen.push(item);if(chosen.length>=6)break;}
 for(const item of items){if(chosen.length>=6)break;if(!chosen.includes(item))chosen.push(item);}
 return chosen;
}
function failureReason(r){return r.status==='rejected'?String(r.reason?.message||r.reason||'Erreur RSS').slice(0,120):undefined;}
async function staleNews(cacheKey){
 try{const response=await caches.default.match(cacheKey);if(!response)return[];const p=await response.json();return Array.isArray(p.news)?p.news.filter(x=>{const t=Date.parse(x.published);return Number.isFinite(t)&&t<=Date.now()+300000&&Date.now()-t<=72*3600000;}):[];}catch(_){return[];}
}
function saveStale(ctx,key,news){if(!news.length)return;ctx.waitUntil(caches.default.put(key,Response.json({news},{headers:{'Cache-Control':'public, max-age=259200'}})).catch(()=>{}));}
let expandedMemory=null,expandedPending=null;
async function expandedResponse(u,ctx){
 const cacheKey=new Request(u.origin+'/news/expanded-v2'),backupKey=new Request(u.origin+'/news/expanded-last-good'),cached=await caches.default.match(cacheKey);if(cached)return cached;
 if(expandedMemory&&Date.now()-expandedMemory.at<1800000)return Response.json(expandedMemory.payload,{headers});
 if(!expandedPending)expandedPending=(async()=>{
  const results=[];for(let i=0;i<EXPANDED_SPORTS.length;i+=6)results.push(...await Promise.allSettled(EXPANDED_SPORTS.slice(i,i+6).map(readExpanded)));
  const news=[],coverage=[],seen=new Set();
  for(let i=0;i<results.length;i++){const r=results[i],items=r.status==='fulfilled'?r.value:[];coverage.push({sport:EXPANDED_SPORTS[i][0],count:items.length,ok:r.status==='fulfilled',error:failureReason(r)});for(const item of items){const k=key(item.title);if(!seen.has(k)){seen.add(k);news.push(item);}}}
  const stale=await staleNews(backupKey),keys=new Set(news.map(x=>key(x.title)));for(const x of stale){const k=key(x.title);if(!keys.has(k)&&news.filter(y=>y.sport===x.sport).length<6){keys.add(k);news.push(x);}}
  const fresh=coverage.some(x=>x.count>0);if(fresh)saveStale(ctx,backupKey,news);
  const p={ok:news.length>0,news,coverage,fetched_at:new Date().toISOString(),version:'expanded-v2',stale:!fresh};
  if(fresh)expandedMemory={at:Date.now(),payload:p};return p;
 })().finally(()=>{expandedPending=null;});
 const p=await expandedPending,response=Response.json(p,{headers:{...headers,'Cache-Control':p.ok&&!p.stale?'public, max-age=1800':'public, max-age=120'}});
 ctx.waitUntil(caches.default.put(cacheKey,response.clone()).catch(()=>{}));return response;
}

let memory=null,pending=null;
export default {async fetch(req,env,ctx){
 const u=new URL(req.url);
 if(req.method==='GET'&&u.pathname==='/news/expanded')return expandedResponse(u,ctx);
 if(req.method!=='GET'||u.pathname!=='/news')return new Response('Not found',{status:404});
 const cacheKey=new Request(u.origin+'/news-v2'),backupKey=new Request(u.origin+'/news-last-good'),cached=await caches.default.match(cacheKey);
 if(cached)return cached;
 if(memory&&Date.now()-memory.at<1800000)return Response.json(memory.payload,{headers});
 if(!pending)pending=(async()=>{
  const settled=[];for(let i=0;i<SOURCES.length;i+=6)settled.push(...await Promise.allSettled(SOURCES.slice(i,i+6).map(readSource)));const seen=new Set(),news=[],coverage=[];
  for(let i=0;i<settled.length;i++){
   const r=settled[i],items=r.status==='fulfilled'?r.value:[];
   coverage.push({source:SOURCES[i][0],sport:SOURCES[i][2],count:items.length,ok:r.status==='fulfilled',error:failureReason(r)});
   for(const item of items){const k=key(item.title);if(!seen.has(k)){seen.add(k);news.push(item);}}
  }
  const stale=await staleNews(backupKey);for(const x of stale){const k=key(x.title);if(!seen.has(k)&&news.filter(y=>y.source===x.source).length<3){seen.add(k);news.push(x);}}
  const fresh=coverage.some(x=>x.count>0);if(fresh)saveStale(ctx,backupKey,news);
  const p={ok:news.length>0,news,coverage,fetched_at:new Date().toISOString(),stale:!fresh};
  if(fresh)memory={at:Date.now(),payload:p};
  return p;
 })().finally(()=>{pending=null;});
 const p=await pending;
 const response=Response.json(p,{headers:{...headers,'Cache-Control':p.ok&&!p.stale?'public, max-age=1800':'public, max-age=120'}});
 ctx.waitUntil(caches.default.put(cacheKey,response.clone()).catch(()=>{}));return response;
}};
