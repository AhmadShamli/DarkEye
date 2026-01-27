const db = require('../db');
const Recorder = require('./recorder');
const mediamtxManager = require('./mediamtx-manager');

class CameraManager {
    constructor() {
        this.recorders = new Map(); // id -> Recorder instance
    }

    async init() {
        // Ensure MediaMTX config is up to date and running
        // Using mediamtxManager.init() in server.js handles start, 
        // but here we might want to ensure it's doing checking.
        
        // Load all cameras from DB and start if enabled
        const cameras = db.prepare('SELECT * FROM cameras').all();
        console.log(`[CameraMgr] Loading ${cameras.length} cameras...`);
        
        for (const cam of cameras) {
            if (cam.record_enabled) {
                this.startCamera(cam, false); // Don't restart service for each one
            }
        }
    }

    // skipRestart: true during mass init to avoid N restarts
    startCamera(config, skipRestart = false) {
        this.stopCamera(config.id, skipRestart);
        
        console.log(`[CameraMgr] Starting camera ${config.name} (${config.id})`);
        
        // 1. Update MediaMTX Config (It pulls the stream)
        if (!skipRestart) {
            mediamtxManager.updateConfig();
            mediamtxManager.restart();
        }

        // 2. Start Recorder (Delayed)
        // Wait for MediaMTX to come back up (~1-2s)
        setTimeout(() => {
            const recorder = new Recorder(config);
            recorder.start();
            this.recorders.set(config.id, recorder);
        }, 3000); 
    }

    stopCamera(id, skipRestart = false) {
        console.log(`[CameraMgr] Stopping camera ${id}`);
        
        const recorder = this.recorders.get(id);
        if (recorder) {
            recorder.stop();
            this.recorders.delete(id);
        }

        // We don't really 'stop' the MediaMTX stream specifically, 
        // but regenerating config without it will stop it.
        // However, if we are just stopping recording but keeping the camera in DB,
        // we might still want to keep the live stream available?
        // For now, let's assume stopCamera is called when deleting or disabling.
        // If disabling, we should probably update config.
    }

    restartCamera(id) {
        // Reload config from DB
        const config = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
        if (config) {
            // Stop but don't restart service yet
            this.stopCamera(id, true); 
            
            if (config.record_enabled) {
                // Start and restart service
                this.startCamera(config, false);
            } else {
                 // Just update config if we disabled it
                 mediamtxManager.updateConfig();
                 mediamtxManager.restart();
            }
        }
    }
    
    getRecorder(id) {
        return this.recorders.get(id);
    }
}

module.exports = new CameraManager();
