const onvif = require('node-onvif');

class OnvifManager {
    constructor() {
        this.devices = [];
    }

    async discover() {
        console.log('[ONVIF] Starting discovery...');
        const attempts = 3;
        const allDevices = new Map(); // xaddr -> device

        for (let i = 0; i < attempts; i++) {
            console.log(`[ONVIF] Discovery attempt ${i+1}/${attempts}...`);
            try {
                const devices = await onvif.startProbe();
                devices.forEach(d => {
                    const address = d.xaddr || (Array.isArray(d.xaddrs) ? d.xaddrs[0] : '');
                    if (address && !allDevices.has(address)) {
                        allDevices.set(address, d);
                    }
                });
            } catch (e) {
                console.warn(`[ONVIF] Attempt ${i+1} failed:`, e.message);
            }
            // Small pause between attempts
            if (i < attempts - 1) await new Promise(r => setTimeout(r, 1000));
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
            
            return profiles;

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
}

module.exports = new OnvifManager();
