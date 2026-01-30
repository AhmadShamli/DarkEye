const API_URL = '/api';

// --- State ---
let cameras = [];

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
    if (await checkAuth()) {
        fetchCameras();
        fetchSystemStats();
        // Refresh system stats every 5 seconds
        setInterval(fetchSystemStats, 5000);
    }
});

// --- Auth ---
async function checkAuth() {
    try {
        const res = await fetch(`${API_URL}/auth/status`);
        const status = await res.json();
        
        if (!status.authenticated) {
            window.location.href = '/login.html';
            return false;
        }
        return true;
    } catch (e) {
        console.error("Auth check failed", e);
        return false;
    }
}

async function logout() {
    await fetch(`${API_URL}/auth/logout`, { method: 'POST' });
    window.location.href = '/login.html';
}

// --- API Calls ---
async function fetchCameras() {
    try {
        const res = await fetch(`${API_URL}/cameras`);
        cameras = await res.json();
        renderCameras();
    } catch (e) {
        console.error("Failed to fetch cameras");
    }
}

// Helper to format bytes
function formatBytes(kb) {
    if (kb >= 1024) {
        return (kb / 1024).toFixed(1) + ' MB/s';
    }
    return kb.toFixed(0) + ' KB/s';
}

async function fetchSystemStats() {
    try {
        const res = await fetch(`${API_URL}/system/stats`);
        const data = await res.json();
        
        // Storage
        const storageEl = document.getElementById('statStorage');
        const storageBar = document.getElementById('statStorageBar');
        const storageCard = storageEl.closest('.glass-card');
        
        if (data.storage.warning) {
            storageEl.innerHTML = `${data.storage.used} / ${data.storage.limit} GB <i class="fa-solid fa-triangle-exclamation text-yellow-400 ml-1" title="Limit exceeds available disk space (${data.storage.available} GB free)"></i>`;
            storageBar.classList.remove('bg-purple-500');
            storageBar.classList.add('bg-yellow-500');
        } else {
            storageEl.textContent = `${data.storage.used} / ${data.storage.limit} GB`;
            storageBar.classList.remove('bg-yellow-500');
            storageBar.classList.add('bg-purple-500');
        }
        storageBar.style.width = `${data.storage.percent}%`;
        
        // CPU
        document.getElementById('statCpu').textContent = `${data.cpu.percent}%`;
        document.getElementById('statCpuBar').style.width = `${data.cpu.percent}%`;
        
        // Memory
        document.getElementById('statMemory').textContent = `${data.memory.used} / ${data.memory.total} GB`;
        document.getElementById('statMemoryBar').style.width = `${data.memory.percent}%`;
        
        // Network
        document.getElementById('statNetwork').innerHTML = `
            <span class="text-green-400"><i class="fa-solid fa-arrow-down text-[10px]"></i> ${formatBytes(data.network.rxRate)}</span>
            <span class="text-red-400"><i class="fa-solid fa-arrow-up text-[10px]"></i> ${formatBytes(data.network.txRate)}</span>
        `;
    } catch (e) {
        console.error("Failed to fetch system stats", e);
    }
}

async function fetchSettings() {
    const res = await fetch(`${API_URL}/settings`);
    const data = await res.json();
    document.getElementById('set_storage_path').value = data.storage_path || '';
    document.getElementById('set_max_storage').value = data.max_storage_gb;
    document.getElementById('set_retention').value = data.retention_hours;
    document.getElementById('set_cleanup').value = data.cleanup_interval_min;
}

async function deleteCamera(id) {
    if (!confirm("Are you sure?")) return;
    await fetch(`${API_URL}/cameras/${id}`, { method: 'DELETE' });
    fetchCameras();
}

