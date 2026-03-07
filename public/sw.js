const CACHE_NAME='birlikte-izle-v1';
self.addEventListener('install',e=>{ self.skipWaiting(); });
self.addEventListener('activate',e=>{ e.waitUntil(self.clients.claim()); });
self.addEventListener('push',e=>{
    if(!e.data)return;
    const d=e.data.json();
    e.waitUntil(self.registration.showNotification(d.title||'Birlikte İzle',{
        body:d.body||'Yeni bildirim',icon:'/icon-192.png',badge:'/badge-72.png',
        vibrate:[200,100,200],data:d.data||{},requireInteraction:true,
        actions:[{action:'open',title:'Aç'},{action:'close',title:'Kapat'}]
    }));
});
self.addEventListener('notificationclick',e=>{
    e.notification.close();
    if(e.action==='open'||!e.action){
        const d=e.notification.data;
        if(d.type==='room-invite'&&d.roomCode){
            e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{
                for(const c of cs){ if('focus'in c){ c.focus(); c.postMessage({type:'room-invite-notification-click',roomCode:d.roomCode,inviteId:d.inviteId}); return; } }
                if(clients.openWindow) return clients.openWindow(`/?room=${d.roomCode}&invite=${d.inviteId}`);
            }));
        }else{
            e.waitUntil(clients.matchAll({type:'window'}).then(cs=>cs.length>0?cs[0].focus():clients.openWindow('/')));
        }
    }
});
