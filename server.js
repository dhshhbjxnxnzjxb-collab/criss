const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const ImageKit = require('imagekit');
const CronJob = require('cron').CronJob;
const webpush = require('web-push');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

// ImageKit.io Konfigürasyonu
const imagekit = new ImageKit({
    publicKey: process.env.IMAGEKIT_PUBLIC_KEY || 'public_mfwvdT7bS9kxwL5YpRv5YY9/W4Q=',
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY || 'private_jgXy2tt8CCzfQoR6bN3y/KfWjtE=',
    urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || 'https://ik.imagekit.io/5v8xlfyfa'
});

// Web Push Configuration
webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || 'crissahahhaha@gmail.com'}`,
    process.env.VAPID_PUBLIC_KEY || 'BADZTZNjcII3XZYWlPMOTK9ZXIizO6mepKYEhikDJS19eVRFSUinzjTzsR3gvI6w3gKYVvYSYVjRo3GG2vkTkww',
    process.env.VAPID_PRIVATE_KEY || 'SGNURFf_j_KkquqBxoSSVIkWpmTtBl1tPG-O3qL0cAQ'
);

// BELLEK TABANLI SİSTEM
const rooms = new Map();          // Aktif odalar
const users = new Map();          // Aktif kullanıcılar
const messages = new Map();       // Oda mesajları
const userStickers = new Map();   // Çıkartmalar
const securePhotos = new Map();   // Güvenli fotoğraflar
const videoLibrary = new Map();   // Admin videoları (odadan bağımsız)
const userSessions = new Map();   // Kullanıcı oturumları
const roomVisitors = new Map();   // Oda ziyaretçi geçmişi
const pushSubscriptions = new Map(); // Push bildirimleri
const pendingInvites = new Map(); // Bekleyen davetler

// ADMIN IP ADRESİ (Kendi IP'nizi yazın)
const ADMIN_IP = process.env.ADMIN_IP || '151.250.12.70';

// RENDER UYKU MODU ENGELLEME
setInterval(() => {
    const https = require('https');
    const http = require('http');
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    
    const protocol = url.startsWith('https') ? https : http;
    
    protocol.get(`${url}/api/health`, (res) => {
        console.log('💓 Self-ping - Server awake:', new Date().toLocaleTimeString());
    }).on('error', (err) => {
        console.log('Self-ping error:', err.message);
    });
}, 60 * 1000);

// VIDEO KÜTÜPHANESİ TEMİZLEME - Her saat başı kontrol
const cleanupJob = new CronJob('0 * * * *', async () => {
    console.log('🧹 Video kütüphanesi temizleniyor...');
    const now = Date.now();
    const expiredVideos = [];
    
    videoLibrary.forEach((video, videoId) => {
        if (video.expiresAt < now) {
            expiredVideos.push(videoId);
            imagekit.deleteFile(video.fileId, (error, result) => {
                if (error) console.error('❌ ImageKit silme hatası:', error);
                else console.log(`✅ ImageKit'ten silindi: ${video.fileName}`);
            });
        }
    });
    
    expiredVideos.forEach(id => videoLibrary.delete(id));
    console.log(`✅ ${expiredVideos.length} video temizlendi`);
    
    io.emit('video-library-updated', getVideoLibraryList());
});

cleanupJob.start();

// Socket.io configuration
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 5 * 1024 * 1024 * 1024,
    pingTimeout: 120000,
    pingInterval: 25000
});

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true,
    optionsSuccessStatus: 200
}));
app.use(express.json({ limit: '5gb' }));
app.use(express.urlencoded({ extended: true, limit: '5gb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer config
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { 
        fileSize: 5 * 1024 * 1024 * 1024,
        fieldSize: 5 * 1024 * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
        console.log('📁 Gelen dosya:', file.originalname, file.mimetype);
        if (file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Sadece video dosyaları yüklenebilir!'));
        }
    }
}).single('video');

// Yardımcı fonksiyonlar
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function generateUserColor(username) {
    const colors = ['#405DE6', '#5851DB', '#833AB4', '#C13584', '#E1306C', '#FD1D1D', '#F56040', '#F77737', '#FCAF45', '#FFDC80'];
    const index = username ? username.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) : 0;
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
    
    const userList = Array.from(room.users.values()).map(user => ({
        id: user.id,
        userName: user.userName,
        userPhoto: user.userPhoto,
        userColor: user.userColor,
        isOwner: user.isOwner,
        isAdmin: user.isAdmin || false,
        country: user.country
    }));
    
    io.to(roomCode).emit('user-list-update', userList);
}

