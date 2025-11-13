/*
 * @Date: 2024-01-25 15:52:14
 * @LastEditors: admin@54xavier.cn
 * @LastEditTime: 2024-12-23 15:23:56
 * @FilePath: \electron-hiprint\main.js
 */
const {
  app,
  BrowserWindow,
  BrowserView,
  ipcMain,
  Notification,
  Tray,
  Menu,
  shell,
  globalShortcut,
} = require("electron");
const electronLog = require("electron-log");
const path = require("path");
const server = require("http").createServer();
const helper = require("./src/helper");
const printSetup = require("./src/print");
const renderSetup = require("./src/render");
const setSetup = require("./src/set");
const printLogSetup = require("./src/printLog");
const {
  store,
  address,
  initServeEvent,
  initClientEvent,
  getMachineId,
  showAboutDialog,
} = require("./tools/utils");

const TaskRunner = require("concurrent-tasks");
const dayjs = require("dayjs");

const logPath = store.get("logPath") || app.getPath("logs");

Object.assign(console, electronLog.functions);

electronLog.transports.file.resolvePathFn = () =>
  path.join(logPath, dayjs().format("YYYY-MM-DD.log"));

// 监听崩溃事件
process.on("uncaughtException", (error) => {
  console.error(error);
});

// 监听渲染进程崩溃
app.on("web-contents-created", (event, contents) => {
  contents.on("render-process-gone", (event, details) => {
    console.error(details.reason);
  });
});

if (store.get("disabledGpu")) {
  app.commandLine.appendSwitch("disable-gpu");
}

// 添加 IPC 监听器，处理页面内发送的退出全屏请求
ipcMain.on("exit-fullscreen", () => {
  try {
    if (global.AUTO_OPEN_URL_SHOWN && MAIN_WINDOW && MAIN_WINDOW.isFullScreen()) {
      console.log("==> IPC 请求退出全屏 <==");
      MAIN_WINDOW.setFullScreen(false);
    }
  } catch (err) {
    console.error("IPC 退出全屏失败:", err);
  }
});

// 添加 IPC 监听器，处理页面内发送的进入全屏请求
ipcMain.on("enter-fullscreen", () => {
  try {
    if (global.AUTO_OPEN_URL_SHOWN && MAIN_WINDOW && !MAIN_WINDOW.isFullScreen()) {
      console.log("==> IPC 请求进入全屏 <==");
      MAIN_WINDOW.setFullScreen(true);
    }
  } catch (err) {
    console.error("IPC 进入全屏失败:", err);
  }
});

// 主进程
global.MAIN_WINDOW = null;
// 托盘
global.APP_TRAY = null;
// 打印窗口
global.PRINT_WINDOW = null;
// 设置窗口
global.SET_WINDOW = null;
// 渲染窗口
global.RENDER_WINDOW = null;
// 打印日志窗口
global.PRINT_LOG_WINDOW = null;
// socket.io 服务端
global.SOCKET_SERVER = null;
// socket.io-client 客户端
global.SOCKET_CLIENT = null;
// 加载页面 BrowserView
global.LOADING_BROWSER_VIEW = null;
// 是否已通过autoOpenUrl显示窗口
global.AUTO_OPEN_URL_SHOWN = false;
// 打印队列，解决打印并发崩溃问题
global.PRINT_RUNNER = new TaskRunner({ concurrency: 1 });
// 打印队列 done 集合
global.PRINT_RUNNER_DONE = {};
// 分批打印任务的打印任务信息
global.PRINT_FRAGMENTS_MAPPING = {
  // [id: string]: { // 当前打印任务id，当此任务完成或超过指定时间会删除该对象
  //   {
  //      total: number, // html片段总数
  //      count: number, // 已经保存完成的片段数量，当count与total相同时，所有片段传输完成
  //      fragments: Array<string | undefined>, // 按照顺序摆放的html文本片段
  //      updateTime: number, // 最后更新此任务信息的时间戳，用于超时时移除此对象
  //   }
  // }
};
global.RENDER_RUNNER = new TaskRunner({ concurrency: 1 });
global.RENDER_RUNNER_DONE = {};