// --- UI Logic ---
function renderCameras() {
    const grid = document.getElementById('cameraGrid');
    
    if (cameras.length === 0) {
        grid.innerHTML = `
            <div class="col-span-full h-64 flex flex-col items-center justify-center text-gray-500 border-2 border-dashed border-gray-700/50 rounded-2xl bg-gray-800/10 backdrop-blur-sm">
                <i class="fa-solid fa-video-slash text-4xl mb-4 opacity-50"></i>
                <p>No cameras configured. Click "Add Camera" to start.</p>
            </div>`;
        return;
    }

    grid.innerHTML = cameras.map(cam => `
        <div class="glass-card rounded-2xl p-4 transition-all duration-300 hover:shadow-purple-900/20 hover:shadow-2xl group relative overflow-hidden">
             <!-- Status Badge -->
            <div class="absolute top-4 right-4 z-10 flex gap-2">
                <!-- Main Record Badge -->
                ${cam.record_mode !== 'none' ? `
                    <span class="px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider backdrop-blur-md border border-white/10 bg-red-500/20 text-red-500 animate-pulse">
                        REC
                    </span>
                ` : `
                    <span class="px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider backdrop-blur-md border border-white/10 bg-blue-500/20 text-blue-400">
                        LIVE
                    </span>
                `}
                
                <!-- Timelapse Badge -->
                ${cam.timelapse_enabled ? `
                    <span class="px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider backdrop-blur-md border border-white/10 bg-purple-500/20 text-purple-400">
                        TL
                    </span>
                ` : ''}

                
                <!-- PTZ Control Button (Overlay) -->
                ${cam.ptz_enabled ? `
                    <button onclick="openPtzModal('${cam.id}')" class="px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider backdrop-blur-md border border-white/10 bg-purple-600 hover:bg-purple-500 text-white shadow-lg transition-colors flex items-center gap-1 z-20">
                        <i class="fa-solid fa-up-down-left-right"></i> PTZ
                    </button>
                ` : ''}
            </div>

            <!-- Thumbnail / Preview -->
            <div class="aspect-video bg-gray-900/50 rounded-xl mb-4 flex items-center justify-center relative overflow-hidden group-hover:scale-[1.02] transition-transform duration-500">
                <img src="${API_URL}/cameras/${cam.id}/thumbnail?t=${Date.now()}" 
                     class="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity"
                     onerror="this.onerror=null; this.src='https://placehold.co/600x400/1f2937/4b5563?text=No+Signal';">
                
                <!-- Center Action -->
                <button onclick="openLiveView('${cam.id}')" class="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-black/40 backdrop-blur-[2px]">
                    <div class="bg-purple-600 text-white w-12 h-12 rounded-full flex items-center justify-center shadow-lg hover:scale-110 transition-transform">
                        <i class="fa-solid fa-play ml-1"></i>
                    </div>
                </button>
            </div>

            <!-- Content -->
            <div class="flex justify-between items-end relative z-10">
                <div>
                     <h3 class="font-bold text-lg text-white mb-0.5">${cam.name}</h3>
                     <p class="text-xs text-gray-500 font-mono truncate max-w-[150px]">${cam.url}</p>
                </div>
                
                <div class="flex gap-2">
                    <!-- Live Button (Quick Action) -->
                     <button onclick="openLiveView('${cam.id}')" class="p-2 rounded-lg bg-red-900/20 text-red-400 hover:bg-red-600 hover:text-white transition-colors border border-red-900/30" title="Live View">
                        <i class="fa-solid fa-tower-broadcast"></i>
                    </button>

                     <button onclick="openRecordings('${cam.id}', '${cam.name}')" class="p-2 rounded-lg hover:bg-blue-600/20 hover:text-blue-400 transition-colors" title="View Recordings">
                        <i class="fa-solid fa-folder-open"></i>
                    </button>
                    <button onclick="openEditCamera('${cam.id}')" class="p-2 rounded-lg hover:bg-yellow-600/20 hover:text-yellow-400 transition-colors" title="Edit Camera">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button onclick="deleteCamera('${cam.id}')" class="p-2 rounded-lg hover:bg-red-600/20 hover:text-red-400 transition-colors" title="Delete">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
        </div>
    `).join('');
}

// --- Modals ---
function openModal(id) {
    document.getElementById(id).classList.add('modal-open');
}
function closeModal(id) {
    document.getElementById(id).classList.remove('modal-open');
     // Stop video if closing file modal
    if(id === 'filesModal') {
        document.getElementById('videoPlayer').pause();
    }
    if (id === 'liveModal') {
        const video = document.getElementById('livePlayer');
        if (video) {
            video.pause();
            video.src = "";
            video.style.display = 'block'; // Reset for next time if we revert?
        }
        
        // Remove WebRTC Frame
        const container = document.querySelector('#liveModal .modal-content');
        const iframe = container ? container.querySelector('#webrtcFrame') : null;
        if (iframe) iframe.remove();
    }
}

