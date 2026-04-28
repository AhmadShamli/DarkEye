const fs = require('fs');
const path = require('path');
const db = require('../db');
const { getActiveStoragePath, getTemporaryStorageLimitBytes, getTempRootPath, getStorageDiskInfo, getAdaptiveStorageLimitBytes, getBooleanSetting } = require('./storage-path');

class StorageManager {
    constructor() {
        this.baseDir = path.join(process.cwd(), 'recordings');
        this.interval = null;
        this.mountCheckInterval = null;
        this.tempLimitBytes = 0;
        this.lastStorageCapacityBytes = null;
    }

    start() {
        const storage = getActiveStoragePath();
        this.baseDir = storage.path;
        this.isFallback = storage.isFallback;
        this.tempLimitBytes = this.isFallback ? getTemporaryStorageLimitBytes() : 0;
        if (storage.isFallback) {
            console.warn(`[Storage] ${storage.reason}`);
            console.warn(`[Storage] Temporary storage limit set to ${(this.tempLimitBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`);
        } else {
            console.log(`[Storage] Using configured storage path: ${this.baseDir}`);
            this.migrateTempStorage(storage.path);
        }

        // Load interval from DB
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('cleanup_interval_min');
        const intervalMin = row ? parseInt(row.value) : 60;
        
        console.log(`[Storage] Starting cleanup scheduler (every ${intervalMin} mins)`);
        
        // Run immediately then schedule
        this.cleanup();

        this.interval = setInterval(() => this.cleanup(), intervalMin * 60 * 1000);

        if (getBooleanSetting('storage_mount_retry', false)) {
            if (this.mountCheckInterval) clearInterval(this.mountCheckInterval);
            this.mountCheckInterval = setInterval(() => this.syncManagedStorage(), 5000);
            this.syncManagedStorage();
        }
    }
    
    stop() {
        clearInterval(this.interval);
        clearInterval(this.mountCheckInterval);
        this.interval = null;
        this.mountCheckInterval = null;
    }

    restartRecordersOnly() {
        try {
            const cameraManager = require('./camera-manager');
            const cameras = db.prepare('SELECT * FROM cameras WHERE record_enabled = 1').all();
            for (const cam of cameras) {
                cameraManager.stopCamera(cam.id, true);
                cameraManager.startCamera(cam, true);
            }
        } catch (e) {
            console.error('[Storage] Failed to restart recorders after storage change:', e.message);
        }
    }

    syncManagedStorage() {
        if (!getBooleanSetting('storage_mount_retry', false)) return;

        const storage = getActiveStoragePath();
        const changedPath = storage.path !== this.baseDir;
        const changedMode = storage.isFallback !== this.isFallback;

        if (!changedPath && !changedMode) return;

        const wasFallback = this.isFallback;
        this.baseDir = storage.path;
        this.isFallback = storage.isFallback;

        if (this.isFallback) {
            if (!this.tempLimitBytes) {
                this.tempLimitBytes = getTemporaryStorageLimitBytes();
            }
            console.warn(`[Storage] Mounted storage lost. Switching to temporary storage at ${this.baseDir}`);
            this.restartRecordersOnly();
            return;
        }

        this.tempLimitBytes = 0;
        if (wasFallback) {
            console.log(`[Storage] Mounted storage recovered. Switching back to ${this.baseDir}`);
            this.migrateTempStorage(this.baseDir);
            this.restartRecordersOnly();
        }
    }

    async cleanup() {
        const storage = getActiveStoragePath();
        const wasFallback = this.isFallback;
        this.baseDir = storage.path;
        this.isFallback = storage.isFallback;
        if (!this.isFallback) {
            this.tempLimitBytes = 0;
            if (wasFallback) {
                console.log(`[Storage] Storage recovered. Switching back to ${this.baseDir}`);
                this.migrateTempStorage(this.baseDir);
            } else {
                this.migrateTempStorage(this.baseDir);
            }
        } else if (!this.tempLimitBytes) {
            this.tempLimitBytes = getTemporaryStorageLimitBytes();
            console.warn(`[Storage] Temporary storage limit locked at ${(this.tempLimitBytes / (1024 * 1024 * 1024)).toFixed(2)} GB for this fallback session`);
        }

        console.log(`[Storage] Running cleanup check on ${this.baseDir}...`);
        
        try {
            const maxStorageRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('max_storage_gb');
            const retentionRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('retention_hours');
            const maxStorageGB = parseFloat(maxStorageRow?.value || '0');
            const retentionHours = parseFloat(retentionRow?.value || '0');
            const configuredLimitBytes = maxStorageGB && maxStorageGB > 0 ? maxStorageGB * 1024 * 1024 * 1024 : 0;
            const diskInfo = await getStorageDiskInfo(this.baseDir);

            if (diskInfo?.totalBytes && this.lastStorageCapacityBytes && this.lastStorageCapacityBytes !== diskInfo.totalBytes) {
                console.warn(`[Storage] Storage capacity changed for ${this.baseDir}: ${(this.lastStorageCapacityBytes / (1024 * 1024 * 1024)).toFixed(2)} GB -> ${(diskInfo.totalBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`);
            }
            if (diskInfo?.totalBytes) {
                this.lastStorageCapacityBytes = diskInfo.totalBytes;
            }
            
            // Verify baseDir exists
            if (!fs.existsSync(this.baseDir)) return;

            // Gather ALL files recursively (Main + Timelapse)
            let allFiles = [];
            const cameras = this.getDirectories(this.baseDir);
            cameras.forEach(camId => {
                const camDir = path.join(this.baseDir, camId);
                this._gatherFiles(camDir, allFiles);
            });

            // 1. Retention by Time
            if (retentionHours && retentionHours > 0) {
                const maxAgeMs = retentionHours * 60 * 60 * 1000;
                const now = Date.now();
                
                // Filter in place? No, just iterate.
                // We keep a new list of survivors for Size check
                const survivors = [];
                
                for (const file of allFiles) {
                    if (now - file.mtime > maxAgeMs) {
                         console.log(`[Storage] Deleting old file: ${path.basename(file.path)} (${((now - file.mtime) / 3600000).toFixed(1)} hrs old)`);
                         try {
                             fs.unlinkSync(file.path);
                         } catch(e) { console.error(`Failed to delete ${file.path}`, e.message); }
                    } else {
                        survivors.push(file);
                    }
                }
                allFiles = survivors;
            }

            // 2. Retention by Size
            const maxBytes = this.isFallback ? this.tempLimitBytes : getAdaptiveStorageLimitBytes(configuredLimitBytes, diskInfo);
            if (maxBytes > 0) {
                let totalSize = allFiles.reduce((acc, f) => acc + f.size, 0);
                const cleanupThreshold = this.isFallback ? Math.floor(maxBytes * 0.7) : maxBytes;
                
                const limitLabel = this.isFallback
                    ? `${(maxBytes / (1024 * 1024 * 1024)).toFixed(2)} GB (temp)`
                    : `${(maxBytes / (1024 * 1024 * 1024)).toFixed(2)} GB${configuredLimitBytes && maxBytes < configuredLimitBytes ? ' (adaptive)' : ''}`;
                console.log(`[Storage] Current size: ${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB / Limit: ${limitLabel}`);

                if (totalSize > cleanupThreshold) {
                    // Sort by oldest first
                    allFiles.sort((a, b) => a.mtime - b.mtime);

                    for (const file of allFiles) {
                        if (totalSize <= cleanupThreshold) break;
                        
                        console.log(`[Storage] Quota exceeded. Deleting: ${path.basename(file.path)}`);
                        try {
                            fs.unlinkSync(file.path);
                            totalSize -= file.size;
                        } catch(e) {
                            console.error(`Error deleting ${file.path}`, e);
                        }
                    }
                }
            }
            
        } catch (e) {
            console.error('[Storage] Cleanup failed:', e);
        }
    }

