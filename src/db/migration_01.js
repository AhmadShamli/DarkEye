const db = require('./index');

try {
    db.exec(`ALTER TABLE cameras ADD COLUMN segment_duration INTEGER DEFAULT 15`);
    console.log("Added segment_duration column.");
} catch (e) {
    if (e.message.includes('duplicate column')) {
        console.log("Column segment_duration already exists.");
    } else {
        console.error("Migration error:", e.message);
    }
}