function openLiveView(id) {
    const cam = cameras.find(c => c.id === id);
    if (!cam) return;
    
    openModal('liveModal');
    const container = document.querySelector('#liveModal .modal-content');
    
    // Cleanup existing iframes if any (except the close button and badge)
    const existingFrame = container.querySelector('iframe');
    if (existingFrame) existingFrame.remove();

    // Hide the video tag (we swapped to iframe)
    const video = document.getElementById('livePlayer');
    if (video) video.style.display = 'none';

    // Stream path is 'live/<id>'
    const hostname = window.location.hostname;
    const port = window.location.port;
    
    // Heuristic: If we are on port 3000 (Dev), expect MediaMTX on 8889 (Direct).
    // If we are on 80/443 (Prod/Nginx), expect Nginx to proxy /live/ to MediaMTX.
    const isDev = port === '3000' || port === '3001'; 
    const streamBase = isDev ? `http://${hostname}:8889/live` : `${window.location.protocol}//${hostname}${port ? ':'+port : ''}/live`;
    
    const streamUrl = `${streamBase}/${id}/`;
    
    const iframe = document.createElement('iframe');
    iframe.src = streamUrl;
    iframe.className = "w-full h-full rounded-2xl";
    iframe.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture";
    iframe.style.border = "none";
    iframe.id = "webrtcFrame";
    
    // Append to container, but keep it behind the close button/badge (z-index handle that)
    // Actually, simply appending it is fine as absolute elements are z-indexed higher.
    container.appendChild(iframe);
}

function openAddCamera() {
    document.getElementById('cameraForm').reset();
    document.getElementById('editCameraId').value = ''; // Clear ID
    document.getElementById('modalTitle').innerText = 'Add Camera';
    openModal('addCameraModal');
}

function openEditCamera(id) {
    const cam = cameras.find(c => c.id === id);
    if (!cam) return;

    const form = document.getElementById('cameraForm');
    form.reset();
    document.getElementById('editCameraId').value = cam.id;
    document.getElementById('modalTitle').innerText = 'Edit Camera';

    form.querySelector('[name="name"]').value = cam.name;
    form.querySelector('[name="type"]').value = cam.type;
    form.querySelector('[name="url"]').value = cam.url;
    form.querySelector('[name="username"]').value = cam.username || '';
    form.querySelector('[name="password"]').value = cam.password || '';
    form.querySelector('[name="record_mode"]').value = cam.record_mode;
    form.querySelector('[name="segment_duration"]').value = cam.segment_duration || 15;
    form.querySelector('[name="timelapse_enabled"]').checked = !!cam.timelapse_enabled;

    switchTab('manual');
    openModal('addCameraModal');
}

// --- Forms ---
async function handleSaveCamera(e) {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());
    const id = document.getElementById('editCameraId').value;
    
    // Checkboxes
    data.timelapse_enabled = formData.get('timelapse_enabled') === 'on';
    data.ptz_enabled = formData.get('ptz_enabled') === 'on';

    try {
        const method = id ? 'PUT' : 'POST';
        const url = id ? `${API_URL}/cameras/${id}` : `${API_URL}/cameras`;

        await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        closeModal('addCameraModal');
        fetchCameras();
    } catch(err) {
        alert('Error saving camera');
    }
}

// --- Settings & Users ---
function openSettings() {
    fetchSettings();
    switchSettingsTab('general');
    openModal('settingsModal');
}

function switchSettingsTab(tab) {
    document.querySelectorAll('.tab-settings').forEach(el => el.classList.add('hidden'));
    
    document.getElementById(tab === 'general' ? 'settingsGeneral' : 'settingsUsers').classList.remove('hidden');
    
    const tabGen = document.getElementById('tabGeneral');
    const tabUsers = document.getElementById('tabUsers');
    
    if (tab === 'general') {
        tabGen.classList.add('border-purple-500', 'text-purple-400');
        tabGen.classList.remove('border-transparent');
        tabUsers.classList.remove('border-purple-500', 'text-purple-400');
        tabUsers.classList.add('border-transparent');
    } else {
        tabUsers.classList.add('border-purple-500', 'text-purple-400');
        tabUsers.classList.remove('border-transparent');
        tabGen.classList.remove('border-purple-500', 'text-purple-400');
        tabGen.classList.add('border-transparent');
        fetchUsers();
    }
}

