const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const ImageKit = require('imagekit');
const CronJob = require('cron').CronJob;
const webpush = require('web-push');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

const imagekit = new ImageKit({
    publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
    urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT
});

webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
);

const rooms = new Map();
const users = new Map();
const messages = new Map();
const userStickers = new Map();
const securePhotos = new Map();
const videoLibrary = new Map();
const userSessions = new Map();
const roomVisitors = new Map();
const pushSubscriptions = new Map();
const pendingInvites = new Map();

const ADMIN_IP = process.env.ADMIN_IP;

setInterval(() => {
    const https = require('https');
    const http = require('http');
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(`${url}/api/health`, (res) => {}).on('error', (err) => {});
}, 60 * 1000);

const cleanupJob = new CronJob('0 * * * *', async () => {
    console.log('🧹 Video kütüphanesi temizleniyor...');
    const now = Date.now();
    const expiredVideos = [];
    videoLibrary.forEach((video, videoId) => {
        if (video.expiresAt < now) {
            expiredVideos.push(videoId);
            imagekit.deleteFile(video.fileId, (error, result) => {});
        }
    });
    expiredVideos.forEach(id => videoLibrary.delete(id));
    io.emit('video-library-updated', getVideoLibraryList());
});
cleanupJob.start();

const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 5 * 1024 * 1024 * 1024,
    pingTimeout: 120000,
    pingInterval: 25000
});