function getVideoLibraryList() {
    const list = [];
    videoLibrary.forEach((video, id) => {
        list.push({
            id: id,
            title: video.title,
            url: video.url,
            thumbnail: video.thumbnail,
            fileId: video.fileId,
            uploadedBy: video.uploadedBy,
            uploadedAt: video.uploadedAt,
            expiresAt: video.expiresAt,
            timeRemaining: Math.max(0, Math.floor((video.expiresAt - Date.now()) / 1000))
        });
    });
    return list.sort((a, b) => b.uploadedAt - a.uploadedAt);
}

function addRoomVisitor(roomCode, user) {
    if (!roomVisitors.has(roomCode)) {
        roomVisitors.set(roomCode, new Map());
    }
    
    const visitors = roomVisitors.get(roomCode);
    visitors.set(user.id, {
        userId: user.id,
        userName: user.userName,
        userPhoto: user.userPhoto,
        lastVisit: Date.now()
    });
    
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    visitors.forEach((visitor, visitorId) => {
        if (visitor.lastVisit < sevenDaysAgo) {
            visitors.delete(visitorId);
        }
    });
}

function getRoomVisitors(roomCode) {
    if (!roomVisitors.has(roomCode)) return [];
    
    const visitors = roomVisitors.get(roomCode);
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    
    return Array.from(visitors.values())
        .filter(v => v.lastVisit >= sevenDaysAgo)
        .sort((a, b) => b.lastVisit - a.lastVisit);
}

async function sendPushNotification(userId, title, body, data = {}) {
    const subscription = pushSubscriptions.get(userId);
    if (!subscription) return false;
    
    const payload = JSON.stringify({
        title: title,
        body: body,
        icon: '/icon-192.png',
        badge: '/badge-72.png',
        vibrate: [200, 100, 200],
        data: data
    });
    
    try {
        await webpush.sendNotification(subscription, payload);
        return true;
    } catch (error) {
        console.error('❌ Push notification hatası:', error);
        if (error.statusCode === 410) {
            pushSubscriptions.delete(userId);
        }
        return false;
    }
}

function cleanupRoom(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    
    console.log(`🧹 Oda temizleniyor: ${roomCode}`);
    
    if (room.timeout) {
        clearTimeout(room.timeout);
    }
    
    room.users.forEach((user, uid) => {
        users.delete(uid);
        io.sockets.sockets.get(uid)?.leave(roomCode);
    });
    
    rooms.delete(roomCode);
    messages.delete(roomCode);
    userStickers.delete(roomCode);
    securePhotos.delete(roomCode);
    
    console.log(`✅ Oda temizlendi: ${roomCode}`);
}

// API Routes
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        rooms: rooms.size,
        users: users.size,
        videos: videoLibrary.size,
        sessions: userSessions.size,
        uptime: process.uptime(),
        adminIp: ADMIN_IP,
        clientIp: req.headers['x-forwarded-for'] || req.socket.remoteAddress
    });
});

app.get('/api/vapid-public-key', (req, res) => {
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || 'BADZTZNjcII3XZYWlPMOTK9ZXIizO6mepKYEhikDJS19eVRFSUinzjTzsR3gvI6w3gKYVvYSYVjRo3GG2vkTkww' });
});