async function fetchUsers() {
    const list = document.getElementById('userList');
    list.innerHTML = '<div class="text-center text-gray-500">Loading...</div>';
    
    try {
        const res = await fetch(`${API_URL}/auth/users`);
        if (!res.ok) {
            if (res.status === 403) {
                 list.innerHTML = '<div class="text-center text-red-400">Admin access only.</div>';
                 return;
            }
            throw new Error('Failed');
        }
        const users = await res.json();
        
        list.innerHTML = users.map(u => `
            <div class="flex justify-between items-center p-2 bg-gray-800 rounded border border-gray-700">
                <div class="flex items-center gap-2">
                    <div class="w-8 h-8 rounded-full bg-gradient-to-tr from-gray-700 to-gray-600 flex items-center justify-center font-bold text-xs">
                        ${u.username[0].toUpperCase()}
                    </div>
                    <div>
                        <div class="text-sm font-bold text-gray-200">${u.username}</div>
                        <div class="text-[10px] text-gray-500 uppercase">${u.role}</div>
                    </div>
                </div>
                ${u.role !== 'admin' || (users.filter(x => x.role === 'admin').length > 1) ? `
                    <button onclick="deleteUser('${u.id}')" class="text-gray-500 hover:text-red-400 transition-colors p-1" title="Delete">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                ` : ''}
            </div>
        `).join('');
    } catch(e) {
        list.innerHTML = '<div class="text-center text-red-400">Error loading users.</div>';
    }
}

async function handleAddUser(e) {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());
    
    try {
        const res = await fetch(`${API_URL}/auth/users`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(data)
        });
        
        if (res.ok) {
            e.target.reset();
            fetchUsers();
        } else {
            const err = await res.json();
            alert(err.error);
        }
    } catch(e) {
        alert('Failed to add user');
    }
}

async function deleteUser(id) {
    if (!confirm('Delete this user?')) return;
    try {
        await fetch(`${API_URL}/auth/users/${id}`, { method: 'DELETE' });
        fetchUsers();
    } catch(e) {
        alert('Failed to delete user');
    }
}

