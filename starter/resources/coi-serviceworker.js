/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
let coepCredentialless = true;
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
          // PATCHED (not upstream v0.1.7). 204/205/304 are "null body status":
          // `new Response(body, {status})` THROWS for them, the throw lands in
          // the .catch below, which returns undefined, and the browser reports
          // "Failed to convert value to 'Response'" — the request fails outright
          // rather than degrading. A 304 on reload is routine, so unpatched this
          // breaks cached fetches on every repeat visit; observed first on
          // Mapbox's 204 telemetry beacon.
          const nullBody = response.status === 204 || response.status === 205
            || response.status === 304;
          return new Response(nullBody ? null : response.body, {
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
