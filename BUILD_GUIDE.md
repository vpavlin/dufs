# Building Dufs with Mobile-Friendly UI

This guide explains how to build and run Dufs with the new mobile-friendly UI changes.

## Quick Start (Docker)

The easiest way to build and run Dufs with your custom assets is using Docker:

### Build the Docker Image

```bash
# Build the image (this will compile Dufs from source)
docker build -t dufs-mobile .
```

This uses the [`Dockerfile`](Dockerfile:1) which:
1. Compiles Dufs from Rust source code for both AMD64 and ARM64 architectures
2. Creates a minimal container with just the binary
3. The assets are embedded in the binary during compilation

### Run the Container

```bash
# Run with all permissions enabled, serving current directory
docker run -v $(pwd):/data -p 5000:5000 --rm dufs-mobile /data -A

# Or with specific permissions
docker run -v $(pwd):/data -p 5000:5000 --rm dufs-mobile /data --allow-upload --allow-download

# With authentication
docker run -v $(pwd):/data -p 5000:5000 --rm dufs-mobile /data -A -a admin:password@/:rw
```

Then access at: http://localhost:5000

## Building from Source (Without Docker)

If you want to build the binary directly:

### Prerequisites

- Rust toolchain (install from https://rustup.rs/)
- Cargo (comes with Rust)

### Build Steps

```bash
# 1. Build the release binary
cargo build --release

# 2. The binary will be at: target/release/dufs

# 3. Run it
./target/release/dufs -A
```

The assets in the [`assets/`](assets/) directory are automatically embedded into the binary during compilation.

## Using Custom Assets at Runtime

If you want to test changes without rebuilding, you can use the `--assets` flag:

```bash
# With Docker
docker run -v $(pwd):/data -v $(pwd)/assets:/assets -p 5000:5000 --rm dufs-mobile /data -A --assets /assets

# With local binary
./target/release/dufs -A --assets ./assets
```

This tells Dufs to use the assets from the specified directory instead of the embedded ones.

## Development Workflow

For rapid development of the UI:

1. **Run Dufs with custom assets directory:**
   ```bash
   cargo run -- -A --assets ./assets
   ```

2. **Make changes to:**
   - [`assets/index.html`](assets/index.html:1)
   - [`assets/index.css`](assets/index.css:1)
   - [`assets/index.js`](assets/index.js:1)
   - [`assets/manifest.json`](assets/manifest.json:1)

3. **Refresh browser** to see changes (no rebuild needed)

4. **When satisfied, rebuild** to embed the assets:
   ```bash
   cargo build --release
   ```

## Testing Mobile UI

### On Desktop Browser

1. Open Chrome/Firefox DevTools (F12)
2. Click the device toolbar icon (or Ctrl+Shift+M)
3. Select a mobile device (e.g., iPhone 12, Pixel 5)
4. Test the responsive layout

### On Real Mobile Device

#### Option 1: Local Network Access

1. Find your computer's IP address:
   ```bash
   # Linux/Mac
   ip addr show | grep inet
   # or
   ifconfig | grep inet
   ```

2. Run Dufs bound to all interfaces:
   ```bash
   docker run -v $(pwd):/data -p 5000:5000 --rm dufs-mobile /data -A -b 0.0.0.0
   ```

3. On your mobile device, navigate to:
   ```
   http://YOUR_COMPUTER_IP:5000
   ```

#### Option 2: Using ngrok (for remote testing)

1. Install ngrok: https://ngrok.com/download

2. Run Dufs locally:
   ```bash
   docker run -v $(pwd):/data -p 5000:5000 --rm dufs-mobile /data -A
   ```

3. In another terminal, expose it:
   ```bash
   ngrok http 5000
   ```

4. Use the ngrok URL on your mobile device

### Testing PWA Installation

#### iOS (Safari)

1. Open the Dufs URL in Safari
2. Tap the Share button (square with arrow)
3. Scroll down and tap "Add to Home Screen"
4. Tap "Add"
5. The app icon will appear on your home screen

#### Android (Chrome)

1. Open the Dufs URL in Chrome
2. Tap the menu (three dots)
3. Tap "Install app" or "Add to Home Screen"
4. Tap "Install"
5. The app will appear in your app drawer

## Build Options

### Multi-Architecture Docker Build

To build for multiple architectures (useful for deployment):

```bash
# Enable Docker buildx
docker buildx create --use

# Build for multiple platforms
docker buildx build --platform linux/amd64,linux/arm64 -t dufs-mobile .
```

### Optimized Release Build

For production deployment:

```bash
# Build with maximum optimizations
cargo build --release

# Strip the binary to reduce size
strip target/release/dufs

# The binary is now ready for deployment
```

## Troubleshooting

### Assets Not Updating

If you're using `--assets` flag and changes aren't showing:

1. Clear browser cache (Ctrl+Shift+R or Cmd+Shift+R)
2. Check that you're pointing to the correct assets directory
3. Verify file permissions

### Docker Build Fails

If the Docker build fails:

1. Ensure you have enough disk space
2. Try cleaning Docker cache:
   ```bash
   docker system prune -a
   ```
3. Check Docker logs for specific errors

### Mobile UI Not Responsive

If the mobile UI isn't working:

1. Verify the viewport meta tag is present in [`index.html`](assets/index.html:6)
2. Check browser console for CSS errors
3. Ensure you're using the updated [`index.css`](assets/index.css:1)

## Deployment

### Docker Compose

Create a `docker-compose.yml`:

```yaml
version: '3'
services:
  dufs:
    build: .
    ports:
      - "5000:5000"
    volumes:
      - ./data:/data
    command: /data -A
    restart: unless-stopped
```

Run with:
```bash
docker-compose up -d
```

### Systemd Service (Linux)

Create `/etc/systemd/system/dufs.service`:

```ini
[Unit]
Description=Dufs File Server
After=network.target

[Service]
Type=simple
User=www-data
ExecStart=/usr/local/bin/dufs /var/www/files -A
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable dufs
sudo systemctl start dufs
```

## Next Steps

- See [`MOBILE_CHANGES.md`](MOBILE_CHANGES.md:1) for details on what was changed
- Check [`README.md`](README.md:1) for all Dufs features and options
- Customize the UI further by modifying files in [`assets/`](assets/)