async function handleSaveSettings(e) {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());
    
    try {
        await fetch(`${API_URL}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        closeModal('settingsModal');
        alert('Settings saved!');
    } catch(err) {
        alert('Error saving settings');
    }
}

async function checkStoragePath() {
    const path = document.getElementById('set_storage_path').value;
    if (!path) return alert('Enter a path first');
    
    try {
        const res = await fetch(`${API_URL}/settings/check-path`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ path })
        });
        const data = await res.json();
        if (data.success) {
            alert('✅ ' + data.message);
        } else {
            alert('❌ ' + data.error);
        }
    } catch (e) {
        alert('Error checking path');
    }
}

// --- Tabs ---
function switchTab(tab) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.getElementById(tab === 'manual' ? 'cameraForm' : 'discoveryView').classList.remove('hidden');
    
    document.getElementById('tabManual').classList.toggle('border-purple-500', tab === 'manual');
    document.getElementById('tabManual').classList.toggle('text-purple-400', tab === 'manual');
    document.getElementById('tabManual').classList.toggle('border-transparent', tab !== 'manual');
    
    document.getElementById('tabDiscovery').classList.toggle('border-purple-500', tab === 'discovery');
    document.getElementById('tabDiscovery').classList.toggle('text-purple-400', tab === 'discovery');
    document.getElementById('tabDiscovery').classList.toggle('border-transparent', tab !== 'discovery');
}

// --- Discovery ---
async function runDiscovery() {
    const resultsDiv = document.getElementById('discoveryResults');
    resultsDiv.innerHTML = '<div class="text-center py-4 text-purple-400"><i class="fa-solid fa-circle-notch fa-spin text-2xl"></i><br>Scanning...</div>';
    
    try {
        const res = await fetch(`${API_URL}/cameras/discover`, { method: 'POST' });
        const devices = await res.json();
        
        if (devices.length === 0) {
            resultsDiv.innerHTML = '<div class="text-center py-4 text-gray-500">No devices found.</div>';
            return;
        }

        resultsDiv.innerHTML = devices.map(dev => `
            <div class="p-3 bg-gray-700/50 rounded-lg flex justify-between items-center border border-gray-600 hover:border-purple-500 cursor-pointer transition-colors" onclick="fillFormFromDiscovery('${dev.xaddr}', '${dev.name}')">
                <div>
                    <div class="font-bold text-white text-sm">${dev.name || 'Unknown Device'}</div>
                    <div class="text-xs text-gray-400 font-mono">${dev.xaddr}</div>
                </div>
                <i class="fa-solid fa-plus text-purple-400"></i>
            </div>
        `).join('');

    } catch (e) {
        resultsDiv.innerHTML = '<div class="text-center py-4 text-red-400">Scan failed.</div>';
    }
}

function fillFormFromDiscovery(url, name) {
    const form = document.getElementById('cameraForm');
    form.querySelector('[name="name"]').value = name || 'New Camera';
    form.querySelector('[name="onvif_service_url"]').value = url; 
    form.querySelector('[name="type"]').value = 'onvif';
    toggleFields(); 
    switchTab('manual');
}

function toggleFields() {
    const type = document.querySelector('[name="type"]').value;
    const onvifField = document.getElementById('fieldOnvifUrl');
    const lblUrl = document.getElementById('lblUrl');
    const helpUrl = document.getElementById('helpUrl');
    const usbHelp = document.getElementById('usbHelp');
    const fieldSubstream = document.getElementById('fieldSubstream');
    
    if (type === 'onvif') {
        onvifField.classList.remove('hidden');
        lblUrl.innerText = 'Record Stream URL (Main)';
        usbHelp.classList.add('hidden');
        fieldSubstream.classList.remove('hidden');
    } else if (type === 'usb') {
        onvifField.classList.add('hidden');
        lblUrl.innerText = 'Device Name / Path';
        helpUrl.innerText = 'Enter exact device name (Windows) or path (Linux).';
        document.getElementById('recordUrl').placeholder = 'e.g. Integrated Camera or /dev/video0';
        usbHelp.classList.remove('hidden');
        fieldSubstream.classList.add('hidden'); // USB usually has one stream
    } else {
        onvifField.classList.add('hidden');
        lblUrl.innerText = 'Record Stream URL (Main)';
        helpUrl.innerText = 'This stream will be recorded.';
        document.getElementById('recordUrl').placeholder = 'rtsp://...';
        usbHelp.classList.add('hidden');
        fieldSubstream.classList.remove('hidden');
    }

    // Timelapse Logic
    const timelapseEnabled = document.querySelector('[name="timelapse_enabled"]').checked;
    const tlSettings = document.getElementById('timelapseSettings');
    if (timelapseEnabled) {
        tlSettings.classList.remove('hidden');
    } else {
        tlSettings.classList.add('hidden');
    }

    // Record Mode Logic
    const mode = document.querySelector('[name="record_mode"]').value;
    const segField = document.getElementById('fieldSegment');
    if (mode === 'none') {
        segField.classList.add('opacity-50', 'pointer-events-none');
    } else {
        segField.classList.remove('opacity-50', 'pointer-events-none');
    }
}

async function fetchOnvifStreams() {
    const form = document.getElementById('cameraForm');
    const url = form.querySelector('[name="onvif_service_url"]').value;
    const username = form.querySelector('[name="username"]').value;
    const password = form.querySelector('[name="password"]').value;
    const list = document.getElementById('streamList');

    if (!url) {
        alert('Please enter the ONVIF URL (XAddr) first.');
        return;
    }

    list.classList.remove('hidden');
    list.innerHTML = '<div class="text-xs text-center text-purple-400"><i class="fa-solid fa-circle-notch fa-spin"></i> Connecting to Camera...</div>';

    try {
        const res = await fetch(`${API_URL}/onvif/profiles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, username, password })
        });
        const data = await res.json();
        
        // Handle both legacy (array) and new (object) formats for robustness
        const profiles = Array.isArray(data) ? data : data.profiles;
        const capabilities = Array.isArray(data) ? [] : (data.capabilities || []);

        
        if (data.error) throw new Error(data.error);
        if (!profiles || profiles.length === 0) throw new Error('No profiles found');

        const badgeColors = {
            'PTZ': 'bg-blue-900/50 text-blue-200 border-blue-700',
            'Audio': 'bg-pink-900/50 text-pink-200 border-pink-700',
            'Imaging': 'bg-indigo-900/50 text-indigo-200 border-indigo-700',
            'Events': 'bg-yellow-900/50 text-yellow-200 border-yellow-700',
            'IO': 'bg-gray-700 text-gray-300 border-gray-600'
        };

        let html = profiles.map(p => `
            <div class="p-2 border-b border-gray-700 hover:bg-gray-800 flex justify-between items-center group">
                <div class="overflow-hidden">
                    <div class="text-xs font-bold text-gray-300 group-hover:text-purple-400">${p.name}</div>
                    <div class="text-[10px] text-gray-500">${p.details}</div>
                    <div class="text-[10px] text-gray-600 truncate w-full pr-4" title="${p.url}">${p.url}</div>
                </div>
                <div class="flex gap-2">
                    <button type="button" onclick="assignStream('${p.url}', 'record')" class="text-[10px] bg-red-900/50 text-red-200 px-2 py-1 rounded hover:bg-red-700 transition-colors">Record</button>
                    <button type="button" onclick="assignStream('${p.url}', 'live')" class="text-[10px] bg-green-900/50 text-green-200 px-2 py-1 rounded hover:bg-green-700 transition-colors">Live</button>
                </div>
            </div>
        `).join('');

        // Append Capabilities
        if (capabilities.length > 0) {
            html += `
                <div class="p-2 mt-2 border-t border-gray-700 bg-gray-800/30">
                    <div class="text-[10px] text-gray-500 uppercase tracking-wider font-bold mb-1">Detected Capabilities</div>
                    <div class="flex flex-wrap gap-2">
                        ${capabilities.map(cap => `
                            <span class="px-2 py-0.5 rounded text-[10px] border ${badgeColors[cap] || 'bg-gray-700'}">${cap}</span>
                        `).join('')}
                    </div>
                </div>
            `;

            // Auto-enable/show PTZ option if detected
            if (capabilities.includes('PTZ')) {
                document.getElementById('fieldPtz').classList.remove('hidden');
                document.querySelector('[name="ptz_enabled"]').checked = true;
            }
        }

        list.innerHTML = html;

    } catch (e) {
        list.innerHTML = `<div class="text-xs text-center text-red-400">Error: ${e.message}</div>`;
    }
}

