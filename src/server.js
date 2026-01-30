const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const cameraManager = require('./core/camera-manager');
const storageManager = require('./core/storage-manager');
const onvifManager = require('./core/onvif');
const audioManager = require('./core/audio-manager');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1); // Trust Nginx/Reverse Proxy
app.use(cors());
app.use(bodyParser.json());

// Auth Dependencies
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const { authMiddleware, generateToken, SECRET_KEY } = require('./middleware/auth');
const jwt = require('jsonwebtoken');

app.use(cookieParser());

// Static Files
app.use(express.static(path.join(process.cwd(), 'public')));
app.use('/hls', express.static(path.join(process.cwd(), 'public', 'hls')));
app.use('/recordings', express.static(path.join(process.cwd(), 'recordings')));

// Root Protection
app.get('/', (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.redirect('/login.html');
    
    try {
        jwt.verify(token, SECRET_KEY);
        res.sendFile(path.join(process.cwd(), 'src', 'views', 'index.html'));
    } catch (e) {
        res.redirect('/login.html');
    }
});

// --- Authentication Routes ---

// Setup (First Run)
app.post('/api/auth/setup', async (req, res) => {
    const { username, password } = req.body;
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    if (userCount > 0) return res.status(403).json({ error: 'Setup already completed.' });
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const id = uuidv4();
    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(id, username, hashedPassword, 'admin');
    
    const token = generateToken({ id, username, role: 'admin' });
    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 3600000 });
    res.json({ success: true, message: 'Admin created' });
});

// Login
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = generateToken(user);
    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 3600000 });
    res.json({ success: true });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ success: true });
});

// Status
app.get('/api/auth/status', (req, res) => {
    const token = req.cookies.token;
    if (!token) {
        const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
        return res.json({ authenticated: false, setupRequired: userCount === 0 });
    }
    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        res.json({ authenticated: true, user: decoded });
    } catch(e) {
        const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
        res.json({ authenticated: false, setupRequired: userCount === 0 });
    }
});

// Admin: Add User
app.post('/api/auth/users', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const id = uuidv4();
        db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(id, username, hashedPassword, 'user');
        res.json({ success: true });
    } catch(e) {
        res.status(400).json({ error: 'Username likely exists' });
    }
});

// Admin: List Users
app.get('/api/auth/users', authMiddleware, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const users = db.prepare('SELECT id, username, role, created_at FROM users').all();
    res.json(users);
});

// Admin: Delete User
app.delete('/api/auth/users/:id', authMiddleware, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { id } = req.params;
    
    // Prevent self-delete
    if (id === req.user.id) return res.status(400).json({ error: "Cannot delete yourself" });

    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.json({ success: true });
});

// Global API Protection (Except /auth)
app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth')) return next();
    authMiddleware(req, res, next);
});

(async () => {
    try {
        const mediamtx = require('./core/mediamtx-manager');
        await mediamtx.init();
        mediamtx.start();
        
        await cameraManager.init();
        const thumbnailManager = require('./core/thumbnail-manager');
        thumbnailManager.start();
        storageManager.start();
    } catch (e) {
        console.error('Critical Init Error:', e);
    }
})();