app.post('/api/push-subscribe', (req, res) => {
    try {
        const { userId, subscription } = req.body;
        pushSubscriptions.set(userId, subscription);
        console.log(`✅ Push subscription kaydedildi: ${userId}`);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Push subscription hatası:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/upload-video', (req, res) => {
    console.log('🔥 UPLOAD API ÇAĞRILDI!');
    
    upload(req, res, async (err) => {
        if (err) {
            console.error('❌ MULTER HATASI:', err);
            return res.status(400).json({ error: err.message });
        }
        
        try {
            const { title, roomCode, userName, isAdmin } = req.body;
            const file = req.file;
            
            if (!file) {
                return res.status(400).json({ error: 'Video dosyası gerekli' });
            }
            
            console.log(`📤 Video yükleniyor: ${title} - ${file.size} bytes`);
            
            const expiryHours = isAdmin === 'true' ? 24 * 7 : 24;
            const folder = isAdmin === 'true' ? '/admin_videos' : '/room_videos';
            
            const result = await new Promise((resolve, reject) => {
                imagekit.upload({
                    file: file.buffer,
                    fileName: file.originalname,
                    folder: folder,
                    useUniqueFileName: true,
                    tags: [roomCode || 'no-room', userName || 'anonymous', isAdmin === 'true' ? 'admin' : 'user'],
                    responseFields: ['fileId', 'name', 'url', 'thumbnail', 'size', 'filePath']
                }, (error, result) => {
                    if (error) reject(error);
                    else resolve(result);
                });
            });
            
            console.log(`✅ ImageKit'e yüklendi: ${result.name}`);
            
            res.json({
                success: true,
                url: result.url,
                fileId: result.fileId,
                fileName: result.name,
                filePath: result.filePath,
                thumbnail: result.thumbnail,
                size: result.size,
                expiresAt: Date.now() + (expiryHours * 60 * 60 * 1000)
            });
            
        } catch (error) {
            console.error('❌ API yükleme hatası:', error);
            res.status(500).json({ error: error.message });
        }
    });
});

app.get('/api/videos', (req, res) => {
    res.json(getVideoLibraryList());
});

app.get('/api/room/:code', (req, res) => {
    try {
        const room = rooms.get(req.params.code);
        if (!room) {
            return res.status(404).json({ error: 'Oda bulunamadı' });
        }
        
        res.json({
            code: room.code,
            name: room.name,
            userCount: room.users.size,
            createdAt: room.createdAt,
            lastActivity: room.lastActivity,
            joinUrl: `${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}?room=${room.code}`
        });
    } catch (error) {
        res.status(500).json({ error: 'Oda bilgisi alınamadı' });
    }
});

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('✅ Yeni kullanıcı bağlandı:', socket.id);
    
    let clientIp = socket.handshake.address;
    const forwardedFor = socket.handshake.headers['x-forwarded-for'];
    if (forwardedFor) {
        clientIp = forwardedFor.split(',')[0].trim();
    }
    
    const isAdmin = clientIp === ADMIN_IP;
    
    if (isAdmin) {
        console.log('👑 Admin girişi yapıldı! IP:', clientIp);
    }

    const pingInterval = setInterval(() => {
        if (socket.connected) {
            socket.emit('ping', { timestamp: Date.now() });
        }
    }, 25000);

    socket.on('pong', (data) => {});

    let currentUser = null;
    let currentRoomCode = null;

    socket.on('server-ping', (data) => {
        socket.emit('pong', { timestamp: Date.now() });
    });

    // Oturum kurtarma
    socket.on('recover-session', (data) => {
        try {
            const { userId, deviceId } = data;
            const session = userSessions.get(userId);
            
            if (session && session.roomCode) {
                const room = rooms.get(session.roomCode);
                if (room) {
                    currentUser = {
                        id: socket.id,
                        userName: session.userName,
                        userPhoto: session.userPhoto || generateDefaultAvatar(session.userName),
                        userColor: generateUserColor(session.userName),
                        deviceId: deviceId,
                        isOwner: room.owner === session.userId,
                        isAdmin: session.isAdmin || false,
                        country: 'Türkiye'
                    };
                    
                    room.users.set(socket.id, currentUser);
                    users.set(socket.id, { roomCode: session.roomCode, ...currentUser });
                    currentRoomCode = session.roomCode;
                    socket.join(session.roomCode);
                    
                    socket.emit('session-recovered', {
                        roomCode: room.code,
                        roomName: room.name,
                        isOwner: room.owner === socket.id,
                        isAdmin: currentUser.isAdmin
                    });
                    
                    updateUserList(session.roomCode);
                    console.log(`🔄 Oturum kurtarıldı: ${session.userName} -> ${session.roomCode}`);
                }
            }
        } catch (error) {
            console.error('❌ Oturum kurtarma hatası:', error);
        }
    });

    // Oda oluşturma
    socket.on('create-room', (data) => {
        try {
            const { userName, userPhoto, deviceId, roomName, password } = data;
            
            if (!userName || !roomName) {
                socket.emit('error', { message: 'Kullanıcı adı ve oda adı gereklidir!' });
                return;
            }
            
            let roomCode;
            do {
                roomCode = generateRoomCode();
            } while (rooms.has(roomCode));
            
            const room = {
                code: roomCode,
                name: roomName,
                password: password || null,
                owner: socket.id,
                users: new Map(),
                video: null,
                videoVisible: true,
                theme: 'dark',
                playbackState: {
                    playing: false,
                    currentTime: 0,
                    playbackRate: 1
                },
                messages: [],
                createdAt: new Date(),
                lastActivity: new Date(),
                timeout: null,
                persistent: true
            };
            
            currentUser = {
                id: socket.id,
                userName: userName,
                userPhoto: userPhoto || generateDefaultAvatar(userName),
                userColor: generateUserColor(userName),
                deviceId: deviceId,
                isOwner: true,
                isAdmin: isAdmin,
                country: 'Türkiye'
            };
            
            room.users.set(socket.id, currentUser);
            rooms.set(roomCode, room);
            users.set(socket.id, { roomCode, ...currentUser });
            
            userSessions.set(currentUser.id, {
                roomCode: roomCode,
                userName: userName,
                userPhoto: currentUser.userPhoto,
                isAdmin: isAdmin,
                lastSeen: Date.now()
            });
            
            addRoomVisitor(roomCode, currentUser);
            
            currentRoomCode = roomCode;
            socket.join(roomCode);
            
            const shareableLink = `${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}?room=${roomCode}`;
            
            socket.emit('room-created', {
                roomCode: roomCode,
                roomName: roomName,
                isOwner: true,
                isAdmin: isAdmin,
                shareableLink: shareableLink,
                userColor: currentUser.userColor
            });
            
            socket.emit('video-library-list', getVideoLibraryList());
            
            updateUserList(roomCode);
            
            console.log(`✅ Oda oluşturuldu: ${roomCode} - Sahip: ${userName} - Admin: ${isAdmin}`);
            
        } catch (error) {
            console.error('❌ Oda oluşturma hatası:', error);
            socket.emit('error', { message: 'Oda oluşturulamadı!' });
        }
    });

    // Odaya katılma
    socket.on('join-room', (data) => {
        try {
            const { roomCode, userName, userPhoto, deviceId, password } = data;
            const room = rooms.get(roomCode.toUpperCase());
            
            if (!room) {
                socket.emit('error', { message: 'Oda bulunamadı!' });
                return;
            }
            
            if (room.password && room.password !== password) {
                socket.emit('error', { message: 'Şifre yanlış!' });
                return;
            }
            
            currentUser = {
                id: socket.id,
                userName: userName,
                userPhoto: userPhoto || generateDefaultAvatar(userName),
                userColor: generateUserColor(userName),
                deviceId: deviceId,
                isOwner: room.owner === socket.id,
                isAdmin: isAdmin,
                country: 'Türkiye'
            };
            
            room.users.set(socket.id, currentUser);
            users.set(socket.id, { roomCode, ...currentUser });
            
            userSessions.set(currentUser.id, {
                roomCode: roomCode,
                userName: userName,
                userPhoto: currentUser.userPhoto,
                isAdmin: isAdmin,
                lastSeen: Date.now()
            });
            
            addRoomVisitor(roomCode, currentUser);
            
            currentRoomCode = roomCode;
            socket.join(roomCode);
            
            room.lastActivity = new Date();
            
            const roomMessages = messages.get(roomCode) || [];
            const roomStickers = userStickers.get(roomCode) || [];
            const roomSecurePhotos = securePhotos.get(roomCode) || [];
            
            socket.emit('room-joined', {
                roomCode: room.code,
                roomName: room.name,
                isOwner: room.owner === socket.id,
                isAdmin: isAdmin,
                userColor: currentUser.userColor,
                previousMessages: roomMessages.slice(-50),
                activeVideo: room.video,
                videoVisible: room.videoVisible,
                theme: room.theme,
                playbackState: room.playbackState,
                stickers: roomStickers,
                securePhotos: roomSecurePhotos
            });
            
            socket.emit('video-library-list', getVideoLibraryList());
            
            socket.to(roomCode).emit('user-joined', {
                userName: currentUser.userName,
                isAdmin: isAdmin
            });
            
            updateUserList(roomCode);
            
            console.log(`✅ Kullanıcı katıldı: ${userName} -> ${roomCode} - Admin: ${isAdmin}`);
            
        } catch (error) {
            console.error('❌ Odaya katılma hatası:', error);
            socket.emit('error', { message: 'Odaya katılamadı!' });
        }
    });

    // Ziyaretçi listesini al
    socket.on('get-room-visitors', (data) => {
        try {
            if (!currentUser || !currentUser.isOwner) {
                socket.emit('error', { message: 'Sadece oda sahibi geçmiş kullanıcıları görebilir!' });
                return;
            }
            
            const { roomCode } = data;
            const visitors = getRoomVisitors(roomCode);
            
            socket.emit('room-visitors-list', {
                visitors: visitors.filter(v => v.userId !== socket.id)
            });
            
        } catch (error) {
            console.error('❌ Ziyaretçi listesi hatası:', error);
        }
    });

    // Davet gönder
    socket.on('send-room-invite', async (data) => {
        try {
            if (!currentUser || !currentUser.isOwner) {
                socket.emit('error', { message: 'Sadece oda sahibi davet gönderebilir!' });
                return;
            }
            
            const { targetUserId, roomCode, roomName } = data;
            
            if (!pendingInvites.has(targetUserId)) {
                pendingInvites.set(targetUserId, []);
            }
            
            const inviteData = {
                id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                roomCode: roomCode,
                roomName: roomName,
                inviterName: currentUser.userName,
                inviterPhoto: currentUser.userPhoto,
                timestamp: Date.now()
            };
            
            pendingInvites.get(targetUserId).push(inviteData);
            
            const notificationSent = await sendPushNotification(
                targetUserId,
                'Film İzleme Daveti',
                `Arkadaşınız ${currentUser.userName} sizi beraber film izlemeye davet ediyor`,
                {
                    type: 'room-invite',
                    roomCode: roomCode,
                    inviteId: inviteData.id
                }
            );
            
            const targetSocket = io.sockets.sockets.get(targetUserId);
            if (targetSocket) {
                targetSocket.emit('room-invite-received', inviteData);
            }
            
            socket.emit('invite-sent', {
                success: true,
                notificationSent: notificationSent
            });
            
            console.log(`✅ Davet gönderildi: ${currentUser.userName} -> ${targetUserId}`);
            
        } catch (error) {
            console.error('❌ Davet gönderme hatası:', error);
            socket.emit('error', { message: 'Davet gönderilemedi!' });
        }
    });

    // Davet kabul et
    socket.on('accept-invite', (data) => {
        try {
            const { inviteId } = data;
            const invites = pendingInvites.get(socket.id) || [];
            const invite = invites.find(inv => inv.id === inviteId);
            
            if (!invite) {
                socket.emit('error', { message: 'Davet bulunamadı!' });
                return;
            }
            
            const updatedInvites = invites.filter(inv => inv.id !== inviteId);
            if (updatedInvites.length > 0) {
                pendingInvites.set(socket.id, updatedInvites);
            } else {
                pendingInvites.delete(socket.id);
            }
            
            socket.emit('join-room-from-invite', {
                roomCode: invite.roomCode,
                roomName: invite.roomName
            });
            
            console.log(`✅ Davet kabul edildi: ${invite.roomCode}`);
            
        } catch (error) {
            console.error('❌ Davet kabul hatası:', error);
        }
    });

    // Tema değiştirme
    socket.on('change-theme', (theme) => {
        if (!currentRoomCode || !currentUser) return;
        const room = rooms.get(currentRoomCode);
        if (room) {
            room.theme = theme;
            room.lastActivity = new Date();
            io.to(currentRoomCode).emit('theme-changed', theme);
        }
    });

    // Video yükleme
    socket.on('upload-video', (data) => {
        try {
            if (!currentRoomCode || !currentUser || !currentUser.isOwner) {
                socket.emit('error', { message: 'Video yüklemek için oda sahibi olmalısınız' });
                return;
            }
            
            socket.emit('use-api-upload', {
                endpoint: '/api/upload-video',
                roomCode: currentRoomCode,
                userName: currentUser.userName,
                isAdmin: false
            });
            
        } catch (error) {
            console.error('❌ Video yükleme hatası:', error);
            socket.emit('upload-progress', { status: 'error', progress: 0, message: error.message });
        }
    });

    // Admin video yükleme
    socket.on('admin-upload-video', (data) => {
        try {
            if (!currentUser || !currentUser.isAdmin) {
                socket.emit('error', { message: 'Bu işlem için admin yetkisi gerekli!' });
                return;
            }
            
            socket.emit('use-admin-api-upload', {
                endpoint: '/api/upload-video',
                roomCode: 'library',
                userName: currentUser.userName,
                isAdmin: true
            });
            
        } catch (error) {
            console.error('❌ Admin video yükleme hatası:', error);
            socket.emit('admin-upload-progress', { status: 'error', progress: 0, message: error.message });
        }
    });

    // Video yükleme tamamlandı
    socket.on('video-upload-complete', (data) => {
        try {
            const { url, fileId, title, expiresAt, fileSize, isAdmin } = data;
            
            if (isAdmin) {
                const videoId = 'vid_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
                
                videoLibrary.set(videoId, {
                    id: videoId,
                    title: title || 'Video',
                    url: url,
                    fileId: fileId,
                    uploadedBy: currentUser?.userName || 'Admin',
                    uploadedAt: Date.now(),
                    expiresAt: expiresAt,
                    fileName: title
                });
                
                io.emit('video-library-updated', getVideoLibraryList());
                socket.emit('admin-upload-success', { message: 'Video kütüphaneye eklendi!' });
                
            } else {
                const room = rooms.get(currentRoomCode);
                if (!room) return;
                
                const videoData = {
                    type: 'imagekit',
                    url: url,
                    fileId: fileId,
                    title: title || 'Video',
                    uploadedBy: currentUser?.userName || 'Kullanıcı',
                    uploadedAt: new Date(),
                    expiresAt: expiresAt,
                    fileSize: fileSize
                };
                
                room.video = videoData;
                room.lastActivity = new Date();
                
                io.to(currentRoomCode).emit('video-uploaded', {
                    videoUrl: url,
                    title: videoData.title,
                    uploadedBy: videoData.uploadedBy,
                    fileSize: fileSize,
                    expiresAt: expiresAt
                });
                
                socket.emit('upload-progress', { status: 'completed', progress: 100 });
            }
            
        } catch (error) {
            console.error('❌ Video kayıt hatası:', error);
        }
    });

    // Kütüphaneden video oynat
    socket.on('play-library-video', (data) => {
        try {
            const { videoId, inRoom } = data;
            const video = videoLibrary.get(videoId);
            
            if (!video) {
                socket.emit('error', { message: 'Video bulunamadı!' });
                return;
            }
            
            if (inRoom && currentRoomCode) {
                const room = rooms.get(currentRoomCode);
                if (room && currentUser?.isOwner) {
                    room.video = {
                        type: 'imagekit',
                        url: video.url,
                        fileId: video.fileId,
                        title: video.title,
                        uploadedBy: video.uploadedBy,
                        uploadedAt: video.uploadedAt,
                        expiresAt: video.expiresAt,
                        fromLibrary: true
                    };
                    room.lastActivity = new Date();
                    
                    io.to(currentRoomCode).emit('video-uploaded', {
                        videoUrl: video.url,
                        title: video.title,
                        uploadedBy: video.uploadedBy,
                        fromLibrary: true,
                        timeRemaining: Math.max(0, Math.floor((video.expiresAt - Date.now()) / 1000))
                    });
                } else {
                    socket.emit('error', { message: 'Video yansıtmak için oda sahibi olmalısınız!' });
                }
            } else {
                socket.emit('play-pip-video', {
                    url: video.url,
                    title: video.title,
                    expiresAt: video.expiresAt
                });
            }
            
        } catch (error) {
            console.error('❌ Video oynatma hatası:', error);
            socket.emit('error', { message: 'Video oynatılamadı!' });
        }
    });

    // Admin video silme
    socket.on('admin-delete-video', async (data) => {
        try {
            if (!currentUser || !currentUser.isAdmin) {
                socket.emit('error', { message: 'Bu işlem için admin yetkisi gerekli!' });
                return;
            }
            
            const { videoId } = data;
            const video = videoLibrary.get(videoId);
            
            if (!video) {
                socket.emit('error', { message: 'Video bulunamadı!' });
                return;
            }
            
            imagekit.deleteFile(video.fileId, (error, result) => {
                if (error) console.error('❌ ImageKit silme hatası:', error);
            });
            
            videoLibrary.delete(videoId);
            io.emit('video-library-updated', getVideoLibraryList());
            socket.emit('admin-delete-success', { message: 'Video silindi!' });
            
        } catch (error) {
            console.error('❌ Video silme hatası:', error);
            socket.emit('error', { message: 'Video silinemedi!' });
        }
    });

    // YouTube video paylaşma
    socket.on('share-youtube-link', (data) => {
        try {
            if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
            
            const { youtubeUrl, title } = data;
            const videoId = extractYouTubeId(youtubeUrl);
            const room = rooms.get(currentRoomCode);
            
            if (!videoId) {
                socket.emit('error', { message: 'Geçersiz YouTube linki' });
                return;
            }
            
            room.video = {
                type: 'youtube',
                videoId: videoId,
                url: youtubeUrl,
                title: title || 'YouTube Video',
                uploadedBy: currentUser.userName,
                uploadedAt: new Date()
            };
            room.lastActivity = new Date();
            
            io.to(currentRoomCode).emit('youtube-video-shared', {
                videoId: videoId,
                title: title || 'YouTube Video',
                sharedBy: currentUser.userName
            });
            
        } catch (error) {
            console.error('❌ YouTube video paylaşma hatası:', error);
            socket.emit('error', { message: 'YouTube video paylaşılamadı!' });
        }
    });

    // Video kontrolü
    socket.on('video-control', (controlData) => {
        if (!currentRoomCode || !currentUser) return;
        
        const room = rooms.get(currentRoomCode);
        if (room) {
            room.playbackState = controlData;
            room.lastActivity = new Date();
        }
        
        if (!currentUser.isOwner) return;
        
        socket.to(currentRoomCode).emit('video-control', controlData);
    });

    // YouTube kontrolü
    socket.on('youtube-control', (controlData) => {
        if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
        const room = rooms.get(currentRoomCode);
        if (room) room.lastActivity = new Date();
        socket.to(currentRoomCode).emit('youtube-control', controlData);
    });

    // Video silme
    socket.on('delete-video', async () => {
        if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
        
        const room = rooms.get(currentRoomCode);
        
        if (room.video && room.video.type === 'imagekit' && room.video.fileId) {
            try {
                if (!room.video.fromLibrary) {
                    imagekit.deleteFile(room.video.fileId, (error, result) => {
                        if (error) console.error('❌ ImageKit video silme hatası:', error);
                    });
                }
            } catch (error) {
                console.error('❌ ImageKit video silme hatası:', error);
            }
        }
        
        room.video = null;
        room.playbackState = {
            playing: false,
            currentTime: 0,
            playbackRate: 1
        };
        room.lastActivity = new Date();
        
        io.to(currentRoomCode).emit('video-deleted');
    });

    // Video görünürlüğünü değiştir
    socket.on('toggle-video-visibility', () => {
        try {
            if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
            
            const room = rooms.get(currentRoomCode);
            if (!room) return;
            
            room.videoVisible = !room.videoVisible;
            room.lastActivity = new Date();
            
            io.to(currentRoomCode).emit('video-visibility-changed', {
                visible: room.videoVisible
            });
            
        } catch (error) {
            console.error('❌ Video görünürlük hatası:', error);
        }
    });

    // Mesaj gönderme (reply destekli)
    socket.on('message', (messageData) => {
        try {
            if (!currentRoomCode || !currentUser) return;
            
            const room = rooms.get(currentRoomCode);
            if (room) room.lastActivity = new Date();
            
            const message = {
                id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                userName: currentUser.userName,
                userPhoto: currentUser.userPhoto,
                userColor: currentUser.userColor,
                text: messageData.text,
                type: messageData.type || 'text',
                fileUrl: messageData.fileUrl,
                fileName: messageData.fileName,
                fileSize: messageData.fileSize,
                reactions: messageData.reactions || [],
                isEmergency: messageData.isEmergency || false,
                isSecure: messageData.isSecure || false,
                secureId: messageData.secureId || null,
                replyTo: messageData.replyTo || null, // Yanıtlanan mesaj
                time: new Date().toLocaleTimeString('tr-TR', { 
                    hour: '2-digit', 
                    minute: '2-digit' 
                }),
                country: currentUser.country,
                timestamp: new Date()
            };
            
            const roomMessages = messages.get(currentRoomCode) || [];
            roomMessages.push(message);
            
            if (roomMessages.length > 200) {
                messages.set(currentRoomCode, roomMessages.slice(-200));
            } else {
                messages.set(currentRoomCode, roomMessages);
            }
            
            io.to(currentRoomCode).emit('message', message);
            
        } catch (error) {
            console.error('❌ Mesaj gönderme hatası:', error);
        }
    });

    // Güvenli fotoğraf görüntüleme
    socket.on('view-secure-photo', (data) => {
        try {
            if (!currentRoomCode || !currentUser) return;
            
            const { secureId } = data;
            const roomSecurePhotos = securePhotos.get(currentRoomCode) || [];
            const photo = roomSecurePhotos.find(p => p.id === secureId);
            
            if (photo) {
                io.to(currentRoomCode).emit('secure-photo-view', {
                    secureId: secureId,
                    imageUrl: photo.imageUrl,
                    viewerName: currentUser.userName,
                    expiresAt: Date.now() + 20000
                });
            }
            
        } catch (error) {
            console.error('❌ Güvenli fotoğraf görüntüleme hatası:', error);
        }
    });

    // Mesaj silme
    socket.on('delete-message', (data) => {
        try {
            if (!currentRoomCode || !currentUser) return;
            
            const { messageId } = data;
            const roomMessages = messages.get(currentRoomCode) || [];
            
            const messageIndex = roomMessages.findIndex(m => m.id === messageId);
            if (messageIndex !== -1) {
                const message = roomMessages[messageIndex];
                
                if (message.userName === currentUser.userName) {
                    roomMessages.splice(messageIndex, 1);
                    messages.set(currentRoomCode, roomMessages);
                    
                    io.to(currentRoomCode).emit('message-deleted', {
                        messageId: messageId
                    });
                }
            }
            
        } catch (error) {
            console.error('❌ Mesaj silme hatası:', error);
        }
    });

    // Mesaja tepki ekleme
    socket.on('add-reaction', (data) => {
        try {
            if (!currentRoomCode || !currentUser) return;
            
            const { messageId, reaction } = data;
            const roomMessages = messages.get(currentRoomCode) || [];
            
            const messageIndex = roomMessages.findIndex(m => m.id === messageId);
            if (messageIndex !== -1) {
                const message = roomMessages[messageIndex];
                
                if (!message.reactions) message.reactions = [];
                
                const existingIndex = message.reactions.findIndex(
                    r => r.userName === currentUser.userName && r.emoji === reaction
                );
                
                if (existingIndex !== -1) {
                    message.reactions.splice(existingIndex, 1);
                } else {
                    const userReactionIndex = message.reactions.findIndex(
                        r => r.userName === currentUser.userName
                    );
                    if (userReactionIndex !== -1) {
                        message.reactions.splice(userReactionIndex, 1);
                    }
                    
                    message.reactions.push({
                        userName: currentUser.userName,
                        emoji: reaction,
                        timestamp: new Date()
                    });
                }
                
                messages.set(currentRoomCode, roomMessages);
                
                io.to(currentRoomCode).emit('reaction-updated', {
                    messageId: messageId,
                    reactions: message.reactions
                });
            }
            
        } catch (error) {
            console.error('❌ Tepki ekleme hatası:', error);
        }
    });

    // Acil durum
    socket.on('emergency-alert', () => {
        try {
            if (!currentRoomCode) return;
            console.log(`🚨 ACİL DURUM! Oda siliniyor: ${currentRoomCode}`);
            const room = rooms.get(currentRoomCode);
            io.to(currentRoomCode).emit('emergency-message', {
                userName: currentUser?.userName
            });
            cleanupRoom(currentRoomCode);
        } catch (error) {
            console.error('❌ Acil durum butonu hatası:', error);
        }
    });

    // Çıkartma kaydetme
    socket.on('save-stickers', (data) => {
        try {
            if (!currentRoomCode || !currentUser) return;
            
            const { stickers } = data;
            
            let roomStickers = userStickers.get(currentRoomCode) || [];
            
            stickers.forEach(sticker => {
                roomStickers.push({
                    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                    imageUrl: sticker.imageUrl,
                    createdBy: currentUser.userName,
                    createdAt: new Date()
                });
            });
            
            if (roomStickers.length > 50) {
                roomStickers = roomStickers.slice(-50);
            }
            
            userStickers.set(currentRoomCode, roomStickers);
            
            io.to(currentRoomCode).emit('stickers-updated', {
                stickers: roomStickers
            });
            
        } catch (error) {
            console.error('❌ Çıkartma kaydetme hatası:', error);
        }
    });

    // Çıkartma gönderme
    socket.on('send-sticker', (data) => {
        try {
            if (!currentRoomCode || !currentUser) return;
            
            const { stickerId, imageUrl } = data;
            
            const message = {
                id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                userName: currentUser.userName,
                userPhoto: currentUser.userPhoto,
                userColor: currentUser.userColor,
                type: 'sticker',
                stickerId: stickerId,
                stickerUrl: imageUrl,
                reactions: [],
                time: new Date().toLocaleTimeString('tr-TR', { 
                    hour: '2-digit', 
                    minute: '2-digit' 
                }),
                country: currentUser.country,
                timestamp: new Date()
            };
            
            const roomMessages = messages.get(currentRoomCode) || [];
            roomMessages.push(message);
            
            if (roomMessages.length > 200) {
                messages.set(currentRoomCode, roomMessages.slice(-200));
            } else {
                messages.set(currentRoomCode, roomMessages);
            }
            
            io.to(currentRoomCode).emit('message', message);
            
        } catch (error) {
            console.error('❌ Çıkartma gönderme hatası:', error);
        }
    });

    // Bağlantı kesildiğinde
    socket.on('disconnect', (reason) => {
        console.log('🔌 Kullanıcı ayrıldı:', socket.id, 'Sebep:', reason);
        
        clearInterval(pingInterval);
        
        if (currentUser && currentRoomCode) {
            const room = rooms.get(currentRoomCode);
            if (room) {
                room.users.delete(socket.id);
                users.delete(socket.id);
                
                socket.to(currentRoomCode).emit('user-left', {
                    userName: currentUser.userName
                });
                
                updateUserList(currentRoomCode);
                
                if (room.users.size === 0 && room.persistent) {
                    console.log(`⏳ Oda boş, 1 saat içinde kimse katılmazsa silinecek: ${currentRoomCode}`);
                    room.timeout = setTimeout(() => {
                        if (room.users.size === 0) {
                            cleanupRoom(currentRoomCode);
                        }
                    }, 60 * 60 * 1000);
                }
            }
        }
    });
});

