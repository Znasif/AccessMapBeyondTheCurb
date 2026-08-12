/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
let coepCredentialless = false;
if (typeof window === 'undefined') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
  self.addEventListener('fetch', (event) => {
    if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') {
      return;
    }
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.status === 0) return response;
          const newHeaders = new Headers(response.headers);
          newHeaders.set('Cross-Origin-Embedder-Policy', coepCredentialless ? 'credentialless' : 'require-corp');
          if (!coepCredentialless) {
            newHeaders.set('Cross-Origin-Resource-Policy', 'cross-origin');
          }
          newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        })
        .catch((e) => console.error(e))
    );
  });
} else {
  (() => {
    const coi = {
      shouldRegister: () => !window.crossOriginIsolated,
      doReload: () => {
        window.sessionStorage.setItem('coiReloadedBySelf', 'true');
        window.location.reload();
      },
    };
    if (coi.shouldRegister()) {
      if (navigator.serviceWorker) {
        navigator.serviceWorker.register(window.document.currentScript.src).then(
          (registration) => {
            registration.addEventListener('updatefound', () => {
              coi.doReload();
            });
            if (registration.active && !navigator.serviceWorker.controller) {
              coi.doReload();
            }
          },
          (err) => console.error('COI Service Worker failed to register:', err)
        );
      }
    }
  })();
}
