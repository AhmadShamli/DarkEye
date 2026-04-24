const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(process.cwd(), 'data');
if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath);
}

const dbFile = path.join(dbPath, 'darkeye.db');

let db;
let SQL;

async function initDatabase() {
    SQL = await initSqlJs();
    const dbExists = fs.existsSync(dbFile);
    if (!dbExists) {
        console.log(`[DB] Database file not found: ${dbFile}`);
    } else {
        console.log(`[DB] Using existing database file: ${dbFile}`);
    }

    const fileBuffer = dbExists ? fs.readFileSync(dbFile) : undefined;
    db = new SQL.Database(fileBuffer);
    
    db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS cameras (
            id TEXT PRIMARY KEY,
            name TEXT,
            type TEXT,
            url TEXT,
            username TEXT,
            password TEXT,
            status TEXT,
            record_enabled INTEGER DEFAULT 1,
            record_mode TEXT DEFAULT 'raw',
            segment_duration INTEGER DEFAULT 15,
            timelapse_enabled INTEGER DEFAULT 0,
            timelapse_interval INTEGER DEFAULT 5,
            timelapse_duration INTEGER DEFAULT 60,
            onvif_service_url TEXT,
            substream_url TEXT,
            ptz_enabled INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE,
            password_hash TEXT,
            role TEXT DEFAULT 'user',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    insertSetting.run('max_storage_gb', '500');
    insertSetting.run('retention_hours', '72');
    insertSetting.run('cleanup_interval_min', '60');
    insertSetting.run('storage_path', path.join(process.cwd(), 'recordings'));
    
    saveDatabase();

    if (!dbExists && fs.existsSync(dbFile)) {
        console.log(`[DB] Database file created: ${dbFile}`);
    }
}

function saveDatabase() {
    if (db) {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(dbFile, buffer);
    }
}

function getDbFilePath() {
    return dbFile;
}

function testDatabase() {
    if (!db) {
        throw new Error('Database not initialized');
    }

    const row = prepare('SELECT 1 AS ok').get();
    const userCount = prepare('SELECT COUNT(*) AS count FROM users').get();

    return {
        ok: row?.ok === 1,
        userCount: userCount?.count ?? null,
        fileExists: fs.existsSync(dbFile),
        fileSize: fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0
    };
}

function exec(sql) {
    db.exec(sql);
    saveDatabase();
}

function prepare(sql) {
    const stmt = db.prepare(sql);
    return {
        run: (...params) => {
            stmt.run(...params);
            saveDatabase();
            stmt.free();
        },
        get: (...params) => {
            stmt.bind(...params);
            if (stmt.step()) {
                const row = stmt.getAsObject();
                stmt.free();
                return row;
            }
            stmt.free();
            return undefined;
        },
        all: (...params) => {
            const rows = [];
            stmt.bind(...params);
            while (stmt.step()) {
                rows.push(stmt.getAsObject());
            }
            stmt.free();
            return rows;
        }
    };
}

module.exports = {
    init: initDatabase,
    exec,
    prepare,
    getDbFilePath,
    testDatabase
};