function assignStream(url, type) {
    if (type === 'record') {
        document.getElementById('recordUrl').value = url;
    } else {
        document.getElementById('liveUrl').value = url;
    }
}

function openEditCamera(id) {
    const cam = cameras.find(c => c.id === id);
    if (!cam) return;

    const form = document.getElementById('cameraForm');
    form.reset();
    document.getElementById('editCameraId').value = cam.id;
    document.getElementById('modalTitle').innerText = 'Edit Camera';

    form.querySelector('[name="name"]').value = cam.name;
    form.querySelector('[name="type"]').value = cam.type;
    
    // Populate new fields
    form.querySelector('[name="onvif_service_url"]').value = cam.onvif_service_url || '';
    form.querySelector('[name="url"]').value = cam.url || '';
    form.querySelector('[name="substream_url"]').value = cam.substream_url || '';
    
    form.querySelector('[name="username"]').value = cam.username || '';
    form.querySelector('[name="password"]').value = cam.password || '';
    form.querySelector('[name="record_mode"]').value = cam.record_mode;
    form.querySelector('[name="segment_duration"]').value = cam.segment_duration || 15;
    form.querySelector('[name="timelapse_enabled"]').checked = !!cam.timelapse_enabled;
    form.querySelector('[name="timelapse_interval"]').value = cam.timelapse_interval || 5;
    form.querySelector('[name="timelapse_interval"]').value = cam.timelapse_interval || 5;
    form.querySelector('[name="timelapse_duration"]').value = cam.timelapse_duration || 60;
    
    // PTZ Logic
    const ptzEnabled = !!cam.ptz_enabled;
    form.querySelector('[name="ptz_enabled"]').checked = ptzEnabled;
    if (ptzEnabled || cam.type === 'onvif') {
         // If it's ONVIF, we probably want to show the option anyway so user can toggle it manually if discovery didn't happen right now,
         // OR we strictly follow "if capability found".
         // User asked: "add option to enable PTZ when PTZ capabilities were found, otherwise keep it hidden/disabled"
         // But when EDITING, we might want to see what we saved.
         if (ptzEnabled) {
             document.getElementById('fieldPtz').classList.remove('hidden');
         } else {
             // Keep hidden unless we run discovery again? 
             // Or maybe just show it if it's ONVIF type? 
             // Let's reset to hidden default, and only show if ptzEnabled is true.
             document.getElementById('fieldPtz').classList.add('hidden');
             if (ptzEnabled) document.getElementById('fieldPtz').classList.remove('hidden');
         }
    }

    toggleFields();
    switchTab('manual');
    openModal('addCameraModal');
}

