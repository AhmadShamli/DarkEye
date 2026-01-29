const onvif = require('node-onvif');

class OnvifManager {
    constructor() {
        this.devices = [];
    }

    async discover() {
        const os = require('os');
        const interfaces = Object.keys(os.networkInterfaces());
        console.log(`[ONVIF] Starting discovery on interfaces: ${interfaces.join(', ')}`);
        
        const attempts = 3;
        const allDevices = new Map(); // xaddr -> device

        for (let i = 0; i < attempts; i++) {
            console.log(`[ONVIF] Discovery attempt ${i+1}/${attempts}...`);
            try {
                const devices = await new Promise((resolve, reject) => {
                    onvif.startProbe().then(device_list => {
                        resolve(device_list);
                    }).catch(e => {
                        reject(e);
                    });
                });

                console.log(`[ONVIF] Attempt ${i+1} raw result count: ${devices.length}`);

                devices.forEach(d => {
                    const address = d.xaddr || (Array.isArray(d.xaddrs) ? d.xaddrs[0] : '');
                    if (address && !allDevices.has(address)) {
                        console.log(`[ONVIF] Found device: ${address}`);
                        allDevices.set(address, d);
                    }
                });
            } catch (e) {
                console.error(`[ONVIF] Attempt ${i+1} failed details:`, e);
            }
            // Small pause between attempts
            if (i < attempts - 1) await new Promise(r => setTimeout(r, 2000));
        }

        console.log(`[ONVIF] Found ${allDevices.size} unique devices after ${attempts} attempts.`);
        this.devices = Array.from(allDevices.values());

        // Process devices to get clean info
        const results = this.devices.map(device => {
            const address = device.xaddr || (Array.isArray(device.xaddrs) ? device.xaddrs[0] : '') || '';
            return {
                xaddr: address,
                name: device.name || device.hardware || 'Unknown Device',
                hardware: device.hardware,
                urn: device.urn,
            };
        });
        return results;
    }

    async getProfiles(address, username, password) {
        try {
            const device = new onvif.OnvifDevice({
                xaddr: address,
                user: username,
                pass: password
            });

            await device.init();
            
            // Extract profiles
            // node-onvif stores profiles in device.profiles which is an object where keys are tokens
            /*
             device.profiles = {
               'profile_1': {
                  name: 'main',
                  stream: {
                    udp: 'rtsp://...',
                    http: 'http://...',
                    rtsp: 'rtsp://...'
                  },
                  video: { ... }
               }
             }
            */
            
            const profiles = [];
            // Iterate over device.profiles to find tokens
            if (device.profiles) {
                for (const key in device.profiles) {
                    const p = device.profiles[key];
                    // 'key' is the Profile Token
                    try {
                        // Explicitly ask for RTSP URL for this profile token
                        // device.getUdpStreamUrl(protocol, profileToken)
                        let url = device.getUdpStreamUrl('RTSP', key);
                        
                        if (url) {
                            profiles.push({
                                name: p.name || key,
                                url: url,
                                details: p.video ? `${p.video.encoder} (${p.video.width}x${p.video.height})` : 'Audio/Unknown'
                            });
                        }
                    } catch(err) {
                        console.warn(`[ONVIF] Failed to get URL for profile ${key}:`, err.message);
                    }
                }
            }

            // Fallback if no profiles found
            if (profiles.length === 0) {
                 console.log('[ONVIF] No profiles found. Trying default...');
                 try {
                    const url = device.getUdpStreamUrl();
                    if (url) {
                        profiles.push({
                            name: 'Default Stream',
                            url: url,
                            details: 'Auto-detected'
                        });
                    }
                 } catch(e) {}
            }
            
            // Extract Capabilities
            const capabilities = [];
            if (device.services.ptz) capabilities.push('PTZ');
            if (device.services.imaging) capabilities.push('Imaging');
            if (device.services.events) capabilities.push('Events');
            
            // Audio Check (Check profiles for audio encoder/source config)
            let hasAudio = false;
            if (device.profiles) {
                // node-onvif profiles usually have 'audio' property if audio is supported/configured
                 for (const key in device.profiles) {
                    // Check complex structure or simple existence
                    if (device.profiles[key].audio) { hasAudio = true; break; }
                }
            }
            if (hasAudio) capabilities.push('Audio');

            return { profiles, capabilities };

        } catch (e) {
            console.error(`[ONVIF] Failed to get profiles for ${address}:`, e.message);
            throw e;
        }
    }

