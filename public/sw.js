// Service Worker v2.0 - Push Bildirimleri için

self.addEventListener('install', (event) => {
    console.log('✅ Service Worker kuruldu');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('✅ Service Worker aktif');
    event.waitUntil(clients.claim());
});

self.addEventListener('push', function(event) {
    console.log('📨 Push bildirimi alındı');
    
    let data = {};
    
    try {
        data = event.data.json();
    } catch (e) {
        data = {
            title: 'Birlikte İzle',
            body: event.data.text(),
            icon: '/icon.png',
            badge: '/badge.png'
        };
    }
    
    const options = {
        body: data.body || 'Bir davetin var!',
        icon: data.icon || 'https://ik.imagekit.io/5v8xlfyfa/icon.png',
        badge: data.badge || 'https://ik.imagekit.io/5v8xlfyfa/badge.png',
        vibrate: [200, 100, 200],
        data: data.data || {},
        actions: data.actions || [
            { action: 'open', title: 'Odaya Git' },
            { action: 'close', title: 'Kapat' }
        ],
        tag: 'birlikte-izle',
        renotify: true,
        requireInteraction: true,
        silent: false
    };
    
    event.waitUntil(
        self.registration.showNotification(
            data.title || '📱 Birlikte İzle',
            options
        )
    );
});

self.addEventListener('notificationclick', function(event) {
    console.log('🔔 Bildirime tıklandı:', event.action);
    
    event.notification.close();
    
    if (event.action === 'open') {
        const urlToOpen = event.notification.data?.url || '/';
        
        event.waitUntil(
            clients.matchAll({
                type: 'window',
                includeUncontrolled: true
            }).then((clientList) => {
                for (const client of clientList) {
                    if (client.url === urlToOpen && 'focus' in client) {
                        return client.focus();
                    }
                }
                return clients.openWindow(urlToOpen);
            })
        );
    }
});

self.addEventListener('notificationclose', function(event) {
    console.log('❌ Bildirim kapatıldı');
});
