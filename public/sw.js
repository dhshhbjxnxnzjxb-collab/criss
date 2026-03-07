// Service Worker for Push Notifications
const CACHE_NAME = 'birlikte-izle-v1';

self.addEventListener('install', (event) => {
    console.log('Service Worker: Yüklendi');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('Service Worker: Aktif edildi');
    event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
    console.log('Push bildirimi alındı:', event);
    
    if (!event.data) {
        console.log('Push event ama veri yok');
        return;
    }
    
    const data = event.data.json();
    console.log('Push data:', data);
    
    const options = {
        body: data.body || 'Yeni bir bildirim var',
        icon: data.icon || '/icon-192.png',
        badge: data.badge || '/badge-72.png',
        vibrate: data.vibrate || [200, 100, 200],
        data: data.data || {},
        tag: data.tag || 'default',
        requireInteraction: true,
        actions: [
            {
                action: 'open',
                title: 'Aç'
            },
            {
                action: 'close',
                title: 'Kapat'
            }
        ]
    };
    
    event.waitUntil(
        self.registration.showNotification(data.title || 'Birlikte İzle', options)
    );
});

self.addEventListener('notificationclick', (event) => {
    console.log('Bildirime tıklandı:', event);
    event.notification.close();
    
    if (event.action === 'open' || !event.action) {
        const data = event.notification.data;
        
        if (data.type === 'room-invite' && data.roomCode) {
            const url = `/?room=${data.roomCode}&invite=${data.inviteId}`;
            
            event.waitUntil(
                clients.matchAll({ type: 'window', includeUncontrolled: true })
                    .then((clientList) => {
                        for (const client of clientList) {
                            if ('focus' in client) {
                                client.focus();
                                client.postMessage({
                                    type: 'room-invite-notification-click',
                                    roomCode: data.roomCode,
                                    inviteId: data.inviteId
                                });
                                return;
                            }
                        }
                        if (clients.openWindow) {
                            return clients.openWindow(url);
                        }
                    })
            );
        } else {
            event.waitUntil(
                clients.matchAll({ type: 'window' })
                    .then((clientList) => {
                        if (clientList.length > 0) {
                            return clientList[0].focus();
                        }
                        return clients.openWindow('/');
                    })
            );
        }
    }
});

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});
