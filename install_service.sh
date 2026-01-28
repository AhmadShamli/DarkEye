#!/bin/bash

# DarkEye Service Installer for Systemd

SERVICE_NAME="darkeye"
SERVICE_FILE="darkeye.service"
INSTALL_DIR=$(pwd)
CURRENT_USER=$(whoami)
NPM_PATH=$(which npm)

echo "Installing DarkEye Service..."
echo "  Directory: $INSTALL_DIR"
echo "  User:      $CURRENT_USER"
echo "  NPM:       $NPM_PATH"

if [ -z "$NPM_PATH" ]; then
    echo "Error: npm not found. Please install Node.js/npm first."
    exit 1
fi

# Update service file paths dynamically
sed -i "s|WorkingDirectory=.*|WorkingDirectory=$INSTALL_DIR|g" $SERVICE_FILE
sed -i "s|ExecStart=.*|ExecStart=$NPM_PATH start|g" $SERVICE_FILE
sed -i "s|User=.*|User=$CURRENT_USER|g" $SERVICE_FILE

# Inject PATH to ensure npm can find node (especially for NVM users)
NODE_BIN_DIR=$(dirname "$NPM_PATH")
DEFAULT_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
FULL_PATH="$NODE_BIN_DIR:$DEFAULT_PATH"

# Remove any existing PATH definition to avoid duplicates if run multiple times (optional safety)
sed -i "/Environment=PATH=/d" $SERVICE_FILE

# Insert PATH before other Environment variables
sed -i "/Environment=NODE_ENV=production/i Environment=PATH=$FULL_PATH" $SERVICE_FILE

echo "  Updated $SERVICE_FILE with current paths."

# Copy to systemd
echo "  Copying to /etc/systemd/system/..."
sudo cp $SERVICE_FILE /etc/systemd/system/$SERVICE_NAME.service

# Reload and Enable
echo "  Reloading systemd..."
sudo systemctl daemon-reload
sudo systemctl enable $SERVICE_NAME
sudo systemctl restart $SERVICE_NAME

echo "Success! DarkEye is now running and will auto-start on boot."
echo "Check status: sudo systemctl status $SERVICE_NAME"
echo "View logs:    sudo journalctl -u $SERVICE_NAME -f"
