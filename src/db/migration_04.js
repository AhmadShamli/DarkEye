const db = require('./index');

try {
    const tableInfo = db.prepare("PRAGMA table_info(cameras)").all();
    const hasAudioOutput = tableInfo.some(c => c.name === 'audio_output_supported');
    
    if (!hasAudioOutput) {
        db.prepare("ALTER TABLE cameras ADD COLUMN audio_output_supported INTEGER DEFAULT 0").run();
        console.log("Migration 04: Added audio_output_supported column to cameras.");
    }
} catch (e) {
    console.error("Migration 04 error:", e.message);
}
