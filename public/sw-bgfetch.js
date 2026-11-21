// Android/Chrome Background Fetch: lets a flight's maps keep downloading after you leave the app.
// Responses are filed into the same cache the app reads offline tiles from.
async function fileRecords(event, title) {
  const cache = await caches.open('fw-tiles-v1');
  const records = await event.registration.matchAll();
  for (const r of records) {
    try {
      const res = await r.responseReady;
      if (res && res.ok && res.type !== 'opaque') await cache.put(r.request.url, res);
    } catch (e) { /* skip this file; the app fetches anything missing when reopened */ }
  }
  const meta = await caches.open('fw-data-v1');
  await meta.put(`/__fw/bg-${event.registration.id}-done`, new Response(String(Date.now())));
  try { await event.updateUI({ title }); } catch (e) { /* not supported */ }
}
self.addEventListener('backgroundfetchsuccess', (e) => e.waitUntil(fileRecords(e, 'Flight maps saved for offline ✈︎')));
self.addEventListener('backgroundfetchfail', (e) => e.waitUntil(fileRecords(e, 'Some map files failed. Open Flight Window to finish.')));
self.addEventListener('backgroundfetchclick', (e) => e.waitUntil(self.clients.openWindow('/')));