app.use(cors({ origin: '*', methods: ['GET', 'POST'], credentials: true }));
app.use(express.json({ limit: '5gb' }));
app.use(express.urlencoded({ extended: true, limit: '5gb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 * 1024 },
    fileFilter: (req, file, cb) => file.mimetype.startsWith('video/') ? cb(null, true) : cb(new Error('Sadece video!'))
}).single('video');

function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

function generateUserColor(username) {
    const colors = ['#405DE6','#5851DB','#833AB4','#C13584','#E1306C','#FD1D1D','#F56040','#F77737','#FCAF45','#FFDC80'];
    const index = username ? username.split('').reduce((a,c)=>a+c.charCodeAt(0),0) : 0;
    return colors[index % colors.length];
}

function generateDefaultAvatar(username) {
    const firstLetter = username ? username.charAt(0).toUpperCase() : '?';
    const color = generateUserColor(username);
    return `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect width="100" height="100" fill="${color}"/><text x="50" y="60" font-family="Arial" font-size="40" text-anchor="middle" fill="white">${firstLetter}</text></svg>`;
}

function extractYouTubeId(url) {
    const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
    const match = url.match(regex);
    return match ? match[1] : null;
}

function updateUserList(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    const userList = Array.from(room.users.values()).map(u => ({
        id: u.id, userName: u.userName, userPhoto: u.userPhoto, userColor: u.userColor,
        isOwner: u.isOwner, isAdmin: u.isAdmin || false, country: u.country
    }));
    io.to(roomCode).emit('user-list-update', userList);
}

function getVideoLibraryList() {
    const list = [];
    videoLibrary.forEach((v, id) => {
        list.push({
            id, title: v.title, url: v.url, thumbnail: v.thumbnail, fileId: v.fileId,
            uploadedBy: v.uploadedBy, uploadedAt: v.uploadedAt, expiresAt: v.expiresAt,
            timeRemaining: Math.max(0, Math.floor((v.expiresAt - Date.now()) / 1000))
        });
    });
    return list.sort((a, b) => b.uploadedAt - a.uploadedAt);
}

function addRoomVisitor(roomCode, user) {
    if (!roomVisitors.has(roomCode)) roomVisitors.set(roomCode, new Map());
    const visitors = roomVisitors.get(roomCode);
    visitors.set(user.id, { userId: user.id, userName: user.userName, userPhoto: user.userPhoto, lastVisit: Date.now() });
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    visitors.forEach((v, vid) => { if (v.lastVisit < sevenDaysAgo) visitors.delete(vid); });
}

function getRoomVisitors(roomCode) {
    if (!roomVisitors.has(roomCode)) return [];
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    return Array.from(roomVisitors.get(roomCode).values()).filter(v => v.lastVisit >= sevenDaysAgo).sort((a,b)=>b.lastVisit-a.lastVisit);
}

async function sendPushNotification(userId, title, body, data = {}) {
    const sub = pushSubscriptions.get(userId);
    if (!sub) return false;
    try {
        await webpush.sendNotification(sub, JSON.stringify({ title, body, icon: '/icon-192.png', badge: '/badge-72.png', vibrate: [200,100,200], data }));
        return true;
    } catch (e) { if (e.statusCode === 410) pushSubscriptions.delete(userId); return false; }
}

function cleanupRoom(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (room.timeout) clearTimeout(room.timeout);
    room.users.forEach((u, uid) => { users.delete(uid); io.sockets.sockets.get(uid)?.leave(roomCode); });
    rooms.delete(roomCode); messages.delete(roomCode); userStickers.delete(roomCode); securePhotos.delete(roomCode);
}

app.get('/api/health', (req, res) => res.json({ status: 'OK', rooms: rooms.size, users: users.size, videos: videoLibrary.size, adminIp: ADMIN_IP }));
app.get('/api/vapid-public-key', (req, res) => res.json({ publicKey: process.env.VAPID_PUBLIC_KEY }));
app.post('/api/push-subscribe', (req, res) => { pushSubscriptions.set(req.body.userId, req.body.subscription); res.json({ success: true }); });

app.post('/api/upload-video', (req, res) => {
    upload(req, res, async (err) => {
        if (err) return res.status(400).json({ error: err.message });
        try {
            const { title, roomCode, userName, isAdmin } = req.body;
            const file = req.file;
            if (!file) return res.status(400).json({ error: 'Video dosyası gerekli' });
            const expiryHours = isAdmin === 'true' ? 24 * 7 : 24;
            const folder = isAdmin === 'true' ? '/admin_videos' : '/room_videos';
            const result = await new Promise((resolve, reject) => {
                imagekit.upload({
                    file: file.buffer, fileName: file.originalname, folder, useUniqueFileName: true,
                    tags: [roomCode || 'no-room', userName || 'anonymous', isAdmin === 'true' ? 'admin' : 'user']
                }, (error, result) => error ? reject(error) : resolve(result));
            });
            res.json({ success: true, url: result.url, fileId: result.fileId, fileName: result.name, size: result.size, expiresAt: Date.now() + (expiryHours * 60 * 60 * 1000) });
        } catch (error) { res.status(500).json({ error: error.message }); }
    });
});

app.get('/api/videos', (req, res) => res.json(getVideoLibraryList()));

io.on('connection', (socket) => {
    console.log('✅ Yeni kullanıcı bağlandı:', socket.id);
    const clientIp = socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim() || socket.handshake.address;
    const isAdmin = clientIp === ADMIN_IP;
    if (isAdmin) console.log('👑 Admin girişi! IP:', clientIp);

    const pingInterval = setInterval(() => { if (socket.connected) socket.emit('ping', { timestamp: Date.now() }); }, 25000);
    socket.on('pong', (data) => {});

    let currentUser = null, currentRoomCode = null;

    socket.on('recover-session', (data) => {
        try {
            const { userId, deviceId } = data;
            let foundSession = null, foundRoom = null;
            for (const [uid, session] of userSessions.entries()) {
                if (uid === userId || session.deviceId === deviceId) {
                    const room = rooms.get(session.roomCode);
                    if (room) { foundSession = session; foundRoom = room; break; }
                }
            }
            if (foundSession && foundRoom) {
                currentUser = {
                    id: socket.id, userName: foundSession.userName, userPhoto: foundSession.userPhoto || generateDefaultAvatar(foundSession.userName),
                    userColor: generateUserColor(foundSession.userName), deviceId, isOwner: foundRoom.owner === foundSession.userId,
                    isAdmin: foundSession.isAdmin || false, country: 'Türkiye'
                };
                foundRoom.users.set(socket.id, currentUser);
                users.set(socket.id, { roomCode: foundSession.roomCode, ...currentUser });
                currentRoomCode = foundSession.roomCode;
                socket.join(foundSession.roomCode);
                const roomMessages = messages.get(foundSession.roomCode) || [];
                socket.emit('session-recovered', {
                    roomCode: foundRoom.code, roomName: foundRoom.name, isOwner: foundRoom.owner === socket.id,
                    isAdmin: currentUser.isAdmin, previousMessages: roomMessages.slice(-50),
                    activeVideo: foundRoom.video, videoVisible: foundRoom.videoVisible, theme: foundRoom.theme
                });
                socket.to(foundSession.roomCode).emit('user-joined', { userName: currentUser.userName, isAdmin: currentUser.isAdmin });
                updateUserList(foundSession.roomCode);
            }
        } catch (e) { console.error('❌ Oturum kurtarma hatası:', e); }
    });

    socket.on('create-room', (data) => {
        try {
            const { userName, userPhoto, deviceId, roomName, password } = data;
            if (!userName || !roomName) { socket.emit('error', { message: 'Kullanıcı adı ve oda adı gereklidir!' }); return; }
            let roomCode; do { roomCode = generateRoomCode(); } while (rooms.has(roomCode));
            const room = {
                code: roomCode, name: roomName, password: password || null, owner: socket.id, users: new Map(),
                video: null, videoVisible: true, theme: 'dark', playbackState: { playing: false, currentTime: 0, playbackRate: 1 },
                createdAt: new Date(), lastActivity: new Date(), timeout: null, persistent: true
            };
            currentUser = { id: socket.id, userName, userPhoto: userPhoto || generateDefaultAvatar(userName), userColor: generateUserColor(userName), deviceId, isOwner: true, isAdmin, country: 'Türkiye' };
            room.users.set(socket.id, currentUser); rooms.set(roomCode, room); users.set(socket.id, { roomCode, ...currentUser });
            userSessions.set(currentUser.id, { roomCode, userName, userPhoto: currentUser.userPhoto, deviceId, isAdmin, lastSeen: Date.now() });
            addRoomVisitor(roomCode, currentUser);
            currentRoomCode = roomCode; socket.join(roomCode);
            socket.emit('room-created', { roomCode, roomName, isOwner: true, isAdmin, userColor: currentUser.userColor });
            socket.emit('video-library-list', getVideoLibraryList());
            updateUserList(roomCode);
        } catch (e) { console.error('❌ Oda oluşturma hatası:', e); socket.emit('error', { message: 'Oda oluşturulamadı!' }); }
    });

    socket.on('join-room', (data) => {
        try {
            const { roomCode, userName, userPhoto, deviceId, password } = data;
            const room = rooms.get(roomCode.toUpperCase());
            if (!room) { socket.emit('error', { message: 'Oda bulunamadı!' }); return; }
            if (room.password && room.password !== password) { socket.emit('error', { message: 'Şifre yanlış!' }); return; }
            currentUser = { id: socket.id, userName, userPhoto: userPhoto || generateDefaultAvatar(userName), userColor: generateUserColor(userName), deviceId, isOwner: room.owner === socket.id, isAdmin, country: 'Türkiye' };
            room.users.set(socket.id, currentUser); users.set(socket.id, { roomCode, ...currentUser });
            userSessions.set(currentUser.id, { roomCode, userName, userPhoto: currentUser.userPhoto, deviceId, isAdmin, lastSeen: Date.now() });
            addRoomVisitor(roomCode, currentUser);
            currentRoomCode = roomCode; socket.join(roomCode); room.lastActivity = new Date();
            const roomMessages = messages.get(roomCode) || [], roomStickers = userStickers.get(roomCode) || [];
            socket.emit('room-joined', {
                roomCode: room.code, roomName: room.name, isOwner: room.owner === socket.id, isAdmin,
                userColor: currentUser.userColor, previousMessages: roomMessages.slice(-50), activeVideo: room.video,
                videoVisible: room.videoVisible, theme: room.theme, playbackState: room.playbackState, stickers: roomStickers
            });
            socket.emit('video-library-list', getVideoLibraryList());
            socket.to(roomCode).emit('user-joined', { userName: currentUser.userName, isAdmin });
            updateUserList(roomCode);
        } catch (e) { console.error('❌ Odaya katılma hatası:', e); socket.emit('error', { message: 'Odaya katılamadı!' }); }
    });

    socket.on('send-room-invite', async (data) => {
        try {
            if (!currentUser || !currentUser.isOwner) { socket.emit('error', { message: 'Sadece oda sahibi davet gönderebilir!' }); return; }
            const { targetUserId, roomCode, roomName } = data;
            if (!pendingInvites.has(targetUserId)) pendingInvites.set(targetUserId, []);
            const inviteData = { id: Date.now().toString() + Math.random().toString(36).substr(2,5), roomCode, roomName, inviterName: currentUser.userName, inviterPhoto: currentUser.userPhoto, timestamp: Date.now() };
            pendingInvites.get(targetUserId).push(inviteData);
            await sendPushNotification(targetUserId, 'Film İzleme Daveti', `Arkadaşınız ${currentUser.userName} sizi davet ediyor`, { type: 'room-invite', roomCode, inviteId: inviteData.id });
            const targetSocket = io.sockets.sockets.get(targetUserId);
            if (targetSocket) targetSocket.emit('room-invite-received', inviteData);
            socket.emit('invite-sent', { success: true });
        } catch (e) { console.error('❌ Davet hatası:', e); }
    });

    socket.on('accept-invite', (data) => {
        try {
            const { inviteId } = data;
            const invites = pendingInvites.get(socket.id) || [];
            const invite = invites.find(i => i.id === inviteId);
            if (!invite) { socket.emit('error', { message: 'Davet bulunamadı!' }); return; }
            const updated = invites.filter(i => i.id !== inviteId);
            updated.length ? pendingInvites.set(socket.id, updated) : pendingInvites.delete(socket.id);
            socket.emit('join-room-from-invite', { roomCode: invite.roomCode, roomName: invite.roomName });
        } catch (e) { console.error('❌ Davet kabul hatası:', e); }
    });

    socket.on('change-theme', (theme) => { if (!currentRoomCode||!currentUser) return; const r=rooms.get(currentRoomCode); if(r){ r.theme=theme; r.lastActivity=new Date(); io.to(currentRoomCode).emit('theme-changed',theme); } });
    socket.on('upload-video', (d) => { if(!currentRoomCode||!currentUser?.isOwner) return; socket.emit('use-api-upload',{endpoint:'/api/upload-video',roomCode:currentRoomCode,userName:currentUser.userName,isAdmin:false}); });
    socket.on('admin-upload-video', (d) => { if(!currentUser?.isAdmin) return; socket.emit('use-admin-api-upload',{endpoint:'/api/upload-video',roomCode:'library',userName:currentUser.userName,isAdmin:true}); });
    socket.on('video-upload-complete', (d) => {
        const {url,fileId,title,expiresAt,fileSize,isAdmin}=d;
        if(isAdmin){
            const vid='vid_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
            videoLibrary.set(vid,{id:vid,title:title||'Video',url,fileId,uploadedBy:currentUser?.userName||'Admin',uploadedAt:Date.now(),expiresAt,fileName:title});
            io.emit('video-library-updated',getVideoLibraryList());
            socket.emit('admin-upload-success',{message:'Video kütüphaneye eklendi!'});
        }else{
            const r=rooms.get(currentRoomCode); if(!r) return;
            r.video={type:'imagekit',url,fileId,title:title||'Video',uploadedBy:currentUser?.userName||'Kullanıcı',uploadedAt:new Date(),expiresAt,fileSize};
            r.lastActivity=new Date();
            io.to(currentRoomCode).emit('video-uploaded',{videoUrl:url,title:r.video.title,uploadedBy:r.video.uploadedBy,fileSize,expiresAt});
            socket.emit('upload-progress',{status:'completed',progress:100});
        }
    });
    socket.on('play-library-video', (d) => {
        const {videoId,inRoom}=d, v=videoLibrary.get(videoId);
        if(!v){ socket.emit('error',{message:'Video bulunamadı!'}); return; }
        if(inRoom&&currentRoomCode){
            const r=rooms.get(currentRoomCode);
            if(r&&currentUser?.isOwner){
                r.video={type:'imagekit',url:v.url,fileId:v.fileId,title:v.title,uploadedBy:v.uploadedBy,uploadedAt:v.uploadedAt,expiresAt:v.expiresAt,fromLibrary:true};
                r.lastActivity=new Date();
                io.to(currentRoomCode).emit('video-uploaded',{videoUrl:v.url,title:v.title,uploadedBy:v.uploadedBy,fromLibrary:true,timeRemaining:Math.max(0,Math.floor((v.expiresAt-Date.now())/1000))});
            }else socket.emit('error',{message:'Video yansıtmak için oda sahibi olmalısınız!'});
        }else socket.emit('play-pip-video',{url:v.url,title:v.title,expiresAt:v.expiresAt});
    });
    socket.on('admin-delete-video', async (d) => {
        if(!currentUser?.isAdmin){ socket.emit('error',{message:'Bu işlem için admin yetkisi gerekli!'}); return; }
        const {videoId}=d, v=videoLibrary.get(videoId);
        if(!v){ socket.emit('error',{message:'Video bulunamadı!'}); return; }
        imagekit.deleteFile(v.fileId,(e,r)=>{});
        videoLibrary.delete(videoId);
        io.emit('video-library-updated',getVideoLibraryList());
        socket.emit('admin-delete-success',{message:'Video silindi!'});
    });
    socket.on('share-youtube-link', (d) => {
        if(!currentRoomCode||!currentUser?.isOwner) return;
        const {youtubeUrl,title}=d, id=extractYouTubeId(youtubeUrl), r=rooms.get(currentRoomCode);
        if(!id){ socket.emit('error',{message:'Geçersiz YouTube linki'}); return; }
        r.video={type:'youtube',videoId:id,url:youtubeUrl,title:title||'YouTube Video',uploadedBy:currentUser.userName,uploadedAt:new Date()};
        r.lastActivity=new Date();
        io.to(currentRoomCode).emit('youtube-video-shared',{videoId:id,title:title||'YouTube Video',sharedBy:currentUser.userName});
    });
    socket.on('video-control', (c) => { if(!currentRoomCode||!currentUser) return; const r=rooms.get(currentRoomCode); if(r){ r.playbackState=c; r.lastActivity=new Date(); } if(currentUser.isOwner) socket.to(currentRoomCode).emit('video-control',c); });
    socket.on('youtube-control', (c) => { if(!currentRoomCode||!currentUser?.isOwner) return; const r=rooms.get(currentRoomCode); if(r) r.lastActivity=new Date(); socket.to(currentRoomCode).emit('youtube-control',c); });
    socket.on('delete-video', async () => {
        if(!currentRoomCode||!currentUser?.isOwner) return;
        const r=rooms.get(currentRoomCode);
        if(r.video?.type==='imagekit'&&r.video.fileId&&!r.video.fromLibrary) imagekit.deleteFile(r.video.fileId,(e,r)=>{});
        r.video=null; r.playbackState={playing:false,currentTime:0,playbackRate:1}; r.lastActivity=new Date();
        io.to(currentRoomCode).emit('video-deleted');
    });
    socket.on('toggle-video-visibility', () => { if(!currentRoomCode||!currentUser?.isOwner) return; const r=rooms.get(currentRoomCode); if(!r) return; r.videoVisible=!r.videoVisible; r.lastActivity=new Date(); io.to(currentRoomCode).emit('video-visibility-changed',{visible:r.videoVisible}); });
    socket.on('message', (m) => {
        if(!currentRoomCode||!currentUser) return;
        const r=rooms.get(currentRoomCode); if(r) r.lastActivity=new Date();
        const msg={id:Date.now().toString()+Math.random().toString(36).substr(2,5),userName:currentUser.userName,userPhoto:currentUser.userPhoto,userColor:currentUser.userColor,text:m.text,type:m.type||'text',fileUrl:m.fileUrl,fileName:m.fileName,fileSize:m.fileSize,reactions:m.reactions||[],isEmergency:m.isEmergency||false,isSecure:m.isSecure||false,secureId:m.secureId||null,replyTo:m.replyTo||null,time:new Date().toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'}),country:currentUser.country,timestamp:new Date()};
        if(msg.isSecure&&msg.secureId){
            if(!securePhotos.has(currentRoomCode)) securePhotos.set(currentRoomCode,[]);
            securePhotos.get(currentRoomCode).push({id:msg.secureId,imageUrl:msg.fileUrl,createdBy:currentUser.userName,createdAt:new Date(),expiresAt:Date.now()+30000});
            setTimeout(()=>{ const p=securePhotos.get(currentRoomCode)||[], i=p.findIndex(x=>x.id===msg.secureId); if(i!==-1) p.splice(i,1); },30000);
        }
        const rm=messages.get(currentRoomCode)||[]; rm.push(msg); messages.set(currentRoomCode,rm.slice(-200));
        io.to(currentRoomCode).emit('message',msg);
    });
    socket.on('view-secure-photo', (d) => {
        if(!currentRoomCode||!currentUser) return;
        const {secureId}=d, p=(securePhotos.get(currentRoomCode)||[]).find(x=>x.id===secureId);
        if(p){ socket.emit('secure-photo-view',{secureId,imageUrl:p.imageUrl,expiresAt:Date.now()+20000}); }else socket.emit('error',{message:'Fotoğraf bulunamadı veya süresi doldu!'});
    });
    socket.on('delete-message', (d) => {
        if(!currentRoomCode||!currentUser) return;
        const {messageId}=d, rm=messages.get(currentRoomCode)||[], i=rm.findIndex(m=>m.id===messageId);
        if(i!==-1&&rm[i].userName===currentUser.userName){ rm.splice(i,1); messages.set(currentRoomCode,rm); io.to(currentRoomCode).emit('message-deleted',{messageId}); }
    });
    socket.on('add-reaction', (d) => {
        if(!currentRoomCode||!currentUser) return;
        const {messageId,reaction}=d, rm=messages.get(currentRoomCode)||[], i=rm.findIndex(m=>m.id===messageId);
        if(i!==-1){ const m=rm[i]; if(!m.reactions) m.reactions=[]; const ei=m.reactions.findIndex(r=>r.userName===currentUser.userName&&r.emoji===reaction);
            if(ei!==-1) m.reactions.splice(ei,1); else{ const ui=m.reactions.findIndex(r=>r.userName===currentUser.userName); if(ui!==-1) m.reactions.splice(ui,1); m.reactions.push({userName:currentUser.userName,emoji:reaction,timestamp:new Date()}); }
            messages.set(currentRoomCode,rm); io.to(currentRoomCode).emit('reaction-updated',{messageId,reactions:m.reactions}); }
    });
    socket.on('emergency-alert', () => { if(!currentRoomCode) return; console.log(`🚨 ACİL DURUM! Oda siliniyor: ${currentRoomCode}`); const r=rooms.get(currentRoomCode); io.to(currentRoomCode).emit('emergency-message',{userName:currentUser?.userName}); cleanupRoom(currentRoomCode); });
    socket.on('save-stickers', (d) => { if(!currentRoomCode||!currentUser) return; const {stickers}=d, rs=userStickers.get(currentRoomCode)||[]; stickers.forEach(s=>{ rs.push({id:Date.now().toString()+Math.random().toString(36).substr(2,5),imageUrl:s.imageUrl,createdBy:currentUser.userName,createdAt:new Date()}); }); userStickers.set(currentRoomCode,rs.slice(-50)); io.to(currentRoomCode).emit('stickers-updated',{stickers:rs}); });
    socket.on('send-sticker', (d) => {
        if(!currentRoomCode||!currentUser) return;
        const {stickerId,imageUrl}=d, msg={id:Date.now().toString()+Math.random().toString(36).substr(2,5),userName:currentUser.userName,userPhoto:currentUser.userPhoto,userColor:currentUser.userColor,type:'sticker',stickerId,stickerUrl:imageUrl,reactions:[],time:new Date().toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'}),country:currentUser.country,timestamp:new Date()};
        const rm=messages.get(currentRoomCode)||[]; rm.push(msg); messages.set(currentRoomCode,rm.slice(-200)); io.to(currentRoomCode).emit('message',msg);
    });
    socket.on('disconnect', (r) => {
        console.log('🔌 Kullanıcı ayrıldı:', socket.id, 'Sebep:', r);
        clearInterval(pingInterval);
        if(currentUser&&currentRoomCode){
            const room=rooms.get(currentRoomCode);
            if(room){
                room.users.delete(socket.id); users.delete(socket.id);
                socket.to(currentRoomCode).emit('user-left',{userName:currentUser.userName});
                updateUserList(currentRoomCode);
                if(room.users.size===0&&room.persistent) room.timeout=setTimeout(()=>{ if(room.users.size===0) cleanupRoom(currentRoomCode); },60*60*1000);
            }
        }
    });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SERVER ${PORT} PORTUNDA ÇALIŞIYOR`);
    console.log(`👑 Admin IP: ${ADMIN_IP}`);
    console.log(`✅ Tüm özellikler aktif!`);
});