// DEBUG: Manual HLS Route
app.get('/hls/:id/:file', (req, res) => {
    const { id, file } = req.params;
    const filePath = path.join(process.cwd(), 'public', 'hls', id, file);
    if (fs.existsSync(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile(filePath);
    } else {
        res.status(404).send('Not found');
    }
});

// API Routes

// --- Cameras ---
app.get('/api/cameras', (req, res) => {
    const cameras = db.prepare('SELECT * FROM cameras').all();
    const camsWithStatus = cameras.map(c => {
        const rec = cameraManager.getRecorder(c.id);
        return { ...c, is_recording: rec ? rec.isRecording : false };
    });
    res.json(camsWithStatus);
});

app.post('/api/cameras', (req, res) => {
    const { name, type, url, username, password, record_mode, timelapse_enabled, segment_duration, timelapse_interval, timelapse_duration, onvif_service_url, substream_url, ptz_enabled } = req.body;
    const id = Math.random().toString(36).substring(2, 7).toUpperCase();
    try {
        const stmt = db.prepare(`INSERT INTO cameras (id, name, type, url, username, password, record_mode, timelapse_enabled, segment_duration, timelapse_interval, timelapse_duration, onvif_service_url, substream_url, ptz_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        stmt.run(id, name, type, url, username, password, record_mode || 'raw', timelapse_enabled ? 1 : 0, segment_duration || 15, timelapse_interval || 5, timelapse_duration || 60, onvif_service_url, substream_url, ptz_enabled ? 1 : 0);
        const newCam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
        cameraManager.startCamera(newCam);
        res.json(newCam);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/cameras/:id', (req, res) => {
    const { id } = req.params;
    const { name, type, url, username, password, record_mode, timelapse_enabled, segment_duration, timelapse_interval, timelapse_duration, onvif_service_url, substream_url, ptz_enabled } = req.body;
    try {
        cameraManager.stopCamera(id);
        const stmt = db.prepare(`UPDATE cameras SET name=?, type=?, url=?, username=?, password=?, record_mode=?, timelapse_enabled=?, segment_duration=?, timelapse_interval=?, timelapse_duration=?, onvif_service_url=?, substream_url=?, ptz_enabled=? WHERE id=?`);
        stmt.run(name, type, url, username, password, record_mode || 'raw', timelapse_enabled ? 1 : 0, segment_duration || 15, timelapse_interval || 5, timelapse_duration || 60, onvif_service_url, substream_url, ptz_enabled ? 1 : 0, id);
        const updatedCam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
        if (updatedCam.record_enabled) cameraManager.startCamera(updatedCam);
        res.json(updatedCam);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/cameras/:id', (req, res) => {
    const { id } = req.params;
    cameraManager.stopCamera(id);
    db.prepare('DELETE FROM cameras WHERE id = ?').run(id);
    res.json({ success: true });
});

app.post('/api/cameras/discover', async (req, res) => {
    try {
        const devices = await onvifManager.discover();
        const existingCams = db.prepare('SELECT onvif_service_url FROM cameras').all();
        const getHost = (urlStr) => { try { return new URL(urlStr.match(/^https?:\/\//) ? urlStr : `http://${urlStr}`).hostname; } catch (e) { return ''; } };
        const existingHosts = new Set(existingCams.map(c => getHost(c.onvif_service_url)).filter(h => h));
        const newDevices = devices.map(d => ({ ...d, existing: existingHosts.has(getHost(d.xaddr)) }));
        res.json(newDevices);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/onvif/profiles', async (req, res) => {
    const { url, username, password } = req.body;
    try {
        const profiles = await onvifManager.getProfiles(url, username, password);
        res.json(profiles);
    } catch (e) { res.status(500).json({ error: `Connection failed: ${e.message}` }); }
});

app.post('/api/cameras/:id/stream-url', async (req, res) => {
    const { id } = req.params;
    const cam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
    if (!cam) return res.status(404).json({error: 'Camera not found'});
    if (cam.type === 'onvif') {
        try {
            const url = await onvifManager.getStreamUrl(cam.url, cam.username, cam.password);
            db.prepare('UPDATE cameras SET url = ? WHERE id = ?').run(url, id);
            cameraManager.restartCamera(id);
            res.json({ url });
        } catch (e) { res.status(500).json({ error: e.message }); }
    } else { res.json({ url: cam.url }); }
});

app.post('/api/cameras/:id/live/heartbeat', (req, res) => {
    const { id } = req.params;
    const cam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    let streamUrl = cam.substream_url || cam.url;
    if (cam.username && cam.password && streamUrl.startsWith('rtsp://') && !streamUrl.includes('@')) {
        const parts = streamUrl.split('://');
        streamUrl = `${parts[0]}://${encodeURIComponent(cam.username)}:${encodeURIComponent(cam.password)}@${parts[1]}`;
    }
    res.json({ success: true });
});

app.post('/api/cameras/:id/ptz', async (req, res) => {
    const { id } = req.params;
    const { action, x, y, z } = req.body; // action: 'move' or 'stop'
    
    const cam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    if (!cam.ptz_enabled && action !== 'stop') return res.status(400).json({ error: 'PTZ not enabled for this camera' });

    // Use onvif_service_url if available (most reliable), else fallback to parsing 'url'
    // But 'url' is RTSP... we need the XAddr (ONVIF Service URL).
    // We saved it in `cameras` table as `onvif_service_url`.
    if (!cam.onvif_service_url) return res.status(400).json({ error: 'No ONVIF URL configured' });

    try {
        if (action === 'stop') {
             await onvifManager.stop(cam.onvif_service_url, cam.username, cam.password);
        } else {
             // Velocity normalization handled by frontend mostly, but ensure limits
             await onvifManager.move(cam.onvif_service_url, cam.username, cam.password, { x, y, z });
        }
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// --- System Stats ---
const os = require('os');
const si = require('systeminformation');

// Track network for rate calculation
let lastNetworkStats = null;
let lastNetworkTime = Date.now();

app.get('/api/system/stats', async (req, res) => {
    try {
        // Storage usage
        const basePath = getStoragePath();
        let storageUsed = 0;
        
        if (fs.existsSync(basePath)) {
            const getDirSize = (dirPath) => {
                let size = 0;
                try {
                    const files = fs.readdirSync(dirPath);
                    for (const file of files) {
                        const filePath = path.join(dirPath, file);
                        const stat = fs.statSync(filePath);
                        if (stat.isDirectory()) {
                            size += getDirSize(filePath);
                        } else {
                            size += stat.size;
                        }
                    }
                } catch (e) { /* ignore errors */ }
                return size;
            };
            storageUsed = getDirSize(basePath);
        }
        
        // Get storage limit from settings
        const storageLimitRow = db.prepare("SELECT value FROM settings WHERE key = 'max_storage_gb'").get();
        const storageLimit = storageLimitRow ? parseFloat(storageLimitRow.value) : 100; // Default 100GB

        // CPU usage using systeminformation
        const cpuLoad = await si.currentLoad();
        const cpuPercent = Math.round(cpuLoad.currentLoad);

        // Memory usage
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const memPercent = Math.round((usedMem / totalMem) * 100);

        // Network usage using systeminformation
        let rxRate = 0, txRate = 0;
        try {
            const networkStats = await si.networkStats();
            const now = Date.now();
            
            if (lastNetworkStats && networkStats.length > 0) {
                const elapsed = (now - lastNetworkTime) / 1000; // seconds
                if (elapsed > 0) {
                    // Sum all interfaces
                    let totalRx = 0, totalTx = 0;
                    let lastTotalRx = 0, lastTotalTx = 0;
                    
                    networkStats.forEach((iface, i) => {
                        totalRx += iface.rx_bytes || 0;
                        totalTx += iface.tx_bytes || 0;
                        if (lastNetworkStats[i]) {
                            lastTotalRx += lastNetworkStats[i].rx_bytes || 0;
                            lastTotalTx += lastNetworkStats[i].tx_bytes || 0;
                        }
                    });
                    
                    rxRate = Math.round((totalRx - lastTotalRx) / elapsed / 1024); // KB/s
                    txRate = Math.round((totalTx - lastTotalTx) / elapsed / 1024); // KB/s
                    
                    // Ensure non-negative
                    rxRate = Math.max(0, rxRate);
                    txRate = Math.max(0, txRate);
                }
            }
            
            lastNetworkStats = networkStats;
            lastNetworkTime = now;
        } catch (e) {
            console.error('Network stats error:', e.message);
        }

        // Get actual disk space for storage path
        let diskAvailable = 0;
        let diskWarning = false;
        try {
            const disks = await si.fsSize();
            // Find the disk that contains the storage path
            const normalizedPath = path.resolve(basePath).toLowerCase();
            let matchedDisk = null;
            
            for (const disk of disks) {
                const mount = disk.mount.toLowerCase();
                if (normalizedPath.startsWith(mount)) {
                    if (!matchedDisk || mount.length > matchedDisk.mount.length) {
                        matchedDisk = disk;
                    }
                }
            }
            
            if (matchedDisk) {
                diskAvailable = Math.round(matchedDisk.available / (1024 * 1024 * 1024) * 100) / 100; // GB
                // Check if configured limit exceeds available space
                if (storageLimit > diskAvailable + (storageUsed / (1024 * 1024 * 1024))) {
                    diskWarning = true;
                }
            }
        } catch (e) {
            console.error('Disk space check error:', e.message);
        }

        res.json({
            storage: {
                used: Math.round(storageUsed / (1024 * 1024 * 1024) * 100) / 100, // GB
                limit: storageLimit,
                available: diskAvailable,
                warning: diskWarning,
                percent: Math.min(100, Math.round((storageUsed / (storageLimit * 1024 * 1024 * 1024)) * 100))
            },
            cpu: {
                percent: cpuPercent
            },
            memory: {
                used: Math.round(usedMem / (1024 * 1024 * 1024) * 100) / 100, // GB
                total: Math.round(totalMem / (1024 * 1024 * 1024) * 100) / 100, // GB
                percent: memPercent
            },
            network: {
                rxRate: rxRate, // KB/s
                txRate: txRate  // KB/s
            }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- Settings ---
app.get('/api/settings', (req, res) => {
    const settings = db.prepare('SELECT * FROM settings').all();
    const result = {};
    settings.forEach(s => result[s.key] = s.value);
    res.json(result);
});

app.post('/api/settings', (req, res) => {
    const { max_storage_gb, retention_hours, cleanup_interval_min, storage_path } = req.body;
    const update = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    if (max_storage_gb) update.run('max_storage_gb', max_storage_gb.toString());
    if (retention_hours) update.run('retention_hours', retention_hours.toString());
    if (cleanup_interval_min) update.run('cleanup_interval_min', cleanup_interval_min.toString());
    if (storage_path) update.run('storage_path', storage_path.toString());
    storageManager.stop();
    storageManager.start();
    res.json({ success: true });
});

app.post('/api/settings/check-path', (req, res) => {
    const { path: checkPath } = req.body;
    try {
        if (!fs.existsSync(checkPath)) fs.mkdirSync(checkPath, { recursive: true });
        const testFile = path.join(checkPath, '.test_write');
        fs.writeFileSync(testFile, 'ok');
        fs.unlinkSync(testFile);
        res.json({ success: true, message: 'Path is valid' });
    } catch (e) { res.status(400).json({ error: `Invalid path: ${e.message}` }); }
});

// helper 
function getStoragePath() {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'storage_path'").get();
    return row ? row.value : path.join(process.cwd(), 'recordings');
}

app.get('/api/recordings/:id', (req, res) => {
    // List recordings for a camera
    const { id } = req.params;
    const basePath = getStoragePath();
    const recPath = path.join(basePath, id);
    let results = [];

    if (fs.existsSync(recPath)) {
        try {
            // 1. Main Recordings
            const mainFiles = fs.readdirSync(recPath).filter(f => fs.statSync(path.join(recPath, f)).isFile()).map(f => {
                const stat = fs.statSync(path.join(recPath, f));
                return {
                    name: f,
                    size: stat.size,
                    mtime: stat.mtime,
                    type: 'normal'
                };
            });
            results = results.concat(mainFiles);

            // 2. Timelapse Recordings
            const timelapsePath = path.join(recPath, 'timelapse');
            if (fs.existsSync(timelapsePath)) {
                const tlFiles = fs.readdirSync(timelapsePath).map(f => {
                    const stat = fs.statSync(path.join(timelapsePath, f));
                    return {
                        name: `timelapse/${f}`, // Relative path for frontend
                        size: stat.size,
                        mtime: stat.mtime,
                        type: 'timelapse'
                    };
                });
                results = results.concat(tlFiles);
            }

            res.json(results);
        } catch(e) {
             console.error("Error listing recordings:", e);
             res.json([]);
        }
    } else {
        res.json([]);
    }
});

// Dynamic route for serving recordings
app.get('/recordings/:id/:file', (req, res) => {
    const { id, file } = req.params;
    const basePath = getStoragePath();
    const filePath = path.join(basePath, id, file);
    
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send('Not found');
    }
});

app.get('/api/cameras/:id/latest-recording', (req, res) => {
    const { id } = req.params;
    const basePath = getStoragePath();
    const recPath = path.join(basePath, id);
    
    if (fs.existsSync(recPath)) {
        try {
            const files = fs.readdirSync(recPath)
                .filter(f => fs.statSync(path.join(recPath, f)).isFile() && (f.endsWith('.mp4') || f.endsWith('.mkv')))
                .map(f => ({ name: f, mtime: fs.statSync(path.join(recPath, f)).mtime }))
                .sort((a, b) => b.mtime - a.mtime);
                
            if (files.length > 0) {
                res.json(files[0]);
            } else {
                res.json(null);
            }
        } catch(e) {
            res.status(500).json({ error: e.message });
        }
    } else {
        res.json(null);
    }
});

const generatingThumbs = new Set(); // Track active generations

// Thumbnail Endpoint
// Thumbnail Endpoint
app.get('/api/cameras/:id/thumbnail', (req, res) => {
    const { id } = req.params;
    const basePath = getStoragePath();
    const thumbPath = path.join(basePath, id, 'thumbnail.jpg');
    
    if (fs.existsSync(thumbPath)) {
        // Disable cache so it updates
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(thumbPath);
    } else {
        res.redirect('/placeholder.png'); // Ensure you have this or handle it
    }
});

// --- Debug/Maintenance ---
app.get('/api/debug/fix-db', (req, res) => {
    try {
        const tableInfo = db.prepare("PRAGMA table_info(cameras)").all();
        const hasPtz = tableInfo.some(c => c.name === 'ptz_enabled');
        if (!hasPtz) {
            db.prepare("ALTER TABLE cameras ADD COLUMN ptz_enabled INTEGER DEFAULT 0").run();
            res.json({ success: true, message: 'Migration successful: Added ptz_enabled column.' });
        } else {
            res.json({ success: true, message: 'Database already up to date.' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- Audio/Talk Endpoints ---

// Check if camera supports audio talk
app.get('/api/cameras/:id/audio-support', async (req, res) => {
    const { id } = req.params;
    const cam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    
    // Only ONVIF cameras can support audio backchannel
    if (cam.type !== 'onvif' || !cam.onvif_service_url) {
        return res.json({ supported: false, reason: 'Only ONVIF cameras support talk' });
    }

    try {
        const audioInfo = await onvifManager.getAudioBackchannelInfo(
            cam.onvif_service_url, 
            cam.username, 
            cam.password
        );
        res.json(audioInfo);
    } catch (e) {
        res.json({ supported: false, error: e.message });
    }
});

// Start talk session
app.post('/api/cameras/:id/talk/start', async (req, res) => {
    const { id } = req.params;
    const cam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    
    if (cam.type !== 'onvif' || !cam.onvif_service_url) {
        return res.status(400).json({ error: 'Only ONVIF cameras support talk' });
    }

    try {
        // Get audio backchannel URL
        const audioInfo = await onvifManager.getAudioBackchannelInfo(
            cam.onvif_service_url,
            cam.username,
            cam.password
        );
        
        if (!audioInfo.supported) {
            return res.status(400).json({ error: 'Camera does not support audio talk' });
        }

        const result = audioManager.startTalk(id, audioInfo.rtspUrl, cam.username, cam.password);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Stop talk session
app.post('/api/cameras/:id/talk/stop', (req, res) => {
    const { id } = req.params;
    const result = audioManager.stopTalk(id);
    res.json(result);
});

// Send audio data (POST with raw audio in body)
app.post('/api/cameras/:id/talk/audio', express.raw({ type: 'application/octet-stream', limit: '1mb' }), (req, res) => {
    const { id } = req.params;
    
    if (!audioManager.isActive(id)) {
        return res.status(400).json({ error: 'No active talk session' });
    }
    
    const success = audioManager.sendAudio(id, req.body);
    res.json({ success });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
