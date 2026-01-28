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
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(process.cwd(), 'public')));
app.use('/hls', express.static(path.join(process.cwd(), 'public', 'hls')));
app.use('/hls', express.static(path.join(process.cwd(), 'public', 'hls')));
app.use('/recordings', express.static(path.join(process.cwd(), 'public', 'recordings')));

// Auth Dependencies
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const { authMiddleware, generateToken } = require('./middleware/auth');

app.use(cookieParser());

// --- Authentication Routes ---

// Setup (First Run Only)
app.post('/api/auth/setup', async (req, res) => {
    const { username, password } = req.body;
    
    // Check if any user exists
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    if (userCount > 0) {
        return res.status(403).json({ error: 'Setup already completed. Please login.' });
    }

    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const id = uuidv4();

    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(id, username, hashedPassword, 'admin');
    
    // Auto login
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

// Check Auth Status (for frontend)
app.get('/api/auth/status', (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.json({ authenticated: false });
    try {
        const { verify } = require('jsonwebtoken'); // Lazy load to ensure secret is same
        const { SECRET_KEY } = require('./middleware/auth');
        const decoded = verify(token, SECRET_KEY);
        // Check if DB is empty (Setup Mode)
        const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
        res.json({ authenticated: true, user: decoded, setupRequired: userCount === 0 });
    } catch(e) {
        const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
        res.json({ authenticated: false, setupRequired: userCount === 0 });
    }
});

// Middleware to protect API routes (Apply to /api/cameras, /api/settings, etc)
// We applied it globally to /api/* EXCEPT auth routes
app.use('/api', (req, res, next) => {
    // Allow Auth routes
    if (req.path.startsWith('/auth')) return next();
    
    // Apply Auth Middleware
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
    // console.log(`Serving HLS: ${filePath} (Exists: ${fs.existsSync(filePath)})`);
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
    // Add runtime status
    const camsWithStatus = cameras.map(c => {
        const rec = cameraManager.getRecorder(c.id);
        return {
            ...c,
            is_recording: rec ? rec.isRecording : false
        };
    });
    res.json(camsWithStatus);
});

app.post('/api/cameras', (req, res) => {
    const { name, type, url, username, password, record_mode, timelapse_enabled, segment_duration, timelapse_interval, timelapse_duration, onvif_service_url, substream_url } = req.body;
    // Generated 5-digit alphanumeric ID
    const id = Math.random().toString(36).substring(2, 7).toUpperCase();
    
    try {
        const stmt = db.prepare(`
            INSERT INTO cameras (id, name, type, url, username, password, record_mode, timelapse_enabled, segment_duration, timelapse_interval, timelapse_duration, onvif_service_url, substream_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(id, name, type, url, username, password, record_mode || 'raw', timelapse_enabled ? 1 : 0, segment_duration || 15, timelapse_interval || 5, timelapse_duration || 60, onvif_service_url, substream_url);
        
        const newCam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
        cameraManager.startCamera(newCam);
        
        res.json(newCam);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/cameras/:id', (req, res) => {
    const { id } = req.params;
    const { name, type, url, username, password, record_mode, timelapse_enabled, segment_duration, timelapse_interval, timelapse_duration, onvif_service_url, substream_url } = req.body;
    
    try {
        // Stop current instance
        cameraManager.stopCamera(id);

        const stmt = db.prepare(`
            UPDATE cameras 
            SET name=?, type=?, url=?, username=?, password=?, record_mode=?, timelapse_enabled=?, segment_duration=?, timelapse_interval=?, timelapse_duration=?, onvif_service_url=?, substream_url=?
            WHERE id=?
        `);
        stmt.run(name, type, url, username, password, record_mode || 'raw', timelapse_enabled ? 1 : 0, segment_duration || 15, timelapse_interval || 5, timelapse_duration || 60, onvif_service_url, substream_url, id);
        
        const updatedCam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
        
        // Restart if enabled
        if (updatedCam.record_enabled) {
            cameraManager.startCamera(updatedCam);
        }
        
        res.json(updatedCam);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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
        
        // Filter out existing cameras
        const existingCams = db.prepare('SELECT onvif_service_url FROM cameras').all();
        
        // Helper to extract IP/Hostname
        const getHost = (urlStr) => {
            try {
                if (!urlStr) return '';
                // Handle cases where url might not have protocol
                const safeUrl = urlStr.match(/^https?:\/\//) ? urlStr : `http://${urlStr}`;
                return new URL(safeUrl).hostname;
            } catch (e) { return ''; }
        };

        const existingHosts = new Set(existingCams.map(c => getHost(c.onvif_service_url)).filter(h => h));
        
        console.log('[Discovery] Existing Hosts in DB:', [...existingHosts]);

        const newDevices = devices.map(d => {
            const dHost = getHost(d.xaddr);
            const isExisting = existingHosts.has(dHost);
            console.log(`[Discovery] Found ${dHost} (xaddr: ${d.xaddr}) -> Existing? ${isExisting}`);
            
            return {
                ...d,
                existing: isExisting
            };
        });

        res.json(newDevices);
    } catch (e) {
        console.error('[Discovery API Error]', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/onvif/profiles', async (req, res) => {
    const { url, username, password } = req.body;
    if (!url) return res.status(400).json({ error: 'URL (xaddr) is required' });
    
    try {
        const profiles = await onvifManager.getProfiles(url, username, password);
        res.json(profiles);
    } catch (e) {
         res.status(500).json({ error: `Connection failed: ${e.message}` });
    }
});

app.post('/api/cameras/:id/stream-url', async (req, res) => {
    // Helper to get ONVIF stream URL if missing
    const { id } = req.params;
    const cam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
    if (!cam) return res.status(404).json({error: 'Camera not found'});
    
    if (cam.type === 'onvif') {
        try {
            const url = await onvifManager.getStreamUrl(cam.url, cam.username, cam.password);
            // Update DB
            db.prepare('UPDATE cameras SET url = ? WHERE id = ?').run(url, id);
            // Restart
            cameraManager.restartCamera(id);
            res.json({ url });
        } catch (e) {
             res.status(500).json({ error: e.message });
        }
    } else {
        res.json({ url: cam.url });
    }
});

app.post('/api/cameras/:id/live/heartbeat', (req, res) => {
    const { id } = req.params;
    const cam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
    
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    
    // Construct URL for StreamManager (same logic as before)
    let streamUrl = cam.substream_url || cam.url;
    
    if (cam.username && cam.password && streamUrl.startsWith('rtsp://') && !streamUrl.includes('@')) {
        const parts = streamUrl.split('://');
        streamUrl = `${parts[0]}://${encodeURIComponent(cam.username)}:${encodeURIComponent(cam.password)}@${parts[1]}`;
    }
    
    // Send Heartbeat
    require('./core/stream-manager').heartbeat(id, streamUrl);
    
    res.json({ success: true });
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
    
    // Restart storage scheduler
    storageManager.stop();
    storageManager.start();
    
    res.json({ success: true });
});

app.post('/api/settings/check-path', (req, res) => {
    const { path: checkPath } = req.body;
    if (!checkPath) return res.status(400).json({ error: 'Path is required' });
    
    try {
        if (!fs.existsSync(checkPath)) {
            // Try to create it
            fs.mkdirSync(checkPath, { recursive: true });
        }
        // Test write
        const testFile = path.join(checkPath, '.test_write');
        fs.writeFileSync(testFile, 'ok');
        fs.unlinkSync(testFile);
        
        res.json({ success: true, message: 'Path is valid and writable' });
    } catch (e) {
        res.status(400).json({ error: `Invalid path: ${e.message}` });
    }
});

// --- Recordings ---
// Helper to get base path
function getStoragePath() {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'storage_path'").get();
    return row ? row.value : path.join(process.cwd(), 'recordings');
}

app.get('/api/recordings/:id', (req, res) => {
    // List recordings for a camera
    const { id } = req.params;
    const basePath = getStoragePath();
    const recPath = path.join(basePath, id);
    
    if (fs.existsSync(recPath)) {
        try {
            const files = fs.readdirSync(recPath).map(f => {
                const stat = fs.statSync(path.join(recPath, f));
                return {
                    name: f,
                    size: stat.size,
                    mtime: stat.mtime
                };
            });
            res.json(files);
        } catch(e) {
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
    // ... existing ...
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

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
