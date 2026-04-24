const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const ffmpegManager = require('./ffmpeg-manager');
const { getActiveStoragePath } = require('./storage-path');

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
        
        const storage = getActiveStoragePath();
        const basePath = storage.path;
        if (storage.isFallback) {
            console.warn(`[ThumbnailMgr] ${storage.reason}`);
        }

        try {
            fs.mkdirSync(basePath, { recursive: true });
        } catch (e) {
            console.error(`[ThumbnailMgr] Failed to create storage path ${basePath}:`, e.message);
            return;
        }

        const camDir = path.join(basePath, cam.id);
        try {
            fs.mkdirSync(camDir, { recursive: true });
        } catch (e) {
            console.error(`[ThumbnailMgr] Failed to create camera dir ${camDir}:`, e.message);
            return;
        }

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
