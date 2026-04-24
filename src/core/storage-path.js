const fs = require('fs');
const path = require('path');
const os = require('os');
const db = require('../db');

const TEMP_ROOT = process.platform === 'win32'
    ? path.join(os.tmpdir(), 'darkeye-memory')
    : (fs.existsSync('/dev/shm') ? path.join('/dev/shm', 'darkeye-memory') : path.join(os.tmpdir(), 'darkeye-memory'));

function getConfiguredStoragePath() {
    try {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'storage_path'").get();
        if (row?.value) return row.value;
    } catch (e) {}
    return path.join(process.cwd(), 'recordings');
}

function isWritableDir(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, `.probe-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        return true;
    } catch (e) {
        return false;
    }
}

function getActiveStoragePath() {
    const configured = getConfiguredStoragePath();
    if (isWritableDir(configured)) {
        return { path: configured, isFallback: false, reason: null };
    }

    const tempPath = TEMP_ROOT;
    try {
        fs.mkdirSync(tempPath, { recursive: true });
    } catch (e) {}
    return {
        path: tempPath,
        isFallback: true,
        reason: `Configured storage unavailable; using temporary memory storage at ${tempPath}`
    };
}

function getTemporaryStorageLimitBytes() {
    const total = os.totalmem();
    const free = os.freemem();
    return Math.max(0, Math.floor(Math.min(total * 0.3, free * 0.5)));
}

function getTempRootPath() {
    return TEMP_ROOT;
}

module.exports = {
    getConfiguredStoragePath,
    getActiveStoragePath,
    getTemporaryStorageLimitBytes,
    getTempRootPath,
    isWritableDir
};
