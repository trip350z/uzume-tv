self.addEventListener('fetch', event => {
    if (event.request.mode !== 'navigate' || event.request.method !== 'GET' ||
        new URL(event.request.url).pathname !== new URL(self.registration.scope).pathname) return;
    event.respondWith(fetch(event.request).catch(() => new Response(
        '<!doctype html><html lang="ja"><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>宇受売 TV</title><h1>宇受売 TV</h1><p>サーバーに接続できません。</p>' +
        '<a href="./#tv">再接続</a></html>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    )));
});
