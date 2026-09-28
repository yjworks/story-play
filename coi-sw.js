// 교차 출처 격리(cross-origin isolation)용 서비스 워커.
// GitHub Pages는 COOP/COEP 헤더를 줄 수 없어서, 이 워커가 같은 사이트 파일의 응답에 헤더를 붙여 줌.
// → crossOriginIsolated 가 켜져 WASM이 CPU 여러 코어(스레드)를 씀. WebGPU가 없는 휴대폰에서 합성이 빨라짐.
// 다른 사이트(HF 모델 파일)는 건드리지 않음. 그쪽은 CORS 로 받으므로 COEP 조건을 만족함.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (new URL(req.url).origin !== self.location.origin) return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  // 앱 파일은 매번 서버에 바뀌었는지 물어봄(no-cache: 안 바뀌었으면 304로 짧게 끝남).
  // GitHub Pages 기본 캐시(10분) 때문에 업데이트 후에도 예전 tts.js 가 쓰이는 일을 막음.
  const fresh = req.method === 'GET' ? new Request(req, { cache: 'no-cache' }) : req;
  e.respondWith(
    fetch(fresh).then((res) => {
      if (res.status === 0) return res;
      const headers = new Headers(res.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }),
  );
});
