const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const ffmpegManager = require('./ffmpeg-manager');

class ThumbnailManager {
    constructor() {
        this.interval = null;
        this.INTERVAL_MS = 60000; // Update every minute
    }

    start() {
        if (this.interval) clearInterval(this.interval);
        console.log('[ThumbnailMgr] Started.');
        this.runLoop();
        this.interval = setInterval(() => this.runLoop(), this.INTERVAL_MS);
    }

    stop() {
        if (this.interval) clearInterval(this.interval);
        this.interval = null;
    }

    async runLoop() {
        if (!ffmpegManager.getPath()) await ffmpegManager.init();
        ffmpeg.setFfmpegPath(ffmpegManager.getPath());

        const cameras = db.prepare('SELECT * FROM cameras').all();
        
        for (const cam of cameras) {
            this.generateThumbnail(cam);
        }
    }

    generateThumbnail(cam) {
        // We pull from MediaMTX Proxy for speed and stability
        const inputUrl = `rtsp://127.0.0.1:8554/live/${cam.id}`;
        
        // Get storage path
        let basePath = path.join(process.cwd(), 'recordings');
        try {
            const row = db.prepare("SELECT value FROM settings WHERE key = 'storage_path'").get();
            if (row) basePath = row.value;
        } catch(e) {}
        
        const camDir = path.join(basePath, cam.id);
        if (!fs.existsSync(camDir)) fs.mkdirSync(camDir, { recursive: true });

        const thumbPath = path.join(camDir, 'thumbnail.jpg');

        ffmpeg(inputUrl)
            .inputOptions([
                '-rtsp_transport tcp',
                '-fflags nobuffer',
                '-allowed_media_types video'
            ])
            .outputOptions([
                '-frames:v 1',
                '-q:v 5', // Quality
                '-update 1'
            ])
            .output(thumbPath)
            .on('end', () => {
                // console.log(`[ThumbnailMgr] Updated ${cam.id}`);
            })
            .on('error', (err) => {
                // Silent error, will retry next loop
                // console.error(`[ThumbnailMgr] Failed ${cam.id}: ${err.message}`);
            })
            .run();
    }
}

module.exports = new ThumbnailManager();
