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
app.use('/hls', express.static(path.join(process.cwd(), 'public', 'hls')));
app.use('/recordings', express.static(path.join(process.cwd(), 'recordings')));

// ... (Authentication) ...

// ... (Recordings API) ...
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