    async getStreamUrl(address, username, password) {
        // ... existing legacy method kept for compatibility if needed ...
        try {
            const device = new onvif.OnvifDevice({
                xaddr: address,
                user: username,
                pass: password
            });

            await device.init();
            return device.getUdpStreamUrl();
        } catch (e) {
             console.error(`[ONVIF] Failed to get stream for ${address}:`, e.message);
            throw e;
        }
    }

    /**
     * Move the PTZ camera continuously in a direction
     * @param {string} address - ONVIF service URL (xaddr)
     * @param {string} username - Camera username
     * @param {string} password - Camera password
     * @param {object} velocity - { x, y, z } values from -1 to 1
     */
    async move(address, username, password, velocity) {
        try {
            const device = new onvif.OnvifDevice({
                xaddr: address,
                user: username,
                pass: password
            });

            await device.init();

            // Check if PTZ service is available
            if (!device.services.ptz) {
                throw new Error('PTZ service not available on this device');
            }

            // Use node-onvif's ptzMove method for continuous movement
            // API requires: speed: { x, y, z } and timeout in seconds
            const params = {
                speed: {
                    x: velocity.x || 0,
                    y: velocity.y || 0,
                    z: velocity.z || 0
                },
                timeout: 5 // Timeout in seconds - movement duration
            };

            await device.ptzMove(params);
            console.log(`[ONVIF] PTZ move executed: pan=${velocity.x}, tilt=${velocity.y}, zoom=${velocity.z}`);
        } catch (e) {
            console.error(`[ONVIF] PTZ move failed for ${address}:`, e.message);
            throw e;
        }
    }

    /**
     * Stop PTZ camera movement
     * @param {string} address - ONVIF service URL (xaddr)
     * @param {string} username - Camera username
     * @param {string} password - Camera password
     */
    async stop(address, username, password) {
        try {
            const device = new onvif.OnvifDevice({
                xaddr: address,
                user: username,
                pass: password
            });

            await device.init();

            // Check if PTZ service is available
            if (!device.services.ptz) {
                throw new Error('PTZ service not available on this device');
            }

            // Use node-onvif's ptzStop method
            await device.ptzStop();
            console.log(`[ONVIF] PTZ stop executed`);
        } catch (e) {
            console.error(`[ONVIF] PTZ stop failed for ${address}:`, e.message);
            throw e;
        }
    }

    /**
     * Get audio backchannel (output) information for talk-to-camera feature
     * @param {string} address - ONVIF service URL (xaddr)
     * @param {string} username - Camera username
     * @param {string} password - Camera password
     * @returns {object} Audio backchannel info or null if not supported
     */
    async getAudioBackchannelInfo(address, username, password) {
        try {
            const device = new onvif.OnvifDevice({
                xaddr: address,
                user: username,
                pass: password
            });

            await device.init();

            // Check if any profile has audio output configuration
            let audioBackchannelSupported = false;
            let rtspUrl = null;
            
            // node-onvif stores profiles in profile_list after init
            for (const profile of device.profile_list || []) {
                // Check for audio encoder (indicates audio capability)
                if (profile.audio && profile.audio.encoder) {
                    audioBackchannelSupported = true;
                    // Get the RTSP URL for this profile
                    if (profile.stream && profile.stream.rtsp) {
                        rtspUrl = profile.stream.rtsp;
                    }
                    break;
                }
            }

            if (audioBackchannelSupported) {
                console.log(`[ONVIF] Audio backchannel supported at ${address}`);
                return {
                    supported: true,
                    rtspUrl: rtspUrl,
                    // Backchannel typically uses the same RTSP URL but with special negotiation
                    backchannelUrl: rtspUrl
                };
            } else {
                console.log(`[ONVIF] No audio backchannel support at ${address}`);
                return { supported: false };
            }
        } catch (e) {
            console.error(`[ONVIF] Failed to get audio info for ${address}:`, e.message);
            return { supported: false, error: e.message };
        }
    }
}

module.exports = new OnvifManager();
