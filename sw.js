// Dominus de bolso: service worker minimo (so para instalar como app; sem cache agressivo - a pagina muda).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
