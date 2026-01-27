const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const axios = require('axios');
const Stream = require('stream');
const util = require('util');
const pipeline = util.promisify(Stream.pipeline);

// We need a zip extractor. 
// Since we didn't add one to package.json, we might need to rely on system tools or add 'ADM-ZIP' or 'unzipper'
// For now, I'll add 'adm-zip' to the plan and install it, or use system tar/powershell for unzip.
// To keep it simple cross-platform, 'adm-zip' is better.

class FFmpegManager {
    constructor() {
        this.binDir = path.join(process.cwd(), 'bin');
        this.ffmpegPath = null;
        this.ffprobePath = null;
    }

    async init() {
        // 1. Check global path
        try {
            execSync('ffmpeg -version', { stdio: 'ignore' });
            this.ffmpegPath = 'ffmpeg';
        } catch (e) {}

        try {
            execSync('ffprobe -version', { stdio: 'ignore' });
            this.ffprobePath = 'ffprobe';
        } catch (e) {}

        if (this.ffmpegPath && this.ffprobePath) {
            console.log('FFmpeg/FFprobe found in system PATH');
            return;
        }

        // 2. Check local bin
        if (!fs.existsSync(this.binDir)) {
            fs.mkdirSync(this.binDir);
        }

        const localExt = os.platform() === 'win32' ? '.exe' : '';
        const localFfmpeg = path.join(this.binDir, `ffmpeg${localExt}`);
        const localFfprobe = path.join(this.binDir, `ffprobe${localExt}`);

        if (fs.existsSync(localFfmpeg)) this.ffmpegPath = localFfmpeg;
        if (fs.existsSync(localFfprobe)) this.ffprobePath = localFfprobe;

        if (this.ffmpegPath && this.ffprobePath) {
            console.log('FFmpeg/FFprobe found locally');
            return;
        }

        // 3. Download if missing
        console.log('Downloading FFmpeg/FFprobe...');
        await this.downloadFFmpeg();
        
        // Recheck
        if (fs.existsSync(localFfmpeg)) this.ffmpegPath = localFfmpeg;
        if (fs.existsSync(localFfprobe)) this.ffprobePath = localFfprobe;
    }

    async downloadFFmpeg() {
        const platform = os.platform();
        const arch = os.arch();
        let url = '';
        let archiveName = 'ffmpeg.zip'; // or .tar.xz

        if (platform === 'win32') {
            // Windows
            url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
        } else if (platform === 'linux') {
            // Linux
            if (arch === 'x64') {
                url = 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz';
                archiveName = 'ffmpeg.tar.xz';
            } else if (arch === 'arm64') {
                 url = 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz';
                 archiveName = 'ffmpeg.tar.xz';
            } else {
                 throw new Error('Unsupported Architecture for auto-download: ' + arch);
            }
        } else {
            throw new Error('Unsupported Platform for auto-download: ' + platform);
        }

        const tempPath = path.join(this.binDir, archiveName);
        
        console.log(`Downloading from ${url}...`);
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream'
        });

        await pipeline(response.data, fs.createWriteStream(tempPath));
        console.log('Download complete. Extracting...');

        if (platform === 'win32') {
            const AdmZip = require('adm-zip');
            const zip = new AdmZip(tempPath);
            zip.extractAllTo(this.binDir, true);
            
            const entries = zip.getEntries();
            
            // Extract ffmpeg
            const ffmpegEntry = entries.find(e => e.entryName.match(/bin\/ffmpeg\.exe$/));
            if (ffmpegEntry) {
                const extractedPath = path.join(this.binDir, ffmpegEntry.entryName);
                const targetPath = path.join(this.binDir, 'ffmpeg.exe');
                fs.copyFileSync(extractedPath, targetPath);
            }
            
            // Extract ffprobe
            const ffprobeEntry = entries.find(e => e.entryName.match(/bin\/ffprobe\.exe$/));
            if (ffprobeEntry) {
                const extractedPath = path.join(this.binDir, ffprobeEntry.entryName);
                const targetPath = path.join(this.binDir, 'ffprobe.exe');
                fs.copyFileSync(extractedPath, targetPath);
            }

        } else {
            // Linux - use tar
            try {
                execSync(`tar -xf ${tempPath} -C ${this.binDir}`);
                const files = fs.readdirSync(this.binDir);
                const folder = files.find(f => f.startsWith('ffmpeg-') && fs.lstatSync(path.join(this.binDir, f)).isDirectory());
                if (folder) {
                    const binDir = path.join(this.binDir, folder);
                    // Copy ffmpeg
                    if (fs.existsSync(path.join(binDir, 'ffmpeg'))) {
                         fs.copyFileSync(path.join(binDir, 'ffmpeg'), path.join(this.binDir, 'ffmpeg'));
                         fs.chmodSync(path.join(this.binDir, 'ffmpeg'), 0o755);
                    }
                    // Copy ffprobe
                    if (fs.existsSync(path.join(binDir, 'ffprobe'))) {
                         fs.copyFileSync(path.join(binDir, 'ffprobe'), path.join(this.binDir, 'ffprobe'));
                         fs.chmodSync(path.join(this.binDir, 'ffprobe'), 0o755);
                    }
                }
            } catch(e) {
                console.error("Error extracting tar:", e);
                throw e;
            }
        }

        // Cleanup
        try { fs.unlinkSync(tempPath); } catch(e){}
        console.log('FFmpeg/FFprobe installed successfully.');
    }
    
    getPath() {
        return this.ffmpegPath;
    }
    
    getFfprobePath() {
        return this.ffprobePath;
    }
}

module.exports = new FFmpegManager();
