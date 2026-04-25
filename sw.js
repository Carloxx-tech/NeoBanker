/* ═══════════════════════════════════════════════════════════════
   NEOBANKER — sw.js
   Service Worker minimalista · Network-first, cache fallback
   ═══════════════════════════════════════════════════════════════ */
 
const CACHE_NAME = 'neobanker-v1';
 
/** Recursos de la shell de la app que se pre-cachean al instalar. */
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/config.js',
  '/manifest.json',
];
 
/**
 * Dominios que NUNCA deben pasar por el cache.
 * Firebase necesita red real para sus websockets y REST calls;
 * Google Fonts también cambia con frecuencia.
 */
const BYPASS_DOMAINS = [
  'firebaseio.com',
  'googleapis.com',
  'firebaseapp.com',
  'firebase.google.com',
  'gstatic.com',        // CDN de Firebase JS SDK y Google Fonts
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];
 
/* ══════════════════════════════════════════════════════════════
   INSTALL — pre-cachear la shell
══════════════════════════════════════════════════════════════ */
 
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => {
        // Activar inmediatamente sin esperar a que las pestañas
        // abiertas terminen de usar el SW anterior.
        self.skipWaiting();
      })
      .catch((err) => {
        console.error('[SW] Error al pre-cachear shell:', err);
      }),
  );
});
 
/* ══════════════════════════════════════════════════════════════
   ACTIVATE — limpiar caches obsoletos
══════════════════════════════════════════════════════════════ */
 
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => {
              console.info('[SW] Eliminando cache obsoleto:', key);
              return caches.delete(key);
            }),
        ),
      )
      .then(() => {
        // Tomar control de todas las pestañas abiertas de inmediato.
        self.clients.claim();
      }),
  );
});
 
/* ══════════════════════════════════════════════════════════════
   FETCH — Network first, cache fallback
══════════════════════════════════════════════════════════════ */
 
self.addEventListener('fetch', (event) => {
  const { request } = event;
 
  // Solo interceptar requests GET
  if (request.method !== 'GET') return;
 
  // Parsear URL para inspeccionar el dominio
  let url;
  try {
    url = new URL(request.url);
  } catch {
    // URL inválida: dejar pasar sin intervenir
    return;
  }
 
  // ── Bypass: Firebase, Google APIs y CDNs externos ────────────
  const esBypass = BYPASS_DOMAINS.some((domain) =>
    url.hostname === domain || url.hostname.endsWith(`.${domain}`),
  );
  if (esBypass) return;   // El browser maneja la request directamente
 
  // ── Network first, cache fallback ───────────────────────────
  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        // La red respondió correctamente: actualizar cache y devolver.
        // Solo cacheamos responses válidas de nuestro propio origen.
        if (
          networkResponse.ok &&
          url.origin === self.location.origin
        ) {
          const responseClone = networkResponse.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(request, responseClone))
            .catch(() => {/* no crítico */});
        }
        return networkResponse;
      })
      .catch(async () => {
        // Sin red: intentar servir desde cache.
        const cached = await caches.match(request, { ignoreSearch: false });
 
        if (cached) return cached;
 
        // Si no hay cache ni red y es una navegación (HTML),
        // servir index.html para que la app pueda mostrar un mensaje.
        if (request.mode === 'navigate') {
          const fallback = await caches.match('/index.html');
          if (fallback) return fallback;
        }
 
        // No hay nada que servir: devolver 503 genérico.
        return new Response('Sin conexión y sin cache disponible.', {
          status:  503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }),
  );
});