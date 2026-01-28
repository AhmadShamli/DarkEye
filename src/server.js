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
