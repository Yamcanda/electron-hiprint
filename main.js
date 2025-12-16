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
    if (SELF_SERVICE_WINDOW && SELF_SERVICE_WINDOW.isFullScreen()) {
      console.log("==> IPC 请求退出全屏 <==");
      SELF_SERVICE_WINDOW.setFullScreen(false);
    }
  } catch (err) {
    console.error("IPC 退出全屏失败:", err);
  }
});

// 添加 IPC 监听器，处理页面内发送的进入全屏请求
ipcMain.on("enter-fullscreen", () => {
  try {
    if (SELF_SERVICE_WINDOW && !SELF_SERVICE_WINDOW.isFullScreen()) {
      console.log("==> IPC 请求进入全屏 <==");
      SELF_SERVICE_WINDOW.setFullScreen(true);
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
// 自助报告打印窗口
global.SELF_SERVICE_WINDOW = null;
// socket.io 服务端
global.SOCKET_SERVER = null;
// socket.io-client 客户端
global.SOCKET_CLIENT = null;
// 加载页面 BrowserView
global.LOADING_BROWSER_VIEW = null;
// 是否已通过autoOpenUrl显示窗口
global.AUTO_OPEN_URL_SHOWN = false;

/**
 * 加载HTML模板文件并替换变量
 * @param {string} templatePath - 模板文件路径
 * @param {Object} variables - 要替换的变量
 * @returns {string} 替换后的HTML字符串
 */
async function loadTemplate(templatePath, variables) {
  try {
    const templatePathAbs = path.join(app.getAppPath(), templatePath);
    const fs = require('fs');
    const templateContent = fs.readFileSync(templatePathAbs, 'utf-8');

    let result = templateContent;
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`\\$\\{${key}\\}`, 'g');
      result = result.replace(regex, value);
    }
    return result;
  } catch (error) {
    console.error(`加载模板失败: ${templatePath}`, error);
    return `<html><body><h1>加载模板失败: ${templatePath}</h1></body></html>`;
  }
}

/**
 * 加载HTML模板到窗口
 * @param {BrowserWindow} window - 目标窗口
 * @param {string} templatePath - 模板文件路径
 * @param {Object} variables - 模板变量
 */
async function loadHtmlToWindow(window, templatePath, variables) {
  const htmlContent = await loadTemplate(templatePath, variables);
  const dataUri = `data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`;
  await window.webContents.loadURL(dataUri);
}

// 延迟打开URL并重试的函数
async function loadUrlWithRetry(targetWindow, url, delaySeconds, retryInterval, maxRetries, isSelfService = false) {
  let currentRetry = 0;
  let remainingDelay = delaySeconds;

  // 确保窗口显示出来（用于立即打开的情况）
  if (!targetWindow.isVisible()) {
    targetWindow.show();
  }

  // 显示倒计时到控制台和UI
  if (delaySeconds > 0) {
    console.log(`将延迟 ${delaySeconds} 秒打开URL...`);

    // 加载倒计时页面
    await loadHtmlToWindow(targetWindow, 'assets/countdown.html', {
      DELAY_SECONDS: delaySeconds
    });

    const countdown = setInterval(() => {
      remainingDelay--;
      if (remainingDelay > 0) {
        console.log(`倒计时：${remainingDelay} 秒后打开地址`);
      } else {
        clearInterval(countdown);
      }
    }, 1000);

    // 等待延迟时间
    await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
  }

  // 尝试加载URL，带重试机制
  while (currentRetry < maxRetries) {
    try {
      console.log(`尝试加载URL (第 ${currentRetry + 1} 次)...`);
      await targetWindow.webContents.loadURL(url);
      if (isSelfService) {
        global.AUTO_OPEN_URL_SHOWN = true;
      }
      console.log('URL加载成功');
      return true;
    } catch (error) {
      currentRetry++;
      console.error(`URL加载失败 (第 ${currentRetry} 次):`, error.message);
      console.error(`重试配置: 间隔=${retryInterval}秒, 最大重试=${maxRetries}次, 当前已重试=${currentRetry - 1}次`);

      if (currentRetry >= maxRetries) {
        console.error(`URL加载失败，已达到最大重试次数 (${maxRetries})`);
        if (isSelfService) {
          // 自助报告打印失败后显示错误提示页面，不关闭窗口
          await loadHtmlToWindow(targetWindow, 'assets/self-service-error.html', {
            URL: url
          });
          return false;
        } else {
          // 重试失败后，加载默认页面并显示错误信息
          const indexHtml = path.join("file://", app.getAppPath(), "assets/index.html");
          await targetWindow.webContents.loadURL(indexHtml);
          return false;
        }
      }

      // 显示错误提示和重试页面
      await loadHtmlToWindow(targetWindow, 'assets/error.html', {
        URL: url,
        CURRENT_RETRY: currentRetry,
        REMAINING_RETRIES: maxRetries - currentRetry,
        RETRY_INTERVAL: retryInterval
      });

      // 等待重试间隔
      console.log(`等待 ${retryInterval} 秒后重试...`);
      await new Promise(resolve => setTimeout(resolve, retryInterval * 1000));
    }
  }
}

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

/**
 * 检查是否需要退出应用
 */
function checkAppExit() {
  if (!global.SELF_SERVICE_WINDOW && !global.PRINT_WINDOW && !global.SET_WINDOW && !global.RENDER_WINDOW && !global.PRINT_LOG_WINDOW) {
    console.log('==> 所有窗口已关闭，退出应用 <==');
    server.close();
  } else {
    console.log(`==> 仍有窗口运行 - 自助报告打印: ${!!global.SELF_SERVICE_WINDOW}, 打印: ${!!global.PRINT_WINDOW}, 设置: ${!!global.SET_WINDOW}, 渲染: ${!!global.RENDER_WINDOW}, 日志: ${!!global.PRINT_LOG_WINDOW} <==`);
  }
}

// 设置本机客户端ID（基于本机信息生成，符合 socket.id 格式）
(function generateLocalClientId() {
  const os = require('os');
  const networkInterfaces = os.networkInterfaces();
  let mac = '';

  // 获取第一个非内部网卡的 MAC 地址
  for (const [name, nets] of Object.entries(networkInterfaces)) {
    for (const net of nets) {
      if (net.mac && net.mac !== '00:00:00:00:00:00' && !net.internal) {
        mac = net.mac.replace(/:/g, '');
        break;
      }
    }
    if (mac) break;
  }

  // 生成符合 socket.id 格式的 clientId（25字符，固定算法）
  // socket.io 的 socket.id 格式通常是：20个字符的base62编码
  // 使用MAC地址 + 固定盐值 + 主机名确保在所有地方生成一致
  const crypto = require('crypto');
  const hostname = os.hostname() || 'default';
  const input = `${mac || 'default'}|${hostname}|fixed-salt-v1`;
  const hash = crypto.createHash('sha256').update(input).digest('base64');
  // 取前25个字符作为clientId
  const clientId = hash.substring(0, 25);

  // 设置到 global 对象
  global.LOCAL_CLIENT_ID = clientId;
})();

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

  // 接收设置窗口发来的本机 clientId
  ipcMain.on("setLocalClientId", (event, data) => {
    if (data && data.clientId) {
      global.LOCAL_CLIENT_ID = data.clientId;
    }
  });

  // 请求本机 clientId
  ipcMain.on("getLocalClientId", (event) => {
    event.sender.send("localClientId", global.LOCAL_CLIENT_ID || null);
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
    resizable: false, // 主窗口不允许缩放和全屏
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

  // 加载主页面（始终加载启动页）
  const indexHtml = path.join("file://", app.getAppPath(), "assets/index.html");
  MAIN_WINDOW.webContents.loadURL(indexHtml);

  // 检查是否需要启动时打开自助报告打印页面（独立窗口）
  if (store.get("autoOpenUrl") && store.get("autoOpenUrlValue")) {
    // 创建独立的自助报告打印窗口（异步）
    setTimeout(() => createSelfServiceWindow(), 100);
  }

  // 退出
  MAIN_WINDOW.on("closed", () => {
    MAIN_WINDOW = null;
    console.log('==> 主窗口已关闭 <==');
    // 检查是否需要退出应用（只有当没有其他窗口时）
    checkAppExit();
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
      }
    } catch (err) {
      console.error("主窗口显示失败:", err);
    }
  });

  // 主窗口导航事件
  MAIN_WINDOW.webContents.on("will-navigate", (event, navigationUrl) => {
    // 主窗口不允许导航到外部URL
    if (navigationUrl !== `file://${path.join(app.getAppPath(), "assets/index.html")}`) {
      event.preventDefault();
    }
  });

  // 主窗口 Dom 加载完毕
  MAIN_WINDOW.webContents.on("dom-ready", async () => {
    try {
      console.log('主窗口 DOM 已加载完成');

      // 获取本机 clientId
      if (!global.LOCAL_CLIENT_ID) {
        try {
          const result = await MAIN_WINDOW.webContents.executeJavaScript('window.localClientId || null');
          if (result) {
            global.LOCAL_CLIENT_ID = result;
          }
        } catch (err) {
          console.error('获取本机 clientId 失败:', err);
        }
      }

      // 如果中转服务已连接，通知渲染进程
      if (global.SOCKET_CLIENT && global.SOCKET_CLIENT.connected) {
        console.log('中转服务已连接，通知渲染进程');
        MAIN_WINDOW.webContents.send("clientConnection", true);
      }

      // 移除 loading view 并显示主窗口（仅当未配置自助报告打印时）
      if (!store.get("autoOpenUrl") || !store.get("autoOpenUrlValue")) {
        if (!store.get("openAsHidden")) {
          MAIN_WINDOW.show();
        }
        // 移除 loading view
        if (global.LOADING_BROWSER_VIEW) {
          global.LOADING_BROWSER_VIEW.webContents.destroy();
          MAIN_WINDOW.removeBrowserView(global.LOADING_BROWSER_VIEW);
          global.LOADING_BROWSER_VIEW = null;
        }
      }

      // 未打包时打开开发者工具
      if (!app.isPackaged) {
        MAIN_WINDOW.webContents.openDevTools();
      }
    } catch (error) {
      console.error("主窗口 Dom 加载失败!", error);
    }
  });

  // 初始化服务器（只在第一次窗口创建时执行）
  if (!global.SERVER_INITIALIZED) {
    try {
      console.log("初始化服务器...");
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
      global.SERVER_INITIALIZED = true;
      console.log("服务器初始化完成");
    } catch (error) {
      console.error("服务器初始化失败:", error);
    }
  }

  // 初始化托盘
  initTray();

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

  // 移除 loading view（如果存在）
  if (global.LOADING_BROWSER_VIEW) {
    global.LOADING_BROWSER_VIEW.webContents.destroy();
    MAIN_WINDOW.removeBrowserView(global.LOADING_BROWSER_VIEW);
    global.LOADING_BROWSER_VIEW = null;
  }
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
 * @description: 创建独立的自助报告打印窗口
 * @return {BrowserWindow} SELF_SERVICE_WINDOW 自助报告打印窗口
 */
async function createSelfServiceWindow() {
  const url = store.get("autoOpenUrlValue");
  let delaySeconds = store.get("autoOpenUrlDelay");
  let retryInterval = store.get("autoOpenUrlRetryInterval");
  let maxRetries = store.get("autoOpenUrlMaxRetries");

  // 确保配置值合理
  // 延迟时间：0-300秒
  if (typeof delaySeconds !== 'number' || delaySeconds < 0 || delaySeconds > 300) {
    delaySeconds = 0;
  }
  // 重试间隔：至少5秒（但默认应该是10秒）
  if (typeof retryInterval !== 'number' || retryInterval < 5 || retryInterval > 60) {
    retryInterval = 10;
  }
  // 最大重试次数：至少6次
  if (typeof maxRetries !== 'number' || maxRetries < 6 || maxRetries > 20) {
    maxRetries = 6;
  }

  const windowOptions = {
    width: 1200,
    height: 800,
    title: '自助报告打印',
    useContentSize: true,
    center: true,
    resizable: true,
    show: false,
    fullscreenable: true,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
    },
  };

  // 创建独立窗口
  SELF_SERVICE_WINDOW = new BrowserWindow(windowOptions);

  // 立即注册全局快捷键（在窗口内容加载前就注册，确保倒计时阶段就能响应）
  console.log("==> 提前注册全局快捷键（自助报告打印模式）<==");

  // 先注销之前的快捷键（如果存在）
  if (globalShortcut.isRegistered("Escape")) {
    globalShortcut.unregister("Escape");
  }
  if (globalShortcut.isRegistered("F11")) {
    globalShortcut.unregister("F11");
  }

  globalShortcut.register("Escape", () => {
    try {
      if (SELF_SERVICE_WINDOW && SELF_SERVICE_WINDOW.isFullScreen()) {
        SELF_SERVICE_WINDOW.setFullScreen(false);
      }
    } catch (err) {
      console.error("全局 ESC 键退出全屏失败:", err);
    }
  });

  globalShortcut.register("F11", () => {
    try {
      if (SELF_SERVICE_WINDOW) {
        const isFullScreen = SELF_SERVICE_WINDOW.isFullScreen();

        if (isFullScreen) {
          SELF_SERVICE_WINDOW.setFullScreen(false);
        } else {
          SELF_SERVICE_WINDOW.setFullScreen(true);
        }
      }
    } catch (err) {
      console.error("全局 F11 键切换全屏失败:", err);
    }
  });

  // 设置窗口事件
  SELF_SERVICE_WINDOW.on('closed', () => {
    console.log('==> 自助报告打印窗口已关闭 <==');
    // 注销全局快捷键
    globalShortcut.unregister("Escape");
    globalShortcut.unregister("F11");
    SELF_SERVICE_WINDOW = null;
    // 检查是否需要退出应用
    checkAppExit();
  });

  // 页面加载完成后的处理
  SELF_SERVICE_WINDOW.webContents.on("did-finish-load", async () => {
    // 如果不是倒计时或错误页面，则进入全屏
    const currentURL = SELF_SERVICE_WINDOW.webContents.getURL();
    if (!currentURL.includes('countdown.html') && !currentURL.includes('error.html') && !currentURL.includes('self-service-error.html')) {
      SELF_SERVICE_WINDOW.setFullScreen(true);
    }
  });

  // 页面导航完成后重新注入键盘监听器
  SELF_SERVICE_WINDOW.webContents.on("did-navigate", () => {
    console.log('自助报告打印窗口导航完成，重新注入键盘监听器');
    setTimeout(() => injectKeyboardListenerToSelfService(), 500);
  });

  // DOM内容加载完成后也注入键盘监听器
  SELF_SERVICE_WINDOW.webContents.on("dom-content-loaded", () => {
    console.log('DOM内容加载完成，注入键盘监听器');
    setTimeout(() => injectKeyboardListenerToSelfService(), 300);
  });

  // 页面内容更新时也重新注入监听器（SPA应用）
  SELF_SERVICE_WINDOW.webContents.on("did-start-loading", () => {
    console.log('页面开始重新加载，清理监听器标记');
    SELF_SERVICE_WINDOW.webContents.executeJavaScript(`
      window.__HIPRINT_KEYBOARD_LISTENER_ADDED__ = false;
    `).catch(() => {});
  });

  // 页面内容变化时也重新注入监听器
  SELF_SERVICE_WINDOW.webContents.on("will-navigate", (event, navigationUrl) => {
    console.log('页面导航事件:', navigationUrl);
    // 对于 data: 协议的倒计时页面，也尝试注入监听器
    if (navigationUrl.startsWith('data:')) {
      setTimeout(() => injectKeyboardListenerToSelfService(), 100);
    }
  });

  // 立即注入一次键盘监听器
  setTimeout(() => injectKeyboardListenerToSelfService(), 500);

  // 使用延迟打开和重试机制
  await loadUrlWithRetry(SELF_SERVICE_WINDOW, url, delaySeconds, retryInterval, maxRetries, true);

  return SELF_SERVICE_WINDOW;
}

/**
 * 为自助报告打印窗口注入键盘监听器
 */
function injectKeyboardListenerToSelfService() {
  if (!SELF_SERVICE_WINDOW) return;

  // 检查键盘监听器是否已经添加
  SELF_SERVICE_WINDOW.webContents.executeJavaScript(`
    window.__HIPRINT_KEYBOARD_LISTENER_ADDED__ || false
  `).then((alreadyAdded) => {
    if (alreadyAdded) {
      console.log('键盘监听器已存在，跳过重复注入');
      return;
    }

    // 注入键盘监听器
    SELF_SERVICE_WINDOW.webContents.executeJavaScript(`
      (function() {
        console.log('为自助报告打印窗口添加键盘监听器');

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
            if (window.require) {
              try {
                const ipcRenderer = window.require('electron').ipcRenderer;
                const currentWindow = window.require('electron').remote.getCurrentWindow();
                const isFullScreen = currentWindow.isFullScreen();
                
                if (isFullScreen) {
                  ipcRenderer.send('exit-fullscreen');
                } else {
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
        console.log('自助报告打印窗口键盘监听器添加完成');
      })();
    `).catch(err => console.error('注入键盘监听器失败:', err));
  }).catch(err => {
    console.error('检查键盘监听器状态失败:', err);
    // 如果检查失败，仍然尝试注入
    return injectKeyboardListenerToSelfService();
  });
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