// Static files
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SERVER ${PORT} PORTUNDA ÇALIŞIYOR`);
    console.log(`📸 TÜM ÖZELLİKLER AKTİF:`);
    console.log(`   ✅ Oda Oluşturma/Katılma`);
    console.log(`   ✅ Video Yükleme (5GB - ImageKit.io)`);
    console.log(`   ✅ YouTube Paylaşımı`);
    console.log(`   ✅ Instagram UI Sohbet`);
    console.log(`   ✅ Ses Kaydı & Fotoğraf`);
    console.log(`   ✅ Çıkartma Sistemi`);
    console.log(`   ✅ Mesaj Yanıtlama`);
    console.log(`   ✅ Mesaj Geri Çekme`);
    console.log(`   ✅ Hızlı Tepkiler (❤️💋🖕😘💞)`);
    console.log(`   🚨 Acil Durum Butonu`);
    console.log(`   🎬 Video Bölümü Aç/Kapat`);
    console.log(`   🔒 Güvenli Fotoğraf (20 saniye)`);
    console.log(`   🍔 Hamburger Menü`);
    console.log(`   📚 Video Kütüphanesi`);
    console.log(`   📌 Picture-in-Picture Video`);
    console.log(`   🔄 Oturum Kurtarma`);
    console.log(`   👥 Oda Ziyaretçi Geçmişi`);
    console.log(`   💌 Davet Sistemi`);
    console.log(`   🔔 Push Bildirimleri`);
    console.log(`   👑 Admin IP: ${ADMIN_IP}`);
    console.log(`   ⏰ Admin:7gün, Normal:1gün`);
});
