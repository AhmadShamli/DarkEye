# DarkEye - Modern NVR

**DarkEye** is a self-hosted, lightweight, and resilient Network Video Recorder (NVR) built with **Node.js** and **MediaMTX**. It focuses on modern aesthetics, low-latency streaming, and robust recording capabilities.

## 🚀 Key Features

*   **⚡ Ultra-Low Latency Live View**: Uses **WebRTC** (via MediaMTX) for sub-second streaming delay.
*   **🛡️ Crash-Resilient Recording**: Records in **MKV** format to prevent data loss during power cuts.
*   **🔒 Proxy Architecture**: Isolates your cameras from clients. The NVR maintains a single connection to the camera, rebroadcasting it to multiple viewers.
*   **⏱️ Timelapse**: Integrated timelapse generator (e.g., compress 24 hours into 20 minutes) with configurable intervals.
*   **💾 Smart Storage**: Automatic cleanup based on retention hours or disk usage limits.
*   **📱 Modern UI**: Responsive, dark-mode dashboard for easy management.

## 🛠️ Architecture

DarkEye uses a **Split-Process Architecture** for maximum stability:

1.  **MediaMTX (RTSP Proxy)**: Handles the heavy lifting of RTSP ingestion and WebRTC broadcasting.
2.  **Node.js Server**: Manages configuration, database, and API.
3.  **FFmpeg Workers**:
    *   **Recorder**: Connects to the local Proxy -> Saves to Disk.
    *   **Timelapse**: Secondary low-framerate capture process.

## 📦 Installation

### Prerequisites
*   **Node.js** (v18+)
*   **FFmpeg** (Must be in your system PATH or `bin/` folder)
*   **Git**

### Setup
1.  Clone the repository:
    ```bash
    git clone https://github.com/yourusername/DarkEye.git
    cd DarkEye
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

3.  Start the server:
    ```bash
    npm start
    ```

    *First run will automatically download the correct MediaMTX binary for your system.*

4.  Open the dashboard:
    *   http://localhost:3000

## ⚙️ Configuration

*   **Web Interface**: Port `3000`
*   **RTSP Server**: Port `8554`
*   **WebRTC Server**: Port `8889`

### Adding Cameras
1.  Click **"Add Camera"**.
2.  Enter **RTSP URL** (e.g., `rtsp://user:pass@192.168.1.100/stream1`).
3.  Choose **Record Mode**:
    *   **Raw**: Direct copy (Low CPU).
    *   **Encode**: Re-encode to H.264 (High CPU).
    *   **Disabled**: Live View only.
    
## 🚀 Deployment / Auto-Start

### Linux (Systemd) - Recommended for Linux Servers
We include a helper script to automatically install DarkEye as a system service.

1.  Grant executable permission:
    ```bash
    chmod +x install_service.sh
    ```
2.  Run the installer (requires sudo):
    ```bash
    ./install_service.sh
    ```
    This will create `/etc/systemd/system/darkeye.service` and enable it on boot.

### Windows (PM2)
For Windows, we recommend using **PM2** to manage the process.

1.  Install PM2 globally:
    ```powershell
    npm install pm2 -g
    npm install pm2-windows-startup -g
    ```
2.  Setup Startup Script:
    ```powershell
    pm2-startup install
    ```
3.  Start DarkEye and Save:
    ```powershell
    pm2 start src/server.js --name darkeye
    pm2 save
    ```

## 📂 File Structure
```
DarkEye/
├── bin/              # MediaMTX binaries
├── data/             # SQLite Database (darkeye.db)
├── recordings/       # Video Storage
│   └── [CAM_ID]/
│       ├── 2024-01-01_12-00-00.mkv
│       └── timelapse/
├── public/           # Frontend Assets
└── src/              # Source Code
```

## 📝 License
MIT