    migrateTempStorage(destinationRoot) {
        const tempRoot = getTempRootPath();
        if (!fs.existsSync(tempRoot)) return;
        if (!fs.existsSync(destinationRoot)) {
            try {
                fs.mkdirSync(destinationRoot, { recursive: true });
            } catch (e) {
                console.error(`[Storage] Failed to prepare recovery destination ${destinationRoot}:`, e.message);
                return;
            }
        }

        const tempCameras = this.getDirectories(tempRoot);
        if (tempCameras.length === 0) return;

        console.log(`[Storage] Migrating temporary files from ${tempRoot} to ${destinationRoot}...`);

        const now = Date.now();
        const stableAgeMs = 30 * 1000;
        let movedCount = 0;
        let pendingCount = 0;

        for (const camId of tempCameras) {
            const fromCamDir = path.join(tempRoot, camId);
            const toCamDir = path.join(destinationRoot, camId);
            try {
                fs.mkdirSync(toCamDir, { recursive: true });
                const result = this._moveDirectoryContents(fromCamDir, toCamDir, now, stableAgeMs);
                movedCount += result.moved;
                pendingCount += result.pending;
            } catch (e) {
                console.error(`[Storage] Failed to migrate camera ${camId}:`, e.message);
            }
        }

        console.log(`[Storage] Migration result: moved=${movedCount}, pending=${pendingCount}`);

        try {
            if (this.getDirectories(tempRoot).length === 0) {
                fs.rmSync(tempRoot, { recursive: true, force: true });
            }
        } catch (e) {
            console.error(`[Storage] Failed to clean temporary storage root ${tempRoot}:`, e.message);
        }
    }

    _moveDirectoryContents(fromDir, toDir, now, stableAgeMs) {
        if (!fs.existsSync(fromDir)) return { moved: 0, pending: 0 };
        const entries = fs.readdirSync(fromDir, { withFileTypes: true });
        let moved = 0;
        let pending = 0;
        for (const entry of entries) {
            const fromPath = path.join(fromDir, entry.name);
            const toPath = path.join(toDir, entry.name);
            try {
                if (entry.isDirectory()) {
                    fs.mkdirSync(toPath, { recursive: true });
                    const result = this._moveDirectoryContents(fromPath, toPath, now, stableAgeMs);
                    moved += result.moved;
                    pending += result.pending;
                    fs.rmSync(fromPath, { recursive: true, force: true });
                } else {
                    const stat = fs.statSync(fromPath);
                    const ageMs = now - stat.mtimeMs;
                    if (ageMs < stableAgeMs) {
                        pending += 1;
                        continue;
                    }
                    fs.renameSync(fromPath, toPath);
                    moved += 1;
                }
            } catch (e) {
                console.error(`[Storage] Failed to move ${fromPath} -> ${toPath}:`, e.message);
            }
        }
        return { moved, pending };
    }

    _gatherFiles(dir, fileList) {
        if (!fs.existsSync(dir)) return;
        try {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);
                if (stat.isDirectory()) {
                    this._gatherFiles(filePath, fileList);
                } else {
                    fileList.push({ path: filePath, mtime: stat.mtimeMs, size: stat.size });
                }
            }
        } catch (e) {
            console.error(`[Storage] Error scanning ${dir}:`, e.message);
        }
    }

    // Deprecated specific methods in favor of unified valid approach
    cleanupByTime(hours) {} 
    cleanupBySize(maxGB) {}

    getDirectories(source) {
        if (!fs.existsSync(source)) return [];
        return fs.readdirSync(source, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);
    }
}

module.exports = new StorageManager();
