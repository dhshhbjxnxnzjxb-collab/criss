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

// 🔐 VAPID Keys for Push Notifications
const vapidKeys = {
    publicKey: 'BAdXfKpJqW8QkQZxY3N4m5n6o7p8q9r0s1t2u3v4w5x6y7z8A9B0C1D2E3F4G5H6I7J8K9L0M',
    privateKey: 'XfKpJqW8QkQZxY3N4m5n6o7p8q9r0s1t2u3v4w5x6y7z8'
};

webpush.setVapidDetails(
    'mailto:iletisim@birlikteizle.com',
    vapidKeys.publicKey,
    vapidKeys.privateKey
);

// 🎯 ImageKit.io Konfigürasyonu
const imagekit = new ImageKit({
    publicKey: process.env.IMAGEKIT_PUBLIC_KEY || 'public_mfwvdT7bS9kxwL5YpRv5YY9/W4Q=',
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY || 'private_jgXy2tt8CCzfQoR6bN3y/KfWjtE=',
    urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || 'https://ik.imagekit.io/5v8xlfyfa'
});

// 📊 VERİTABANI (Bellek içi)
const rooms = new Map();                // Aktif odalar
const users = new Map();                // Aktif kullanıcılar (socket.id -> user)
const messages = new Map();             // Oda mesajları
const userStickers = new Map();          // Çıkartmalar
const securePhotos = new Map();          // Güvenli fotoğraflar
const videoLibrary = new Map();          // Admin videoları (telifsiz)
const roomVideos = new Map();            // Oda içi videolar (geçici)
const deviceRelations = new Map();       // Device ID ilişkileri
const pushSubscriptions = new Map();     // Bildirim abonelikleri
const userProfiles = new Map();          // Kullanıcı profilleri (deviceId -> profile)

// 👑 ADMIN IP
const ADMIN_IP = '151.250.12.70'; // Kendi IP'nle değiştir

// 🔄 Self-ping (Render uyku engelleme)
setInterval(() => {
    const https = require('https');
    const http = require('http');
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(`${url}/api/health`, (res) => {
        console.log('💓 Self-ping:', new Date().toLocaleTimeString());
    }).on('error', (err) => {});
}, 60 * 1000);

// 🧹 Temizlik işleri (her saat)
const cleanupJob = new CronJob('0 * * * *', () => {
    console.log('🧹 Temizlik başladı...');
    
    // Video kütüphanesi temizliği
    const now = Date.now();
    videoLibrary.forEach((video, id) => {
        if (video.expiresAt < now) {
            imagekit.deleteFile(video.fileId, () => {});
            videoLibrary.delete(id);
        }
    });
    
    // Oda videoları temizliği
    roomVideos.forEach((video, id) => {
        if (video.expiresAt < now) {
            imagekit.deleteFile(video.fileId, () => {});
            roomVideos.delete(id);
        }
    });
    
    // Eski bildirim aboneliklerini temizle
    pushSubscriptions.forEach((sub, deviceId) => {
        if (sub.expiresAt < now) {
            pushSubscriptions.delete(deviceId);
        }
    });
    
    console.log(`✅ Temizlik tamamlandı`);
});

cleanupJob.start();

// 🛠️ Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));
app.use(express.json({ limit: '5gb' }));
app.use(express.urlencoded({ extended: true, limit: '5gb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 📁 Multer config
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('video/') || file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Sadece video ve resim dosyaları yüklenebilir!'));
        }
    }
});

// 🔧 Yardımcı fonksiyonlar
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function generateUserColor(username) {
    const colors = ['#405DE6', '#5851DB', '#833AB4', '#C13584', '#E1306C', '#FD1D1D'];
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

function getLibraryList() {
    const list = [];
    videoLibrary.forEach((video, id) => {
        list.push({
            id: id,
            title: video.title,
            url: video.url,
            thumbnail: video.thumbnail,
            uploadedAt: video.uploadedAt,
            timeRemaining: Math.max(0, Math.floor((video.expiresAt - Date.now()) / 1000))
        });
    });
    return list.sort((a, b) => b.uploadedAt - a.uploadedAt);
}

// 📡 Socket.io
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 5 * 1024 * 1024 * 1024,
    pingTimeout: 120000
});

