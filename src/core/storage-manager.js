const fs = require('fs');
const path = require('path');
const db = require('../db');

class StorageManager {
    constructor() {
        this.baseDir = path.join(process.cwd(), 'recordings');
        this.interval = null;
    }

    start() {
        // Load interval from DB
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('cleanup_interval_min');
        const intervalMin = row ? parseInt(row.value) : 60;
        
        console.log(`[Storage] Starting cleanup scheduler (every ${intervalMin} mins)`);
        
        // Run immediately then schedule
        this.cleanup();
        
        this.interval = setInterval(() => this.cleanup(), intervalMin * 60 * 1000);
    }
    
    stop() {
        clearInterval(this.interval);
    }

    async cleanup() {
        // Refresh baseDir from settings
        try {
             const row = db.prepare("SELECT value FROM settings WHERE key = 'storage_path'").get();
             if (row) this.baseDir = row.value;
             else this.baseDir = path.join(process.cwd(), 'recordings');
        } catch(e) {}

        console.log(`[Storage] Running cleanup check on ${this.baseDir}...`);
        
        try {
            const maxStorageGB = parseFloat(db.prepare('SELECT value FROM settings WHERE key = ?').get('max_storage_gb').value);
            const retentionHours = parseFloat(db.prepare('SELECT value FROM settings WHERE key = ?').get('retention_hours').value);
            
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
            if (maxStorageGB && maxStorageGB > 0) {
                const maxBytes = maxStorageGB * 1024 * 1024 * 1024;
                let totalSize = allFiles.reduce((acc, f) => acc + f.size, 0);
                
                console.log(`[Storage] Current size: ${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB / Limit: ${maxStorageGB} GB`);

                if (totalSize > maxBytes) {
                    // Sort by oldest first
                    allFiles.sort((a, b) => a.mtime - b.mtime);

                    for (const file of allFiles) {
                        if (totalSize <= maxBytes) break;
                        
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
