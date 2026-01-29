const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(process.cwd(), 'data', 'darkeye.db');
console.log(`Migrating database at: ${dbPath}`);

const db = new Database(dbPath);

try {
    const tableInfo = db.prepare("PRAGMA table_info(cameras)").all();
    const hasPtz = tableInfo.some(c => c.name === 'ptz_enabled');
    
    if (!hasPtz) {
        console.log("Adding ptz_enabled column...");
        db.prepare("ALTER TABLE cameras ADD COLUMN ptz_enabled INTEGER DEFAULT 0").run();
        console.log("Migration successful!");
    } else {
        console.log("Column ptz_enabled already exists.");
    }
} catch (e) {
    console.error("Migration failed:", e.message);
}