io.on('connection', (socket) => {
    console.log('✅ Yeni bağlantı:', socket.id);
    
    let clientIp = socket.handshake.address;
    const forwardedFor = socket.handshake.headers['x-forwarded-for'];
    if (forwardedFor) clientIp = forwardedFor.split(',')[0].trim();
    
    const isAdmin = clientIp === ADMIN_IP;
    let currentUser = null;
    let currentRoomCode = null;
    let currentDeviceId = null;

    // 📱 Device ID kaydı
    socket.on('register-device', (data) => {
        const { deviceId, userName, userPhoto } = data;
        currentDeviceId = deviceId;
        
        // Profil kaydet
        if (!userProfiles.has(deviceId)) {
            userProfiles.set(deviceId, {
                deviceId,
                userName,
                userPhoto: userPhoto || generateDefaultAvatar(userName),
                firstSeen: Date.now(),
                lastSeen: Date.now(),
                interactions: new Set() // Etkileşim kurulan deviceId'ler
            });
        } else {
            const profile = userProfiles.get(deviceId);
            profile.lastSeen = Date.now();
            profile.userName = userName;
            if (userPhoto) profile.userPhoto = userPhoto;
        }
        
        socket.emit('device-registered', { success: true });
    });

    // 🔔 Bildirim aboneliği
    socket.on('subscribe-push', (data) => {
        const { deviceId, subscription } = data;
        pushSubscriptions.set(deviceId, {
            subscription,
            expiresAt: Date.now() + (30 * 24 * 60 * 60 * 1000) // 30 gün
        });
    });

    // 👥 Etkileşim kaydet
    function recordInteraction(deviceId1, deviceId2) {
        if (!deviceId1 || !deviceId2 || deviceId1 === deviceId2) return;
        
        const profile1 = userProfiles.get(deviceId1);
        const profile2 = userProfiles.get(deviceId2);
        
        if (profile1) profile1.interactions.add(deviceId2);
        if (profile2) profile2.interactions.add(deviceId1);
        
        // Device relations'a ekle
        const key = [deviceId1, deviceId2].sort().join(':');
        deviceRelations.set(key, {
            deviceIds: [deviceId1, deviceId2],
            lastInteraction: Date.now(),
            count: (deviceRelations.get(key)?.count || 0) + 1
        });
    }

    // 📨 Davet gönder
    socket.on('send-invite', async (data) => {
        const { fromDeviceId, toDeviceId, roomCode, roomName, fromUserName } = data;
        
        const subscription = pushSubscriptions.get(toDeviceId);
        if (!subscription) {
            socket.emit('invite-error', { message: 'Kullanıcı bildirimlere açık değil' });
            return;
        }
        
        const payload = JSON.stringify({
            title: '📱 Birlikte İzle Daveti',
            body: `${fromUserName} seni "${roomName}" odasına davet ediyor!`,
            icon: 'https://ik.imagekit.io/5v8xlfyfa/icon.png',
            data: {
                url: `/?room=${roomCode}`,
                roomCode: roomCode
            }
        });
        
        try {
            await webpush.sendNotification(subscription.subscription, payload);
            socket.emit('invite-sent', { success: true });
        } catch (error) {
            console.error('❌ Bildirim gönderilemedi:', error);
            pushSubscriptions.delete(toDeviceId);
        }
    });

    // 👥 Etkileşim listesi
    socket.on('get-interactions', (data) => {
        const { deviceId } = data;
        const profile = userProfiles.get(deviceId);
        
        if (!profile) {
            socket.emit('interactions-list', []);
            return;
        }
        
        const interactions = [];
        profile.interactions.forEach(otherDeviceId => {
            const otherProfile = userProfiles.get(otherDeviceId);
            if (otherProfile) {
                interactions.push({
                    deviceId: otherDeviceId,
                    userName: otherProfile.userName,
                    userPhoto: otherProfile.userPhoto,
                    lastSeen: otherProfile.lastSeen,
                    isOnline: Array.from(users.values()).some(u => u.deviceId === otherDeviceId)
                });
            }
        });
        
        // Son etkileşime göre sırala
        interactions.sort((a, b) => b.lastSeen - a.lastSeen);
        socket.emit('interactions-list', interactions);
    });

    // 🏠 Oda oluştur
    socket.on('create-room', (data) => {
        const { userName, userPhoto, deviceId, roomName, password } = data;
        
        if (!userName || !roomName) {
            socket.emit('error', { message: 'Kullanıcı adı ve oda adı gerekli' });
            return;
        }
        
        let roomCode = generateRoomCode();
        while (rooms.has(roomCode)) roomCode = generateRoomCode();
        
        currentUser = {
            id: socket.id,
            deviceId: deviceId,
            userName: userName,
            userPhoto: userPhoto || generateDefaultAvatar(userName),
            userColor: generateUserColor(userName),
            isOwner: true,
            isAdmin: isAdmin
        };
        
        const room = {
            code: roomCode,
            name: roomName,
            password: password || null,
            owner: socket.id,
            users: new Map([[socket.id, currentUser]]),
            video: null,
            videoVisible: true,
            theme: 'dark',
            createdAt: Date.now(),
            lastActivity: Date.now()
        };
        
        rooms.set(roomCode, room);
        users.set(socket.id, { ...currentUser, roomCode });
        currentRoomCode = roomCode;
        socket.join(roomCode);
        
        socket.emit('room-created', {
            roomCode,
            roomName,
            isOwner: true,
            isAdmin
        });
        
        socket.emit('video-library-list', getLibraryList());
    });

    // 🚪 Odaya katıl
    socket.on('join-room', (data) => {
        const { roomCode, userName, userPhoto, deviceId, password } = data;
        const room = rooms.get(roomCode.toUpperCase());
        
        if (!room) {
            socket.emit('error', { message: 'Oda bulunamadı' });
            return;
        }
        
        if (room.password && room.password !== password) {
            socket.emit('error', { message: 'Şifre yanlış' });
            return;
        }
        
        currentUser = {
            id: socket.id,
            deviceId: deviceId,
            userName: userName,
            userPhoto: userPhoto || generateDefaultAvatar(userName),
            userColor: generateUserColor(userName),
            isOwner: false,
            isAdmin: isAdmin
        };
        
        room.users.set(socket.id, currentUser);
        users.set(socket.id, { ...currentUser, roomCode });
        currentRoomCode = roomCode;
        socket.join(roomCode);
        
        // Oda sahibiyle etkileşim kaydet
        const owner = Array.from(room.users.values()).find(u => u.isOwner);
        if (owner && owner.deviceId !== deviceId) {
            recordInteraction(deviceId, owner.deviceId);
        }
        
        const roomMessages = messages.get(roomCode) || [];
        
        socket.emit('room-joined', {
            roomCode: room.code,
            roomName: room.name,
            isOwner: false,
            isAdmin,
            previousMessages: roomMessages.slice(-50),
            activeVideo: room.video,
            videoVisible: room.videoVisible,
            theme: room.theme
        });
        
        socket.emit('video-library-list', getLibraryList());
        
        socket.to(roomCode).emit('user-joined', {
            userName: currentUser.userName
        });
    });

    // 💬 Mesaj gönder
    socket.on('message', (messageData) => {
        if (!currentRoomCode || !currentUser) return;
        
        const message = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            userName: currentUser.userName,
            userPhoto: currentUser.userPhoto,
            userColor: currentUser.userColor,
            deviceId: currentUser.deviceId,
            text: messageData.text,
            type: messageData.type || 'text',
            fileUrl: messageData.fileUrl,
            fileName: messageData.fileName,
            fileSize: messageData.fileSize,
            reactions: [],
            replyTo: messageData.replyTo || null, // Yanıtlanan mesaj ID'si
            isSecure: messageData.isSecure || false,
            secureId: messageData.secureId || null,
            time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
            timestamp: Date.now()
        };
        
        const roomMessages = messages.get(currentRoomCode) || [];
        roomMessages.push(message);
        
        if (roomMessages.length > 200) {
            messages.set(currentRoomCode, roomMessages.slice(-200));
        } else {
            messages.set(currentRoomCode, roomMessages);
        }
        
        io.to(currentRoomCode).emit('message', message);
    });

    // 💬 Mesajı yanıtla
    socket.on('reply-message', (data) => {
        if (!currentRoomCode || !currentUser) return;
        
        const { replyToId, text, type, fileUrl } = data;
        
        const message = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            userName: currentUser.userName,
            userPhoto: currentUser.userPhoto,
            userColor: currentUser.userColor,
            deviceId: currentUser.deviceId,
            text: text,
            type: type || 'text',
            fileUrl: fileUrl,
            replyTo: replyToId,
            reactions: [],
            time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
            timestamp: Date.now()
        };
        
        const roomMessages = messages.get(currentRoomCode) || [];
        roomMessages.push(message);
        messages.set(currentRoomCode, roomMessages);
        
        io.to(currentRoomCode).emit('message', message);
    });

    // 🗑️ Mesaj sil
    socket.on('delete-message', (data) => {
        if (!currentRoomCode || !currentUser) return;
        
        const { messageId } = data;
        const roomMessages = messages.get(currentRoomCode) || [];
        
        const index = roomMessages.findIndex(m => m.id === messageId);
        if (index !== -1 && roomMessages[index].deviceId === currentUser.deviceId) {
            roomMessages.splice(index, 1);
            messages.set(currentRoomCode, roomMessages);
            io.to(currentRoomCode).emit('message-deleted', { messageId });
        }
    });

    // 🔒 Güvenli fotoğraf görüntüle
    socket.on('view-secure-photo', (data) => {
        if (!currentRoomCode || !currentUser) return;
        
        const { secureId } = data;
        const roomSecurePhotos = securePhotos.get(currentRoomCode) || [];
        const photo = roomSecurePhotos.find(p => p.id === secureId);
        
        if (photo) {
            // 8 saniye görüntüleme
            io.to(currentRoomCode).emit('secure-photo-view', {
                secureId: secureId,
                imageUrl: photo.imageUrl,
                viewerName: currentUser.userName,
                expiresAt: Date.now() + 8000 // 8 saniye
            });
            
            // 8 saniye sonra mesajı sil
            setTimeout(() => {
                const roomMessages = messages.get(currentRoomCode) || [];
                const msgIndex = roomMessages.findIndex(m => m.secureId === secureId);
                if (msgIndex !== -1) {
                    roomMessages.splice(msgIndex, 1);
                    messages.set(currentRoomCode, roomMessages);
                    io.to(currentRoomCode).emit('message-deleted', { 
                        messageId: roomMessages[msgIndex]?.id 
                    });
                }
            }, 8000);
        }
    });

    // 📤 Video yükleme (oda içi - telifli olabilir)
    socket.on('upload-room-video', (data) => {
        if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
        
        const { url, fileId, title, fileSize } = data;
        const room = rooms.get(currentRoomCode);
        
        if (room) {
            const videoId = 'room_' + Date.now();
            roomVideos.set(videoId, {
                id: videoId,
                url,
                fileId,
                title,
                uploadedBy: currentUser.userName,
                uploadedAt: Date.now(),
                expiresAt: Date.now() + (24 * 60 * 60 * 1000), // 24 saat
                roomCode: currentRoomCode
            });
            
            room.video = {
                type: 'room',
                url,
                fileId,
                title,
                uploadedBy: currentUser.userName,
                isRoomOnly: true
            };
            
            io.to(currentRoomCode).emit('video-uploaded', {
                videoUrl: url,
                title,
                uploadedBy: currentUser.userName
            });
        }
    });

    // 📚 Kütüphaneden video oynat (telifsiz)
    socket.on('play-library-film', (data) => {
        const { filmId, inRoom } = data;
        const film = videoLibrary.get(filmId);
        
        if (!film) {
            socket.emit('error', { message: 'Film bulunamadı' });
            return;
        }
        
        if (inRoom && currentRoomCode) {
            const room = rooms.get(currentRoomCode);
            if (room && currentUser?.isOwner) {
                room.video = {
                    type: 'library',
                    url: film.url,
                    fileId: film.fileId,
                    title: film.title,
                    fromLibrary: true,
                    isCopyrightFree: true
                };
                
                io.to(currentRoomCode).emit('video-uploaded', {
                    videoUrl: film.url,
                    title: film.title,
                    fromLibrary: true
                });
            }
        } else {
            socket.emit('play-pip-video', {
                url: film.url,
                title: film.title
            });
        }
    });

    // 🎬 YouTube video paylaş
    socket.on('share-youtube-link', (data) => {
        if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
        
        const { youtubeUrl, title } = data;
        const videoId = extractYouTubeId(youtubeUrl);
        
        if (!videoId) {
            socket.emit('error', { message: 'Geçersiz YouTube linki' });
            return;
        }
        
        const room = rooms.get(currentRoomCode);
        if (room) {
            room.video = {
                type: 'youtube',
                videoId,
                url: youtubeUrl,
                title: title || 'YouTube Video'
            };
            
            io.to(currentRoomCode).emit('youtube-video-shared', {
                videoId,
                title: title || 'YouTube Video'
            });
        }
    });

    // 🎮 Video kontrol
    socket.on('video-control', (controlData) => {
        if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
        socket.to(currentRoomCode).emit('video-control', controlData);
    });

    // 🎮 YouTube kontrol
    socket.on('youtube-control', (controlData) => {
        if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
        socket.to(currentRoomCode).emit('youtube-control', controlData);
    });

    // 🗑️ Video sil
    socket.on('delete-video', () => {
        if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
        
        const room = rooms.get(currentRoomCode);
        if (room) {
            room.video = null;
            io.to(currentRoomCode).emit('video-deleted');
        }
    });

    // 👁️ Video görünürlük
    socket.on('toggle-video-visibility', () => {
        if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
        
        const room = rooms.get(currentRoomCode);
        if (room) {
            room.videoVisible = !room.videoVisible;
            io.to(currentRoomCode).emit('video-visibility-changed', {
                visible: room.videoVisible
            });
        }
    });

    // 🎨 Tema değiştir
    socket.on('change-theme', (theme) => {
        if (!currentRoomCode) return;
        const room = rooms.get(currentRoomCode);
        if (room) {
            room.theme = theme;
            io.to(currentRoomCode).emit('theme-changed', theme);
        }
    });

    // 😊 Çıkartma kaydet
    socket.on('save-stickers', (data) => {
        if (!currentRoomCode || !currentUser) return;
        
        const { stickers } = data;
        let roomStickers = userStickers.get(currentRoomCode) || [];
        
        stickers.forEach(sticker => {
            roomStickers.push({
                id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                imageUrl: sticker.imageUrl,
                createdBy: currentUser.userName,
                createdAt: Date.now()
            });
        });
        
        if (roomStickers.length > 50) roomStickers = roomStickers.slice(-50);
        userStickers.set(currentRoomCode, roomStickers);
        
        io.to(currentRoomCode).emit('stickers-updated', { stickers: roomStickers });
    });

    // 😊 Çıkartma gönder
    socket.on('send-sticker', (data) => {
        if (!currentRoomCode || !currentUser) return;
        
        const { stickerId, imageUrl } = data;
        
        const message = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            userName: currentUser.userName,
            userPhoto: currentUser.userPhoto,
            userColor: currentUser.userColor,
            deviceId: currentUser.deviceId,
            type: 'sticker',
            stickerId,
            stickerUrl: imageUrl,
            reactions: [],
            time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
            timestamp: Date.now()
        };
        
        const roomMessages = messages.get(currentRoomCode) || [];
        roomMessages.push(message);
        messages.set(currentRoomCode, roomMessages);
        
        io.to(currentRoomCode).emit('message', message);
    });

    // 🚨 Acil durum
    socket.on('emergency-alert', () => {
        if (!currentRoomCode) return;
        
        io.to(currentRoomCode).emit('emergency-message', {
            userName: currentUser?.userName
        });
        
        // Odayı temizle
        const room = rooms.get(currentRoomCode);
        if (room) {
            rooms.delete(currentRoomCode);
            messages.delete(currentRoomCode);
            userStickers.delete(currentRoomCode);
            securePhotos.delete(currentRoomCode);
        }
    });

    // 🔌 Bağlantı kesildi
    socket.on('disconnect', () => {
        console.log('🔌 Bağlantı koptu:', socket.id);
        
        if (currentRoomCode && currentUser) {
            const room = rooms.get(currentRoomCode);
            if (room) {
                room.users.delete(socket.id);
                users.delete(socket.id);
                
                socket.to(currentRoomCode).emit('user-left', {
                    userName: currentUser.userName
                });
                
                // Oda boşsa 1 saat sonra sil
                if (room.users.size === 0) {
                    setTimeout(() => {
                        if (room.users.size === 0) {
                            rooms.delete(currentRoomCode);
                            messages.delete(currentRoomCode);
                        }
                    }, 60 * 60 * 1000);
                }
            }
        }
    });
});

