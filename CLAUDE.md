# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is **electron-hiprint**, an Electron-based silent printing solution that serves as a client for [vue-plugin-hiprint](https://github.com/CcSimple/vue-plugin-hiprint). It provides a local socket.io server (default port 17521) for web applications to send HTML/PDF printing requests.

## Common Commands

### Development

```bash
# Start the application in development mode
npm run start

# Install dependencies
npm install

# Compress source code (reduces final bundle size)
npm run compress

# Restore compressed code
npm run restore
```

### Building

This project supports cross-platform builds:

```bash
# Windows builds
npm run build-w        # Win x32 (nsis:ia32)
npm run build-w-64     # Win x64 (nsis:x64)

# macOS builds
npm run build-m        # macOS x64
npm run build-m-arm64  # macOS Apple Silicon (arm64)
npm run build-m-universal # macOS Universal (x64 + arm64)

# Linux builds
npm run build-l        # Linux x64 (tar.xz)
npm run build-l-arm64  # Linux arm64

# Build all platforms
npm run build-all

# Full release process (compress + build all + restore)
npm run releases
```

### Code Formatting

Prettier is configured with the following settings (`.prettierrc.json`):
- Print width: 80 characters
- 2 space indentation
- No tabs
- Double quotes
- Trailing commas: all
- LF line endings

Use your editor's Prettier integration or run:
```bash
npx prettier --write <file>
```

## Architecture

### Main Process (Electron)

The application follows the standard Electron architecture with a main process managing multiple renderer processes:

**Entry Point**: `main.js`
- Initializes the application with single-instance lock
- Creates the main window with minimal UI
- Sets up socket.io server (port configurable, default 17521)
- Manages system tray integration
- Handles window lifecycle (minimize to tray vs quit)

### Core Components

#### 1. **Main Process Services** (`src/`)
- **`helper.js`**: Application lifecycle management (quit, cleanup)
- **`print.js`**: Printer window management and HTML/PDF printing logic
- **`pdf-print.js`**: PDF export and printing implementation
- **`render.js`**: Template rendering services for JPEG/PDF generation
- **`set.js`**: Settings window management and configuration UI
- **`printLog.js`**: Print history logging and management

#### 2. **Utility Modules** (`tools/`)
- **`utils.js`**: Centralized utilities
  - Application settings via `electron-store` (see schema in `utils.js:13-72`)
  - Network address handling (IP, MAC, IPv6)
  - Client info emission
  - Socket event initialization (server & client)
- **`log.js`**: Logging infrastructure
- **`database.js`**: SQLite database for print logs (`print_logs` table)
- **`code_compress.js`**: Source code compression utility
- **`rename.js`**: Post-build file renaming

#### 3. **Frontend Assets** (`assets/`)
- `index.html`: Main window UI (minimal, mainly for loading)
- `set.html`: Settings UI with Element-UI components
- `print.html`: Hidden print window (loads HTML content)
- `printLog.html`: Print history viewer
- `render.html`: Template rendering window
- `loading.html`: Loading screen to prevent white flash

#### 4. **Plugin Modules** (`plugin/`)
Versioned vue-plugin-hiprint bundles (0.0.52, 0.0.54-fix, 0.0.56, 0.0.58-fix, 0.0.60)

### Print Pipeline

1. **HTML Printing**: `print.js` → `pdf-print.js`
   - Renders HTML in hidden BrowserWindow
   - Uses Electron's `webContents.print()` for silent printing

2. **PDF Printing**:
   - First generates PDF via `webContents.printToPDF()`
   - Then prints via platform-specific tools:
     - Windows: `pdf-to-printer` or `win32-pdf-printer`
     - Unix/Linux: `unix-print`

3. **Network PDF**: Downloads remote PDF first, then prints

4. **Print Queue**: `global.PRINT_RUNNER` (concurrent-tasks) with concurrency = 1 to prevent crashes

### Socket.IO Events

**Server Events** (local socket.io):
- `news`: Main print event (receives {html, templateId, printer, pageSize})
- `getClientInfo`: Request client information
- `refreshPrinterList`: Request updated printer list
- `getPaperSizeInfo`: Get printer paper sizes (Windows only)

**Client Events** (to transit service):
- `clients`: Send client list to transit service
- `printerList`: Send printer list to transit service

**Response Events**:
- `success`: Print success with templateId
- `error`: Print failure with templateId
- `clientInfo`: Client system information
- `printerList`: Available printers

### Settings & Configuration

Settings are managed via `electron-store` with validation (see `tools/utils.js:13-72`):

Key settings:
- `mainTitle`: Application title
- `openAtLogin`: Auto-start with system
- `openAsHidden`: Start minimized to tray
- `port`: Socket server port (10000-65535, default 17521)
- `connectTransit`: Enable transit service connection
- `transitUrl`/`transitToken`: Transit service configuration
- `closeType`: Window close behavior (tray or quit)
- `defaultPrinter`: Default printer selection
- `logPath`/`pdfPath`: File system paths

### Database

SQLite database (`tools/database.sqlite`) stores:
- `print_logs` table: Print history with timestamps, socketId, printer, templateId, status, error messages

## Key Technical Details

- **Electron Version**: 22.0.0 (last version supporting Windows 7)
- **Node.js**: 16.17.1
- **Print Queue**: Prevents concurrent printing crashes using `concurrent-tasks` library
- **Print Queue Concurrency**: Set to 1
- **Fragment Mapping**: `global.PRINT_FRAGMENTS_MAPPING` for batch print tracking
- **URL Scheme**: `hiprint://` protocol for launching from web apps
- **Context Isolation**: Disabled (`nodeIntegration: true`, `contextIsolation: false`) for Electron APIs in renderer

## Development Tips

### Testing Print Functionality

The print window is hidden by default. To debug, temporarily uncomment in `src/print.js:36-39`:
```javascript
if (!app.isPackaged) {
  PRINT_WINDOW.webContents.openDevTools();
}
```

### Adding New Print Types

1. Extend the event handler in `src/print.js` (`do` event)
2. Add print logic to `src/pdf-print.js` if PDF conversion needed
3. Update Socket.IO event handling if client-facing

### Modifying Settings Schema

Edit the schema in `tools/utils.js:13-72`, then restart the application. Settings are validated on read.

### Print Logging

Print attempts are logged to SQLite database automatically in `src/print.js`. Check `tools/database.js:19-34` for schema.

## Version Notes

- Current version: 1.0.12-beta3
- Uses `uuid` v7 API (`v7: uuidv7`)
- SQLite3 version locked at 5.1.6 for compatibility
- Build artifacts go to `out/` directory
- Code compression can reduce bundle size (see `tools/code_compress.js`)

## Integration Notes

When connecting from web applications:
1. Connect via socket.io-client to `http://localhost:17521`
2. Auth with token: `"vue-plugin-hiprint"` (for compatibility) or custom token from settings
3. Listen for `clientInfo` and `printerList` events
4. Send print jobs via `socket.emit("news", {...})`

For transit service integration, also set `connectTransit: true` in settings and configure `transitUrl` and `transitToken`.
