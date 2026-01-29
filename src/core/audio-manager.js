/**
 * Audio Manager - Handles audio streaming to cameras (talk-to-camera)
 * Uses FFmpeg to stream audio data to camera's RTSP backchannel
 */

const { spawn } = require('child_process');
const ffmpegManager = require('./ffmpeg-manager');

class AudioManager {
    constructor() {
        // Track active talk sessions by camera ID
        this.activeSessions = new Map();
    }

    /**
     * Start a talk session to a camera
     * @param {string} cameraId - Camera ID
     * @param {string} rtspUrl - RTSP URL with audio backchannel support
     * @param {string} username - Camera username
     * @param {string} password - Camera password
     * @returns {object} Session info
     */
    startTalk(cameraId, rtspUrl, username, password) {
        // Stop any existing session for this camera
        if (this.activeSessions.has(cameraId)) {
            this.stopTalk(cameraId);
        }

        const ffmpegPath = ffmpegManager.getPath() || 'ffmpeg';
        
        // Build authenticated RTSP URL
        let authRtspUrl = rtspUrl;
        if (username && password && rtspUrl.startsWith('rtsp://') && !rtspUrl.includes('@')) {
            const parts = rtspUrl.split('://');
            authRtspUrl = `${parts[0]}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${parts[1]}`;
        }

        // Create a named pipe or use stdin for audio input
        // FFmpeg command to stream audio to camera via RTSP
        // Note: This sets up the FFmpeg process to receive raw PCM audio on stdin
        // and stream it to the camera's RTSP backchannel
        const ffmpegArgs = [
            '-f', 's16le',           // Input format: signed 16-bit little-endian PCM
            '-ar', '8000',           // Sample rate: 8kHz (G.711 standard)
            '-ac', '1',              // Mono audio
            '-i', 'pipe:0',          // Read from stdin
            '-c:a', 'pcm_mulaw',     // Encode to G.711 μ-law (most compatible)
            '-ar', '8000',
            '-ac', '1',
            '-f', 'rtp',             // Output to RTP
            '-rtsp_transport', 'tcp',
            authRtspUrl
        ];

        console.log(`[AudioManager] Starting talk session for camera ${cameraId}`);
        
        const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        ffmpegProcess.stderr.on('data', (data) => {
            console.log(`[AudioManager FFmpeg] ${data.toString()}`);
        });

        ffmpegProcess.on('error', (err) => {
            console.error(`[AudioManager] FFmpeg error for ${cameraId}:`, err.message);
            this.activeSessions.delete(cameraId);
        });

        ffmpegProcess.on('close', (code) => {
            console.log(`[AudioManager] FFmpeg closed for ${cameraId} with code ${code}`);
            this.activeSessions.delete(cameraId);
        });

        this.activeSessions.set(cameraId, {
            process: ffmpegProcess,
            startTime: Date.now()
        });

        return { success: true, sessionId: cameraId };
    }

    /**
     * Send audio data to an active talk session
     * @param {string} cameraId - Camera ID
     * @param {Buffer} audioData - Raw PCM audio data (s16le, 8kHz, mono)
     */
    sendAudio(cameraId, audioData) {
        const session = this.activeSessions.get(cameraId);
        if (!session || !session.process || session.process.killed) {
            return false;
        }

        try {
            session.process.stdin.write(audioData);
            return true;
        } catch (e) {
            console.error(`[AudioManager] Failed to send audio to ${cameraId}:`, e.message);
            return false;
        }
    }

    /**
     * Stop a talk session
     * @param {string} cameraId - Camera ID
     */
    stopTalk(cameraId) {
        const session = this.activeSessions.get(cameraId);
        if (session && session.process) {
            console.log(`[AudioManager] Stopping talk session for ${cameraId}`);
            try {
                session.process.stdin.end();
                session.process.kill('SIGTERM');
            } catch (e) {
                // Process may already be dead
            }
            this.activeSessions.delete(cameraId);
        }
        return { success: true };
    }

    /**
     * Check if a talk session is active
     * @param {string} cameraId - Camera ID
     */
    isActive(cameraId) {
        const session = this.activeSessions.get(cameraId);
        return session && session.process && !session.process.killed;
    }

    /**
     * Stop all active sessions
     */
    stopAll() {
        for (const [cameraId] of this.activeSessions) {
            this.stopTalk(cameraId);
        }
    }
}

module.exports = new AudioManager();
