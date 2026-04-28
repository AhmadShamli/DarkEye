const fs = require('fs');
const path = require('path');
const os = require('os');
const si = require('systeminformation');
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

function getBooleanSetting(key, fallback = false) {
    try {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        if (!row || row.value === undefined || row.value === null) return fallback;
        return ['1', 'true', 'yes', 'on'].includes(String(row.value).toLowerCase());
    } catch (e) {
        return fallback;
    }
}

function getNumericSetting(key, fallback = 0) {
    try {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        const parsed = parseFloat(row?.value);
        return Number.isFinite(parsed) ? parsed : fallback;
    } catch (e) {
        return fallback;
    }
}

function getFilesystemCapacityBytes(targetPath) {
    try {
        if (typeof fs.statfsSync !== 'function') return null;
        const stat = fs.statfsSync(targetPath);
        const totalBytes = Math.max(0, Math.floor(Number(stat.blocks) * Number(stat.bsize)));
        const availableBytes = Math.max(0, Math.floor(Number(stat.bavail) * Number(stat.bsize)));
        return { totalBytes, availableBytes };
    } catch (e) {
        return null;
    }
}

function getActiveStoragePath() {
    const configured = getConfiguredStoragePath();
    const mountRetryEnabled = getBooleanSetting('storage_mount_retry', false);
    if (!mountRetryEnabled && isWritableDir(configured)) {
        return { path: configured, isFallback: false, reason: null };
    }

    const maxStorageGB = getNumericSetting('max_storage_gb', 0);
    const requiredBytes = maxStorageGB > 0 ? Math.floor(maxStorageGB * 1024 * 1024 * 1024) : 0;

    if (mountRetryEnabled) {
        const diskInfo = getFilesystemCapacityBytes(configured);
        if (diskInfo && (!requiredBytes || diskInfo.totalBytes >= requiredBytes) && isWritableDir(configured)) {
            return { path: configured, isFallback: false, reason: null };
        }
    } else if (isWritableDir(configured)) {
        return { path: configured, isFallback: false, reason: null };
    }

    const tempPath = TEMP_ROOT;
    try {
        fs.mkdirSync(tempPath, { recursive: true });
    } catch (e) {}
    return {
        path: tempPath,
        isFallback: true,
        reason: mountRetryEnabled
            ? `Mounted storage unavailable or below configured size; using temporary memory storage at ${tempPath}`
            : `Configured storage unavailable; using temporary memory storage at ${tempPath}`
    };
}

function getTemporaryStorageLimitBytes() {
    const total = os.totalmem();
    const free = os.freemem();
    return Math.max(0, Math.floor(Math.min(total * 0.3, free * 0.5)));
}

async function getStorageDiskInfo(targetPath) {
    try {
        const disks = await si.fsSize();
        const normalizedPath = path.resolve(targetPath).toLowerCase();
        let matchedDisk = null;

        for (const disk of disks) {
            const mount = path.resolve(disk.mount).toLowerCase();
            if (normalizedPath.startsWith(mount)) {
                if (!matchedDisk || mount.length > path.resolve(matchedDisk.mount).length) {
                    matchedDisk = disk;
                }
            }
        }

        if (!matchedDisk) return null;

        const totalBytes = Math.max(0, Math.floor(matchedDisk.size || 0));
        const availableBytes = Math.max(0, Math.floor(matchedDisk.available || 0));

        return {
            mount: matchedDisk.mount,
            totalBytes,
            availableBytes,
            usedBytes: Math.max(0, totalBytes - availableBytes)
        };
    } catch (e) {
        return null;
    }
}

function getAdaptiveStorageLimitBytes(configuredLimitBytes, diskInfo) {
    if (!configuredLimitBytes || configuredLimitBytes <= 0) return 0;
    if (!diskInfo?.totalBytes) return configuredLimitBytes;
    if (diskInfo.totalBytes >= configuredLimitBytes) return configuredLimitBytes;

    return Math.max(0, Math.floor(diskInfo.availableBytes * 0.5));
}

function getTempRootPath() {
    return TEMP_ROOT;
}

module.exports = {
    getConfiguredStoragePath,
    getActiveStoragePath,
    getTemporaryStorageLimitBytes,
    getBooleanSetting,
    getNumericSetting,
    getFilesystemCapacityBytes,
    getStorageDiskInfo,
    getAdaptiveStorageLimitBytes,
    getTempRootPath,
    isWritableDir
};