function togglePasswordVisibility() {
    const input = document.getElementById('camPassword');
    const icon = document.getElementById('btnShowPass');
    if (input.type === 'password') {
        input.type = 'text';
        icon.classList.replace('fa-eye', 'fa-eye-slash');
    } else {
        input.type = 'password';
        icon.classList.replace('fa-eye-slash', 'fa-eye');
    }
}

// --- Recordings ---
async function openRecordings(camId, camName) {
    document.getElementById('filesModalTitle').innerText = `Recordings: ${camName}`;
    const list = document.getElementById('fileList');
    list.innerHTML = '<div class="p-4 text-center text-gray-500">Loading...</div>';
    openModal('filesModal');
    
    try {
        const res = await fetch(`${API_URL}/recordings/${camId}`);
        const files = await res.json();
        
        if (files.length === 0) {
            list.innerHTML = '<div class="p-4 text-center text-gray-500">No recordings found.</div>';
            return;
        }
        
        // Sort by date desc
        files.sort((a,b) => new Date(b.mtime) - new Date(a.mtime));

        list.innerHTML = files.map(f => `
            <div class="p-3 border-b border-gray-700 hover:bg-gray-800/80 cursor-pointer transition-colors group" onclick="playVideo('${camId}', '${f.name}')">
                <div class="text-sm font-semibold text-gray-200 group-hover:text-purple-400 transition-colors">${f.name}</div>
                <div class="text-xs text-gray-500 flex justify-between mt-1">
                    <span>${(f.size / 1024 / 1024).toFixed(1)} MB</span>
                    <span>${new Date(f.mtime).toLocaleString()}</span>
                </div>
            </div>
        `).join('');
        
    } catch (e) {
        list.innerHTML = '<div class="p-4 text-center text-red-400">Error loading files.</div>';
    }
}

function playVideo(camId, filename) {
    const player = document.getElementById('videoPlayer');
    player.src = `/recordings/${camId}/${filename}`;
    player.play();
}

// --- PTZ ---
let currentPtzCamId = null;

function openPtzModal(id) {
    currentPtzCamId = id;
    const cam = cameras.find(c => c.id === id);
    if (!cam) return;
    
    openModal('ptzModal');
    
    const container = document.getElementById('ptzVideoContainer');
    const existing = container.querySelector('iframe');
    if (existing) existing.remove();
    
    // Use same WebRTC logic
    const hostname = window.location.hostname;
    const port = window.location.port;
    const isDev = port === '3000' || port === '3001'; 
    const streamBase = isDev ? `http://${hostname}:8889/live` : `${window.location.protocol}//${hostname}${port ? ':'+port : ''}/live`;
    const streamUrl = `${streamBase}/${id}/`;
    
    const iframe = document.createElement('iframe');
    iframe.src = streamUrl;
    iframe.className = "w-full h-full"; // Full size of container
    iframe.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture";
    iframe.style.border = "none";
    
    container.appendChild(iframe);
}

async function ptzMove(direction) {
    if (!currentPtzCamId) return;
    
    let vector = { x: 0, y: 0, z: 0 };
    const speed = 0.5; // Moderate speed
    
    switch(direction) {
        case 'up': vector.y = speed; break;
        case 'down': vector.y = -speed; break;
        case 'left': vector.x = -speed; break;
        case 'right': vector.x = speed; break;
        case 'zoomIn': vector.z = speed; break;
        case 'zoomOut': vector.z = -speed; break;
    }
    
    try {
        await fetch(`${API_URL}/cameras/${currentPtzCamId}/ptz`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'move', ...vector })
        });
    } catch(e) {
        console.error("PTZ Move failed", e);
    }
}

async function ptzStop() {
    if (!currentPtzCamId) return;
    try {
        await fetch(`${API_URL}/cameras/${currentPtzCamId}/ptz`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'stop' })
        });
    } catch(e) {
        console.error("PTZ Stop failed", e);
    }
}

// --- Talk to Camera ---
let isTalking = false;
let mediaStream = null;
let audioContext = null;
let mediaRecorder = null;
let audioProcessor = null;

