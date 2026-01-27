const db = require('./index');

try {
    db.exec(`ALTER TABLE cameras ADD COLUMN onvif_service_url TEXT`);
    console.log("Added onvif_service_url column.");
} catch (e) {}

try {
    db.exec(`ALTER TABLE cameras ADD COLUMN substream_url TEXT`);
    console.log("Added substream_url column.");
} catch (e) {}
