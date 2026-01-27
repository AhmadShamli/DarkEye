const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const https = require('https');
const db = require('../db'); // Need DB access

const BIN_DIR = path.join(process.cwd(), 'bin');
const MEDIAMTX_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx');
const CONFIG_PATH = path.join(BIN_DIR, 'mediamtx.yml');

// Release URL (pinned v1.9.3 for stability)
const DOWNLOAD_URL = process.platform === 'win32' 
    ? 'https://github.com/bluenviron/mediamtx/releases/download/v1.9.3/mediamtx_v1.9.3_windows_amd64.zip'
    : 'https://github.com/bluenviron/mediamtx/releases/download/v1.9.3/mediamtx_v1.9.3_linux_amd64.tar.gz';

class MediaMTXManager {
    constructor() {
        this.process = null;
    }

    async init() {
        if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

        if (!fs.existsSync(MEDIAMTX_PATH)) {
            console.log('[MediaMTX] Binary not found. Downloading...');
            await this.download();
        } else {
            console.log('[MediaMTX] Binary found.');
        }

        this.updateConfig();
    }

    updateConfig() {
        console.log('[MediaMTX] Generating configuration...');
        const cameras = db.prepare('SELECT * FROM cameras').all();
        
        let config = `
rtspAddress: :8554
protocols: [tcp]

webrtcAddress: :8889
webrtcICEHostNAT1To1IPs: [127.0.0.1]

paths:
`;
        
        if (cameras.length === 0) {
            config += `  all:\n    runOnDemand: no\n`;
        } else {
             cameras.forEach(cam => {
                let source = cam.url;
                // Add credentials if needed
                if (cam.username && cam.password && source.startsWith('rtsp://') && !source.includes('@')) {
                     const parts = source.split('://');
                     source = `${parts[0]}://${encodeURIComponent(cam.username)}:${encodeURIComponent(cam.password)}@${parts[1]}`;
                }

                config += `
  live/${cam.id}:
    source: ${source}
    sourceOnDemand: yes
    sourceProtocol: tcp
`;
             });
        }

        fs.writeFileSync(CONFIG_PATH, config);
        console.log('[MediaMTX] Config updated.');
    }

    async download() {
        const zipPath = path.join(BIN_DIR, 'mediamtx.zip');
        
        // Helper to handle redirects
        const downloadFile = (url) => {
            return new Promise((resolve, reject) => {
                https.get(url, response => {
                    if (response.statusCode === 301 || response.statusCode === 302) {
                        return downloadFile(response.headers.location).then(resolve).catch(reject);
                    }
                    if (response.statusCode !== 200) {
                        return reject(new Error(`Failed to download: ${response.statusCode}`));
                    }
                    const file = fs.createWriteStream(zipPath);
                    response.pipe(file);
                    file.on('finish', () => {
                        file.close(resolve);
                    });
                }).on('error', err => {
                     fs.unlink(zipPath, () => {});
                     reject(err);
                });
            });
        };

        console.log(`[MediaMTX] Downloading from ${DOWNLOAD_URL}...`);
        await downloadFile(DOWNLOAD_URL);

        // 2. Extract
        console.log('[MediaMTX] Extracting...');
        if (process.platform === 'win32') {
            await this.extractZip(zipPath);
        } else {
            // Linux: tar
            await new Promise((resolve, reject) => {
                const tar = spawn('tar', ['-xzf', zipPath, '-C', BIN_DIR]);
                tar.on('close', code => code === 0 ? resolve() : reject(new Error('tar failed')));
            });
        }

        fs.unlinkSync(zipPath); // Cleanup
        
        if (!fs.existsSync(MEDIAMTX_PATH)) {
             throw new Error('Extraction success but binary still missing. Check contents.');
        }
        console.log('[MediaMTX] Download complete.');
    }

    async extractZip(zipPath) {
        // Use PowerShell's built-in unzip so we don't need extra deps
        const psCommand = `Expand-Archive -Path "${zipPath}" -DestinationPath "${BIN_DIR}" -Force`;
        return new Promise((resolve, reject) => {
            const ps = spawn('powershell.exe', ['-NoProfile', '-Command', psCommand]);
             ps.stderr.on('data', (d) => console.error(`[Unzip] ${d}`));
            ps.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error('Unzip failed'));
            });
        });
    }

    start() {
        if (this.process) return;

        console.log('[MediaMTX] Starting server...');
        this.process = spawn(MEDIAMTX_PATH, [CONFIG_PATH], {
            cwd: BIN_DIR,
            stdio: 'inherit', // Let it log to our console
            detached: false 
        });

        this.process.on('error', err => console.error('[MediaMTX] Failed to start:', err));
        this.process.on('exit', (code, signal) => {
             console.log(`[MediaMTX] Exited with code ${code} signal ${signal}`);
             this.process = null;
        });
    }
    
    restart() {
        if (this.process) {
            console.log('[MediaMTX] Restarting to apply config...');
            this.process.kill();
            this.process = null;
            setTimeout(() => this.start(), 1000); // Give it a sec to unbind ports
        } else {
            this.start();
        }
    }

    stop() {
        if (this.process) {
            console.log('[MediaMTX] Stopping...');
            this.process.kill();
            this.process = null;
        }
    }
}

module.exports = new MediaMTXManager();
