const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(process.cwd(), 'data');
if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath);
}

const db = new Database(path.join(dbPath, 'darkeye.db'));

// Initialize tables
db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );

    CREATE TABLE IF NOT EXISTS cameras (
        id TEXT PRIMARY KEY,
        name TEXT,
        type TEXT, -- 'rtsp', 'onvif', 'usb'
        url TEXT,
        username TEXT,
        password TEXT,
        status TEXT, -- 'online', 'offline'
        record_enabled INTEGER DEFAULT 1,
        record_mode TEXT DEFAULT 'raw', -- 'raw', 'encode'
        timelapse_enabled INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

// Migrations (Safe column additions)
try { db.exec("ALTER TABLE cameras ADD COLUMN timelapse_interval INTEGER DEFAULT 5"); } catch (e) {}
try { db.exec("ALTER TABLE cameras ADD COLUMN timelapse_duration INTEGER DEFAULT 60"); } catch (e) {}
try { db.exec("ALTER TABLE cameras ADD COLUMN onvif_service_url TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE cameras ADD COLUMN substream_url TEXT"); } catch (e) {}

// Seed default settings if not exist
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
insertSetting.run('max_storage_gb', '500'); // Default 500GB
insertSetting.run('retention_hours', '72'); // Default 3 days
insertSetting.run('cleanup_interval_min', '60'); // Default 1 hour

module.exports = db;
