const db = require('./index');
const path = require('path');

try {
    const defaultPath = path.join(process.cwd(), 'recordings');
    // Check if key exists
    const exists = db.prepare("SELECT 1 FROM settings WHERE key = 'storage_path'").get();
    if (!exists) {
        db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run('storage_path', defaultPath);
        console.log("Added storage_path setting.");
    }
} catch (e) {
    console.error("Migration error:", e.message);
}
