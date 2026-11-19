/* BetPro : toujours charger la dernière interface depuis GitHub Pages.
   Les flux sportifs et les API Cloudflare ne sont pas interceptés. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin || !url.pathname.startsWith('/pgi-BetPro.github.io/'))return;
  if(request.mode==='navigate' || url.pathname==='/pgi-BetPro.github.io/betpro-app.js'){
    event.respondWith(fetch(request,{cache:'no-store'}));
  }
});
