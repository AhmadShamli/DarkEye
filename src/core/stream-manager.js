const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const ffmpegManager = require('./ffmpeg-manager');

class StreamManager {
    constructor() {
        this.streams = new Map(); // id -> { process, lastHeartbeat }
        this.recorders = new Set(); // ids handled by Recorder
        this.hlsDir = path.join(process.cwd(), 'public', 'hls');
        
        if (!fs.existsSync(this.hlsDir)) {
            fs.mkdirSync(this.hlsDir, { recursive: true });
        }

        // Start Monitor
        setInterval(() => this.cleanupIdleStreams(), 5000);
    }

    registerRecorder(id) {
        this.recorders.add(id);
        // If we had a stream running, kill it (Recorder takes over)
        this.stopStream(id);
    }

    unregisterRecorder(id) {
        this.recorders.delete(id);
    }

    heartbeat(id, url) {
        // If handled by recorder, we just update timestamp but don't start anything
        if (this.recorders.has(id)) return;

        const now = Date.now();
        if (this.streams.has(id)) {
            // Update timestamp
            const stream = this.streams.get(id);
            stream.lastHeartbeat = now;
        } else {
            // Start new stream
            this.startStream(id, url);
            // Mark heartbeat immediately after start
             if (this.streams.has(id)) {
                this.streams.get(id).lastHeartbeat = now;
             }
        }
    }

    cleanupIdleStreams() {
        const now = Date.now();
        const IDLE_TIMEOUT = 20000; // 20 seconds

        for (const [id, stream] of this.streams.entries()) {
            if (now - stream.lastHeartbeat > IDLE_TIMEOUT) {
                console.log(`[StreamManager] Stream ${id} idle for >20s. Stopping.`);
                this.stopStream(id);
            }
        }
    }

    startStream(id, url) {
        if (this.streams.has(id) || this.recorders.has(id)) return;

        console.log(`[StreamManager] Starting HLS for ${id}`);
        const outDir = path.join(this.hlsDir, id);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        // Clean old segments
        try {
            fs.readdirSync(outDir).forEach(f => fs.unlinkSync(path.join(outDir, f)));
        } catch(e) {}

        const cmd = ffmpeg(url)
            .inputOptions([
                '-rtsp_transport tcp',
                '-fflags nobuffer',
                '-flags low_delay'
            ])
            .outputOptions([
                '-c:v libx264', 
                '-preset ultrafast',
                '-tune zerolatency',
                '-pix_fmt yuv420p',
                '-g 60',
                '-sc_threshold 0',
                '-c:a aac',
                '-f hls',
                '-hls_time 2',
                '-hls_list_size 3',
                '-hls_flags delete_segments',
                '-start_number 0'
            ])
            .output(path.join(outDir, 'index.m3u8'))
            .on('start', () => console.log(`[StreamManager] HLS process started for ${id} writing to ${path.join(outDir, 'index.m3u8')}`));

        // Error handler needs to reference the mapped object carefully or we rely on stopStream
        cmd.on('error', (err) => {
             // Only log if it wasn't killed intentionally
             if (!err.message.includes('SIGKILL')) {
                 console.error(`[StreamManager] HLS Error for ${id}:`, err.message);
             }
             // We don't auto-restart here; heartbeat will restart it if needed
             // But we should clean up the map entry
             if (this.streams.has(id) && this.streams.get(id).process === cmd) {
                 this.streams.delete(id);
             }
        });

        if (ffmpegManager.getPath()) {
            cmd.setFfmpegPath(ffmpegManager.getPath());
        }

        cmd.run();
        
        // Store process and timestamp
        this.streams.set(id, {
            process: cmd,
            lastHeartbeat: Date.now()
        });
    }

    stopStream(id) {
        if (this.streams.has(id)) {
            console.log(`[StreamManager] Stopping HLS for ${id}`);
            const stream = this.streams.get(id);
            try {
                stream.process.kill();
            } catch(e) {}
            this.streams.delete(id);
            
             // Clean up files? fast cleanup
             // const outDir = path.join(this.hlsDir, id);
             // try { fs.rmSync(outDir, { recursive: true, force: true }); } catch(e) {}
             // Better to leave files slightly longer or clean on start
        }
    }
    
    stopAll() {
        for (const id of this.streams.keys()) {
            this.stopStream(id);
        }
    }
}

module.exports = new StreamManager();