// 📡 API Routes

// ImageKit auth
app.get('/api/imagekit-auth', (req, res) => {
    try {
        const authParams = imagekit.getAuthenticationParameters();
        res.json(authParams);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// VAPID public key
app.get('/api/vapid-public-key', (req, res) => {
    res.json({ publicKey: vapidKeys.publicKey });
});

// Kütüphaneye video yükle (admin only)
app.post('/api/library/upload', upload.single('video'), async (req, res) => {
    try {
        const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        if (clientIp !== ADMIN_IP) {
            return res.status(403).json({ error: 'Sadece admin yükleyebilir' });
        }
        
        const { title } = req.body;
        const file = req.file;
        
        const result = await new Promise((resolve, reject) => {
            imagekit.upload({
                file: file.buffer,
                fileName: file.originalname,
                folder: '/library_videos',
                tags: ['library', 'copyright-free'],
                useUniqueFileName: true
            }, (error, result) => {
                if (error) reject(error);
                else resolve(result);
            });
        });
        
        const videoId = 'lib_' + Date.now();
        videoLibrary.set(videoId, {
            id: videoId,
            title: title || file.originalname,
            url: result.url,
            fileId: result.fileId,
            uploadedBy: 'Admin',
            uploadedAt: Date.now(),
            expiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000),
            thumbnail: result.thumbnail
        });
        
        res.json({ 
            success: true, 
            library: getLibraryList()
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Kütüphane listesi
app.get('/api/library', (req, res) => {
    res.json(getLibraryList());
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        rooms: rooms.size,
        users: users.size,
        library: videoLibrary.size
    });
});

// Ana sayfa
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 🚀 Server başlat
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server ${PORT} portunda çalışıyor`);
    console.log(`👑 Admin IP: ${ADMIN_IP}`);
    console.log(`📚 Kütüphane: ${videoLibrary.size} video`);
});