// socket.io 服务端，用于创建本地服务
const ioServer = (global.SOCKET_SERVER = new require("socket.io")(server, {
  pingInterval: 10000,
  pingTimeout: 5000,
  maxHttpBufferSize: 10000000000,
  allowEIO3: true, // 兼容 Socket.IO 2.x
  // 跨域问题(Socket.IO 3.x 使用这种方式)
  cors: {
    // origin: "*",
    // 兼容 Socket.IO 2.x
    origin: (requestOrigin, callback) => {
      // 允许所有域名连接
      callback(null, requestOrigin);
    },
    methods: "GET, POST, PUT, DELETE, OPTIONS",
    allowedHeaders: "*",
    // 详情参数见 https://www.npmjs.com/package/cors
    credentials: false,
  },
}));

// socket.io 客户端，用于连接中转服务
const ioClient = require("socket.io-client").io;

/**
 * @description: 初始化
 */
async function initialize() {
  // 限制一个窗口
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    // 销毁所有窗口、托盘、退出应用
    helper.appQuit();
  }

  // 当运行第二个实例时,聚焦到 MAIN_WINDOW 这个窗口
  app.on("second-instance", () => {
    if (MAIN_WINDOW) {
      if (MAIN_WINDOW.isMinimized()) {
        // 将窗口从最小化状态恢复到以前的状态
        MAIN_WINDOW.restore();
      }
      MAIN_WINDOW.focus();
    }
  });

  // 允许渲染进程创建通知
  ipcMain.on("notification", (event, data) => {
    const notification = new Notification(data);
    // 显示通知
    notification.show();
  });

  // 打开设置窗口
  ipcMain.on("openSetting", openSetWindow);

  // 获取设备唯一id
  ipcMain.on("getMachineId", (event) => {
    const machineId = getMachineId();
    event.sender.send("machineId", machineId);
  });

  // 获取设备ip、mac等信息
  ipcMain.on("getAddress", (event) => {
    address.all().then((obj) => {
      event.sender.send("address", {
        ...obj,
        port: store.get("port"),
      });
    });
  });

  // 当electron完成初始化
  app.whenReady().then(() => {
    // 创建浏览器窗口
    createWindow();
    app.on("activate", function() {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
    console.log("==> Electron-hiprint 启动 <==");
  });
}

/**
 * @description: 创建渲染进程 主窗口
 * @return {BrowserWindow} MAIN_WINDOW 主窗口
 */
async function createWindow() {
  const windowOptions = {
    width: 500, // 窗口宽度
    height: 300, // 窗口高度
    title: store.get("mainTitle") || "Electron-hiprint",
    useContentSize: true, // 窗口大小不包含边框
    center: true, // 居中
    resizable: true, // 允许窗口缩放和全屏
    show: false, // 初始隐藏
    webPreferences: {
      // 设置此项为false后，才可在渲染进程中使用 electron api
      contextIsolation: false,
      nodeIntegration: true,
    },
  };

  // 窗口左上角图标
  if (!app.isPackaged) {
    windowOptions.icon = path.join(__dirname, "build/icons/256x256.png");
  } else {
    app.setLoginItemSettings({
      openAtLogin: store.get("openAtLogin"),
      openAsHidden: store.get("openAsHidden"),
    });
  }

  // 创建主窗口
  MAIN_WINDOW = new BrowserWindow(windowOptions);

  // 添加加载页面 解决白屏的问题
  global.LOADING_BROWSER_VIEW = loadingView(windowOptions);

  // 初始化系统设置
  systemSetup();

  // 检查是否需要启动时打开自定义页面
  if (store.get("autoOpenUrl") && store.get("autoOpenUrlValue")) {
    const url = store.get("autoOpenUrlValue");
    // 加载URL
    MAIN_WINDOW.webContents.loadURL(url);
    // 设置一个标志，表示已经手动显示了窗口
    global.AUTO_OPEN_URL_SHOWN = true;
  } else {
    // 加载主页面
    const indexHtml = path.join("file://", app.getAppPath(), "assets/index.html");
    MAIN_WINDOW.webContents.loadURL(indexHtml);
  }

  // 退出
  MAIN_WINDOW.on("closed", () => {
    MAIN_WINDOW = null;
    server.close();
  });

  // 点击关闭，最小化到托盘
  MAIN_WINDOW.on("close", (event) => {
    if (store.get("closeType") === "tray") {
      // 最小化到托盘
      MAIN_WINDOW.hide();

      // 隐藏任务栏
      MAIN_WINDOW.setSkipTaskbar(true);

      // 阻止窗口关闭
      event.preventDefault();
    } else {
      // 销毁所有窗口、托盘、退出应用
      helper.appQuit();
    }
  });

  // 主窗口页面完全加载完成
  MAIN_WINDOW.webContents.on("did-finish-load", async () => {
    try {
      if (global.AUTO_OPEN_URL_SHOWN) {
        // 如果是通过autoOpenUrl显示的窗口，在页面完全加载后确保全屏
        MAIN_WINDOW.setFullScreen(true);
      }
      console.log('页面加载完成，注入键盘监听器');
      // 延迟注入键盘监听器
      setTimeout(() => injectKeyboardListener(), 100);
    } catch (err) {
      console.error("全屏失败:", err);
    }
  });

  // 主窗口导航事件
  MAIN_WINDOW.webContents.on("will-navigate", (event, navigationUrl) => {
    try {
      if (global.AUTO_OPEN_URL_SHOWN) {
        // 在自助报告打印模式下，保持全屏状态
        MAIN_WINDOW.setFullScreen(true);
      }
    } catch (err) {
      console.error("导航时全屏失败:", err);
    }
  });

  // 定义键盘监听器注入函数
  const injectKeyboardListener = () => {
    MAIN_WINDOW.webContents.executeJavaScript(`
      (function() {
        console.log('添加页面键盘监听器');

        // 清除旧的监听器标记
        window.__HIPRINT_KEYBOARD_LISTENER_ADDED__ = false;

        // 添加页面内IPC监听器，响应主进程的IPC请求
        if (window.require) {
          try {
            const { ipcRenderer } = window.require('electron');
            ipcRenderer.on('fullscreen-status-changed', (event, isFullScreen) => {
              console.log('全屏状态改变:', isFullScreen);
            });
          } catch (err) {
            console.error('添加IPC监听器失败:', err);
          }
        }

        // 添加键盘事件监听器
        document.addEventListener('keydown', function(e) {
          // ESC 键退出全屏
          if (e.key === 'Escape') {
            console.log('ESC 键退出全屏');
            if (window.require) {
              try {
                window.require('electron').ipcRenderer.send('exit-fullscreen');
                e.preventDefault();
              } catch (err) {
                console.error('IPC 发送失败:', err);
              }
            }
          }
          // F11 键切换全屏状态
          else if (e.key === 'F11') {
            console.log('F11 键切换全屏状态');
            if (window.require) {
              try {
                const ipcRenderer = window.require('electron').ipcRenderer;
                const currentWindow = window.require('electron').remote.getCurrentWindow();
                const isFullScreen = currentWindow.isFullScreen();
                console.log('当前全屏状态:', isFullScreen);

                if (isFullScreen) {
                  console.log('发送退出全屏请求');
                  ipcRenderer.send('exit-fullscreen');
                } else {
                  console.log('发送进入全屏请求');
                  ipcRenderer.send('enter-fullscreen');
                }
                e.preventDefault();
              } catch (err) {
                console.error('IPC 发送失败:', err);
              }
            }
          }
        });

        // 标记监听器已添加
        window.__HIPRINT_KEYBOARD_LISTENER_ADDED__ = true;
        console.log('页面内键盘监听器添加完成');
      })();
    `).catch(err => console.error('注入键盘监听器失败:', err));
  };

  // 页面导航完成后重新注入键盘监听器
  MAIN_WINDOW.webContents.on("did-navigate", () => {
    console.log('页面导航完成，重新注入键盘监听器');
    // 延迟注入，确保页面DOM准备好
    setTimeout(() => injectKeyboardListener(), 500);
  });

  // 页面内容变化时也重新注入监听器
  MAIN_WINDOW.webContents.on("dom-content-loaded", () => {
    console.log('DOM内容加载完成，注入键盘监听器');
    setTimeout(() => injectKeyboardListener(), 300);
  });

  // 页面内容更新时也重新注入监听器（SPA应用）
  MAIN_WINDOW.webContents.on("did-start-loading", () => {
    console.log('页面开始重新加载，清理监听器标记');
    // 清理监听器标记，让重新加载后可以重新注入
    MAIN_WINDOW.webContents.executeJavaScript(`
      window.__HIPRINT_KEYBOARD_LISTENER_ADDED__ = false;
    `).catch(() => {});
  });

  // 主窗口 Dom 加载完毕
  MAIN_WINDOW.webContents.on("dom-ready", async () => {
    try {
      if (!global.AUTO_OPEN_URL_SHOWN) {
        // 只有当不是通过autoOpenUrl显示窗口时才根据openAsHidden控制
        if (!store.get("openAsHidden")) {
          MAIN_WINDOW.show();
        }
        // 移除 loading view
        if (global.LOADING_BROWSER_VIEW) {
          global.LOADING_BROWSER_VIEW.webContents.destroy();
          MAIN_WINDOW.removeBrowserView(global.LOADING_BROWSER_VIEW);
          global.LOADING_BROWSER_VIEW = null;
        }
        // 在自助报告打印模式下，即使没有全屏也要注入键盘监听器
        if (global.AUTO_OPEN_URL_SHOWN) {
          setTimeout(() => injectKeyboardListener(), 200);
        }
      } else {
        // 如果是通过autoOpenUrl显示的窗口，立即移除loading view并全屏
        if (global.LOADING_BROWSER_VIEW) {
          global.LOADING_BROWSER_VIEW.webContents.destroy();
          MAIN_WINDOW.removeBrowserView(global.LOADING_BROWSER_VIEW);
          global.LOADING_BROWSER_VIEW = null;
        }
        // 立即显示并全屏
        MAIN_WINDOW.show();
        // 等待一帧后再全屏，确保窗口已经完全显示
        setTimeout(() => {
          MAIN_WINDOW.setFullScreen(true);
          // 全屏后注入键盘监听器
          setTimeout(() => injectKeyboardListener(), 100);
        }, 50);
      }
      // 未打包时打开开发者工具
      if (!app.isPackaged) {
        MAIN_WINDOW.webContents.openDevTools();
      }
      // 本地服务开启端口监听
      server.listen({port: store.get("port") || 17521, host: '0.0.0.0'});
      // 初始化本地 服务端事件
      initServeEvent(ioServer);
      // 有配置中转服务时连接中转服务
      if (
        store.get("connectTransit") &&
        store.get("transitUrl") &&
        store.get("transitToken")
      ) {
        global.SOCKET_CLIENT = ioClient(store.get("transitUrl"), {
          transports: ["websocket"],
          query: {
            client: "electron-hiprint",
          },
          auth: {
            token: store.get("transitToken"),
          },
        });

        // 初始化中转 客户端事件
        initClientEvent();
      }
    } catch (error) {
      console.error(error);
    }
  });

  // 初始化托盘
  initTray();

  // 添加全局键盘事件监听器，作为保底方案
  console.log("==> 注册全局快捷键（保底方案） <==");
  globalShortcut.register("Escape", () => {
    try {
      if (MAIN_WINDOW && MAIN_WINDOW.isFullScreen()) {
        console.log("==>全局 ESC 键退出全屏 <==");
        MAIN_WINDOW.setFullScreen(false);
      }
    } catch (err) {
      console.error("全局 ESC 键退出全屏失败:", err);
    }
  });

  // F11 快捷键作为保底方案
  globalShortcut.register("F11", () => {
    try {
      if (MAIN_WINDOW) {
        console.log("==>全局 F11 键切换全屏 <==");
        const isFullScreen = MAIN_WINDOW.isFullScreen();
        if (isFullScreen) {
          MAIN_WINDOW.setFullScreen(false);
        } else {
          MAIN_WINDOW.setFullScreen(true);
        }
      }
    } catch (err) {
      console.error("全局 F11 键切换全屏失败:", err);
    }
  });

  // 打印窗口初始化
  await printSetup();
  // 渲染窗口初始化
  await renderSetup();

  return MAIN_WINDOW;
}

/**
 * @description: 加载等待页面，解决主窗口白屏问题
 * @param {Object} windowOptions 主窗口配置
 * @return {BrowserView}
 */
function loadingView(windowOptions) {
  const loadingBrowserView = new BrowserView();
  MAIN_WINDOW.setBrowserView(loadingBrowserView);
  loadingBrowserView.setBounds({
    x: 0,
    y: 0,
    width: windowOptions.width,
    height: windowOptions.height,
  });

  const loadingHtml = path.join(
    "file://",
    app.getAppPath(),
    "assets/loading.html",
  );
  loadingBrowserView.webContents.loadURL(loadingHtml);

  return loadingBrowserView;
}

/**
 * @description: 初始化系统设置
 * @return {Void}
 */
function systemSetup() {
  // 隐藏菜单栏
  Menu.setApplicationMenu(null);
}

/**
 * @description: 显示主窗口
 * @return {Void}
 */
function showMainWindow() {
  if (MAIN_WINDOW.isMinimized()) {
    // 将窗口从最小化状态恢复到以前的状态
    MAIN_WINDOW.restore();
  }
  if (!MAIN_WINDOW.isVisible()) {
    // 主窗口关闭不会被销毁，只是隐藏，重新显示即可
    MAIN_WINDOW.show();
  }
  if (!MAIN_WINDOW.isFocused()) {
    // 主窗口未聚焦，使其聚焦
    MAIN_WINDOW.focus();
  }
  MAIN_WINDOW.setSkipTaskbar(false);
}

/**
 * @description: 初始化托盘
 * @return {Tray} APP_TRAY 托盘实例
 */
function initTray() {
  let trayPath = path.join(app.getAppPath(), "assets/icons/tray.png");

  APP_TRAY = new Tray(trayPath);

  // 托盘提示标题
  APP_TRAY.setToolTip("hiprint");

  // 托盘菜单
  const trayMenuTemplate = [
      {
        // 神知道为什么 linux 上无法识别 tray click、double-click，只能添加一个菜单
        label: "显示主窗口",
        click: () => {
          showMainWindow();
        },
      },
      {
        label: "设置",
        click: () => {
          console.log("==>TRAY 打开设置窗口<==");
          openSetWindow();
        },
      },
      {
        label: "日志",
        click: () => {
          console.log("==>TRAY 查看软件日志<==");
          shell.openPath(logPath);
        },
      },
      {
        label: "打印记录",
        click: () => {
          console.log("==>TRAY 打开打印记录窗口<==");
          if (!PRINT_LOG_WINDOW) {
            printLogSetup();
          } else {
            PRINT_LOG_WINDOW.show();
          }
        },
      },
      {
        label: "关于",
        click: () => {
          console.log("==>TRAY 打开关于弹框<==");
          showAboutDialog();
        },
      },
      {
        label: "退出",
        click: () => {
          console.log("==>TRAY 退出应用<==");
          helper.appQuit();
        },
      },
    ];

  APP_TRAY.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate));

  // 监听点击事件
  APP_TRAY.on("click", function() {
    console.log("==>TRAY 点击托盘图标<==");
    showMainWindow();
  });
  return APP_TRAY;
}

/**
 * @description: 打开设置窗口
 * @return {BrowserWindow} SET_WINDOW 设置窗口
 */
async function openSetWindow() {
  if (!SET_WINDOW) {
    await setSetup();
  } else {
    SET_WINDOW.show();
  }
  return SET_WINDOW;
}

// 初始化主窗口
initialize();