async function checkAudioSupport(camId) {
    try {
        const res = await fetch(`${API_URL}/cameras/${camId}/audio-support`);
        const data = await res.json();
        return data.supported;
    } catch(e) {
        console.error("Failed to check audio support", e);
        return false;
    }
}

async function toggleTalk() {
    if (isTalking) {
        await stopTalk();
    } else {
        await startTalk();
    }
}

async function startTalk() {
    if (!currentPtzCamId) return;
    
    const talkButton = document.getElementById('talkButton');
    const talkIcon = document.getElementById('talkIcon');
    const talkText = document.getElementById('talkText');
    const talkStatus = document.getElementById('talkStatus');
    
    try {
        // Request microphone permission
        talkStatus.textContent = 'Requesting microphone access...';
        mediaStream = await navigator.mediaDevices.getUserMedia({ 
            audio: { 
                echoCancellation: true,
                noiseSuppression: true,
                sampleRate: 8000,
                channelCount: 1
            } 
        });
        
        // Start talk session on server
        talkStatus.textContent = 'Connecting to camera...';
        const startRes = await fetch(`${API_URL}/cameras/${currentPtzCamId}/talk/start`, {
            method: 'POST'
        });
        const startData = await startRes.json();
        
        if (!startRes.ok || !startData.success) {
            throw new Error(startData.error || 'Failed to start talk session');
        }
        
        // Set up audio processing
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 8000 });
        const source = audioContext.createMediaStreamSource(mediaStream);
        
        // Create a ScriptProcessor to capture audio data
        audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);
        
        audioProcessor.onaudioprocess = async (e) => {
            if (!isTalking) return;
            
            const inputData = e.inputBuffer.getChannelData(0);
            // Convert Float32 to Int16
            const int16Data = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
                int16Data[i] = Math.max(-32768, Math.min(32767, Math.floor(inputData[i] * 32768)));
            }
            
            // Send audio data to server
            try {
                await fetch(`${API_URL}/cameras/${currentPtzCamId}/talk/audio`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/octet-stream' },
                    body: int16Data.buffer
                });
            } catch(e) {
                // Silent fail for individual audio chunks
            }
        };
        
        source.connect(audioProcessor);
        audioProcessor.connect(audioContext.destination);
        
        isTalking = true;
        talkButton.classList.remove('bg-gray-700', 'hover:bg-red-600');
        talkButton.classList.add('bg-red-600', 'animate-pulse');
        talkIcon.classList.remove('fa-microphone');
        talkIcon.classList.add('fa-microphone-slash');
        talkText.textContent = 'Stop Talking';
        talkStatus.textContent = 'Speaking to camera...';
        
    } catch(e) {
        console.error("Failed to start talk", e);
        talkStatus.textContent = `Error: ${e.message}`;
        await stopTalk();
    }
}

async function stopTalk() {
    const talkButton = document.getElementById('talkButton');
    const talkIcon = document.getElementById('talkIcon');
    const talkText = document.getElementById('talkText');
    const talkStatus = document.getElementById('talkStatus');
    
    isTalking = false;
    
    // Stop audio processing
    if (audioProcessor) {
        audioProcessor.disconnect();
        audioProcessor = null;
    }
    
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    
    // Stop media stream
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }
    
    // Stop server session
    if (currentPtzCamId) {
        try {
            await fetch(`${API_URL}/cameras/${currentPtzCamId}/talk/stop`, {
                method: 'POST'
            });
        } catch(e) {
            console.error("Failed to stop talk session", e);
        }
    }
    
    // Reset UI
    talkButton.classList.add('bg-gray-700', 'hover:bg-red-600');
    talkButton.classList.remove('bg-red-600', 'animate-pulse');
    talkIcon.classList.add('fa-microphone');
    talkIcon.classList.remove('fa-microphone-slash');
    talkText.textContent = 'Hold to Talk';
    talkStatus.textContent = 'Click to start speaking to the camera';
}

// Update openPtzModal to check for audio support and show/hide talk section
const originalOpenPtzModal = openPtzModal;
openPtzModal = async function(id) {
    originalOpenPtzModal(id);
    
    // Check if camera supports audio
    const talkSection = document.getElementById('talkSection');
    const supported = await checkAudioSupport(id);
    
    if (supported) {
        talkSection.classList.remove('hidden');
    } else {
        talkSection.classList.add('hidden');
    }
    
    // Reset talk state when opening modal
    if (isTalking) {
        await stopTalk();
    }
};

