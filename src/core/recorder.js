const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const ffmpegManager = require('./ffmpeg-manager');
const db = require('../db'); // Require DB

class Recorder {
    constructor(cameraConfig) {
        this.config = cameraConfig;
        this.command = null;
        this.timelapseCommand = null;
        this.isRecording = false;
        this.restartTimer = null;
    }

    start() {
        this.shouldRecord = true;
        this.startRecord();
    }

    async startRecord() {
        if (!this.shouldRecord) return;
        
        if (!ffmpegManager.getPath()) {
            await ffmpegManager.init();
        }
        ffmpeg.setFfmpegPath(ffmpegManager.getPath());

        const { id, segment_duration, timelapse_enabled, record_mode } = this.config;
        const inputUrl = `rtsp://127.0.0.1:8554/live/${id}`;
        
        let basePath = path.join(process.cwd(), 'recordings');
        try {
             if (fs.existsSync('darkeye.db')) {
                 const settings = db.prepare("SELECT value FROM settings WHERE key = 'storage_path'").get();
                 if (settings) basePath = settings.value;
             }
        } catch(e) {}
        
        const recordingPath = path.join(basePath, id);
        if (!fs.existsSync(recordingPath)) fs.mkdirSync(recordingPath, { recursive: true });

        console.log(`[Recorder ${id}] Connecting to ${inputUrl}...`);

        // --- Main Recording ---
        if (record_mode !== 'none') {
            const outputArgs = [
                '-f segment',
                `-segment_time ${segment_duration ? segment_duration * 60 : 900}`, 
                '-strftime 1',
                '-reset_timestamps 1'
            ];

            if (record_mode === 'encode') {
                console.log(`[Recorder ${id}] Mode: Encode (H.264/AAC)`);
                outputArgs.unshift(
                    '-c:v libx264', 
                    '-preset superfast', 
                    '-crf 23',
                    '-c:a aac', 
                    '-b:a 128k'
                );
            } else {
                console.log(`[Recorder ${id}] Mode: Raw (Stream Copy)`);
                outputArgs.unshift('-c copy');
            }

            this.command = ffmpeg(inputUrl)
                .inputOptions([
                    '-rtsp_transport tcp',
                    '-fflags nobuffer',
                    '-allowed_media_types video+audio'
                ])
                .outputOptions(outputArgs);

            const outputFile = path.join(recordingPath, '%Y-%m-%d_%H-%M-%S.mkv');

            this.command.output(outputFile)
                .on('start', (cmd) => {
                    console.log(`[Recorder ${id}] Started: ${cmd}`);
                })
                .on('error', (err) => {
                    console.error(`[Recorder ${id}] Error:`, err.message);
                    this.scheduleRestart();
                })
                .on('end', () => {
                    console.log(`[Recorder ${id}] Stream ended.`);
                    this.scheduleRestart();
                });
            
            this.command.run();
        } else {
            console.log(`[Recorder ${id}] Main recording disabled (Mode: None). Monitoring only.`);
            // If main recording is off, we still want to "stay alive" for timelapse logic? 
            // Actually scheduleRestart is tied to this.command. 
            // If main recorder is off, we only rely on timelapse command or nothing?
            // If EVERYTHING is off, then what's the point? 
            // Ah, maybe user just wants monitoring (Live View). 
            // In that case, CameraManager started MediaMTX, so Live View works.
            // Recorder class is only needed if we are recording SOMETHING (Main or Timelapse).
            
            // If only timelapse is on, we don't need main retry logic? 
            // We should treat timelapse command as the "health check" if main is off.
        }

        // --- Timelapse (Secondary Process) ---
        if (timelapse_enabled) {
            this.startTimelapse(inputUrl, recordingPath);
        }
    }

    startTimelapse(inputUrl, basePath) {
        const timelapseDir = path.join(basePath, 'timelapse');
        if (!fs.existsSync(timelapseDir)) fs.mkdirSync(timelapseDir, { recursive: true });

        const interval = this.config.timelapse_interval || 5;
        const duration = (this.config.timelapse_duration || 60) * 60; // Minutes to Seconds
        
        // Calculate GOP (Group of Pictures) to ensure we have a keyframe at the split point
        // If we don't set this, default is 250 frames. At 0.2fps (1/5), that's 20 minutes!
        // So we force a keyframe at least once per segment duration.
        const fps = 1 / interval;
        const framesPerSegment = Math.floor(duration * fps);
        const gop = Math.max(1, framesPerSegment);

        console.log(`[Recorder ${this.config.id}] Starting Timelapse (1 frame/${interval}s, Split: ${duration}s, GOP: ${gop})...`);

        this.timelapseCommand = ffmpeg(inputUrl)
             .inputOptions([
                '-rtsp_transport tcp',
                '-fflags nobuffer',
                '-allowed_media_types video'
             ])
             .outputOptions([
                 `-vf fps=1/${interval}`, 
                 '-c:v libx264',     
                 '-preset ultrafast', 
                 '-crf 28',
                 `-g ${gop}`,          // Critical: Force keyframe to allow segmentation
                 '-sc_threshold 0',   // Prevent scene cut detection from messing up GOP
                 '-an',               
                 '-f segment',
                 `-segment_time ${duration}`,
                 '-strftime 1',
                 '-reset_timestamps 1'
             ]);

        const outputFile = path.join(timelapseDir, '%Y-%m-%d_%H-%M-%S.mkv');

        this.timelapseCommand.output(outputFile)
            .on('start', (cmd) => console.log(`[Timelapse ${this.config.id}] Started`))
            .on('error', (err) => {
                console.error(`[Timelapse ${this.config.id}] Error: ${err.message}`);
                 // If main recording is off, maybe we should retry timelapse?
                 // For now, simple implementation.
            })
            .on('end', () => console.log(`[Timelapse ${this.config.id}] Ended`));
            
        this.timelapseCommand.run();
    }

    stop() {
        this.shouldRecord = false;
        
        if (this.command) {
            this.command.kill();
            this.command = null;
        }
        
        if (this.timelapseCommand) {
            this.timelapseCommand.kill();
            this.timelapseCommand = null;
        }
        
        clearTimeout(this.restartTimer);
    }

    scheduleRestart() {
        if (!this.shouldRecord) return;
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
            console.log(`[Recorder ${this.config.id}] Restarting recording...`);
            this.startRecord();
        }, 5000); // Retry in 5s
    }
}

module.exports = Recorder;
