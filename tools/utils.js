const os = require("os");
const { app, Notification, dialog, clipboard, shell } = require("electron");
const address = require("address");
const ipp = require("ipp");
const { machineIdSync } = require("node-machine-id");
const Store = require("electron-store");
const { getPaperSizeInfo, getPaperSizeInfoAll } = require("win32-pdf-printer");
const { v7: uuidv7 } = require("uuid");
const fs = require("fs");
let buildInfo = {};
const buildInfoPath = require("path").join(__dirname, "../build-info.json");
if (fs.existsSync(buildInfoPath)) {
  buildInfo = require(buildInfoPath);
}

/**
 * @description: 安全调用 getPaperSizeInfoAll, 添加错误处理和路径修复
 * 由于 win32-pdf-printer 包在处理包含空格的路径时存在问题，添加包装函数
 */
function safeGetPaperSizeInfoAll() {
  try {
    return getPaperSizeInfoAll();
  } catch (error) {
    console.error("safeGetPaperSizeInfoAll 调用失败:", error.message);
    return [];
  }
}

/**
 * @description: 安全调用 getPaperSizeInfo, 添加错误处理
 */
function safeGetPaperSizeInfo(printer) {
  try {
    return getPaperSizeInfo({ printer });
  } catch (error) {
    console.error("safeGetPaperSizeInfo 调用失败:", error.message);
    return [];
  }
}

Store.initRenderer();

const DEFAULT_SELF_SERVICE_PRINT_URL = "http://192.168.1.160/selfServicePrint?hospCode=H01";

const schema = {
  mainTitle: {
    type: "string",
    default: "Electron-hiprint",
  },
  nickName: {
    type: "string",
    default: "",
  },
  openAtLogin: {
    type: "boolean",
    default: true,
  },
  openAsHidden: {
    type: "boolean",
    default: true,
  },
  connectTransit: {
    type: "boolean",
    default: false,
  },
  transitUrl: {
    type: "string",
    default: "",
  },
  transitToken: {
    type: "string",
    default: "",
  },
  allowNotify: {
    type: "boolean",
    default: true,
  },
  closeType: {
    type: "string",
    enum: ["tray", "quit"],
    default: "tray",
  },
  port: {
    type: "number",
    minimum: 10000,
    default: 17521,
  },
  token: {
    type: "string",
    default: "",
  },
  pluginVersion: {
    type: "string",
    default: "0.0.60",
  },
  logPath: {
    type: "string",
    default: app.getPath("logs"),
  },
  pdfPath: {
    type: "string",
    default: app.getPath("temp"),
  },
  defaultPrinter: {
    type: "string",
    default: "",
  },
  disabledGpu: {
    type: "boolean",
    default: false,
  },
  rePrint: {
    type: "boolean",
    default: true,
  },
  autoOpenUrl: {
    type: "boolean",
    default: false,
  },
  autoOpenUrlValue: {
    type: "string",
    default: DEFAULT_SELF_SERVICE_PRINT_URL,
  },
  // 自助报告打印延迟时间（秒），0表示不延迟
  autoOpenUrlDelay: {
    type: "number",
    default: 0,
  },
  // 重试间隔（秒）
  autoOpenUrlRetryInterval: {
    type: "number",
    default: 10,
  },
  // 最大重试次数
  autoOpenUrlMaxRetries: {
    type: "number",
    default: 6,
  },
};

const store = new Store({ schema });

/**
 * @description: 获取当前系统 IP 地址
 * @return {String}
 */
function addressIp() {
  return address.ip();
}

/**
 * @description: 获取当前系统 IPV6 地址
 * @return {String}
 */
function addressIpv6() {
  return address.ipv6();
}

/**
 * @description: 获取当前系统 MAC 地址
 * @return {String}
 */
function addressMac() {
  return new Promise((resolve) => {
    address.mac(function(err, addr) {
      if (err) {
        resolve(err);
      } else {
        resolve(addr);
      }
    });
  });
}

/**
 * @description: 获取当前系统 IP、IPV6、MAC 地址
 * @return {Object}
 */
function addressAll() {
  return new Promise((resolve) => {
    address.mac(function(err, mac) {
      if (err) {
        resolve({ ip: address.ip(), ipv6: address.ipv6(), mac: err });
      } else {
        resolve({ ip: address.ip(), ipv6: address.ipv6(), mac });
      }
    });
  });
}

/**
 * @description: address 方法重写
 * @return {Object}
 */
const _address = {
  ip: addressIp,
  ipv6: addressIpv6,
  mac: addressMac,
  all: addressAll,
};

/**
 * @description: 检查分片任务实例，用于自动删除超时分片信息
 */
const watchTaskInstance = generateWatchTask(
  () => global.PRINT_FRAGMENTS_MAPPING,
)();

/**
 * @description: 尝试获取客户端唯一id，依赖管理员权限与注册表读取
 * @return {string}
 */
function getMachineId() {
  try {
    return machineIdSync({ original: true });
  } catch (error) {
    // 若获取失败，也可以使用 UUID 代替，需要单独存储 首次创建 后续读取
    // 默认返回空 表示读不到就好
    return "";
  }
}

/**
 * @description: 从缓存查询打印机信息
 * @param {string} printerName - 打印机名称或显示名称
 * @return {Object|null} - 缓存中的打印机信息，包含 clientId 和 originalName
 */
function queryPrinterCache(printerName) {
  try {
    // 如果没有缓存，返回null
    if (!global.TRANSIT_PRINTERS_CACHE) {
      return null;
    }

    // 如果直接匹配显示名称，返回结果
    if (global.TRANSIT_PRINTERS_CACHE[printerName]) {
      return global.TRANSIT_PRINTERS_CACHE[printerName];
    }

    // 如果是 clientId 格式，遍历查找匹配项
    const looksLikeClientId = printerName && printerName.length >= 15;
    if (looksLikeClientId) {
      for (const [displayName, info] of Object.entries(global.TRANSIT_PRINTERS_CACHE)) {
        if (info.clientId === printerName) {
          return info;
        }
      }
    }

    // 如果没有直接匹配，尝试去掉IP前缀匹配
    let cleanName = printerName;
    if (printerName && printerName.includes('] ')) {
      cleanName = printerName.substring(printerName.indexOf('] ') + 2);
    }

    // 遍历查找匹配项
    for (const [displayName, info] of Object.entries(global.TRANSIT_PRINTERS_CACHE)) {
      // 匹配原始名称
      if (info.originalName === cleanName) {
        return info;
      }
      // 匹配去掉IP前缀的显示名称
      const cleanDisplayName = displayName.includes('] ') ? displayName.substring(displayName.indexOf('] ') + 2) : displayName;
      if (cleanDisplayName === cleanName) {
        return info;
      }
    }

    return null;
  } catch (error) {
    console.error('查询缓存失败:', error);
    return null;
  }
}

/**
 * @description: 检查一个打印机是否是本机的打印机
 * @param {string} printerName - 打印机名称或显示名称
 * @return {boolean} - 如果是本机打印机返回true，否则返回false
 */
function isLocalPrinter(printerName) {
  try {
    // 如果没有本机clientId，说明还没有初始化，无法判断
    if (!global.LOCAL_CLIENT_ID) {
      return false;
    }

    // 如果没有缓存，无法判断，需要依赖其他逻辑
    if (!global.TRANSIT_PRINTERS_CACHE || Object.keys(global.TRANSIT_PRINTERS_CACHE).length === 0) {
      return false;
    }

    // 如果printerName看起来像clientId，检查是否为本机clientId
    const looksLikeClientId = printerName && printerName.length >= 15;
    if (looksLikeClientId) {
      if (printerName === global.LOCAL_CLIENT_ID) {
        return true;
      }
    }

    // 检查缓存中是否有这个打印机的信息
    if (global.TRANSIT_PRINTERS_CACHE[printerName]) {
      const info = global.TRANSIT_PRINTERS_CACHE[printerName];
      if (info.clientId === global.LOCAL_CLIENT_ID) {
        return true;
      }
    }

    // 如果printerName包含IP前缀，尝试匹配
    if (printerName && printerName.includes('] ')) {
      const cleanName = printerName.substring(printerName.indexOf('] ') + 2);
      // 遍历查找匹配项
      for (const [displayName, info] of Object.entries(global.TRANSIT_PRINTERS_CACHE)) {
        if (info.clientId === global.LOCAL_CLIENT_ID) {
          // 本机clientId匹配，进一步检查打印机名称
          const displayCleanName = displayName.includes('] ') ? displayName.substring(displayName.indexOf('] ') + 2) : displayName;
          if (displayCleanName === cleanName || info.originalName === cleanName) {
            return true;
          }
        }
      }
    }

    return false;
  } catch (error) {
    console.error('检查本机打印机失败:', error);
    return false;
  }
}

/**
 * @description: 抛出当前客户端信息，提供更多有价值的信息，逐步替换原有 address
 * @param {io.Socket} socket - socket连接
 * @param {string} customClientId - 可选的自定义clientId，默认使用socket.id
 * @return {void}
 */
function emitClientInfo(socket, customClientId) {
  _address.mac().then((mac) => {
    socket.emit("clientInfo", {
      hostname: os.hostname(), // 主机名
      version: app.getVersion(), // 版本号
      platform: process.platform, // 平台
      arch: process.arch, // 系统架构
      mac: mac, // mac 地址
      ip: _address.ip(), // ip 地址
      ipv6: _address.ipv6(), // ipv6 地址
      clientUrl: `http://${_address.ip()}:${store.get("port") || 17521}`, // 客户端地址
      machineId: getMachineId(), // 客户端唯一id
      nickName: store.get("nickName"), // 客户端昵称
      clientId: customClientId || socket.id, // 客户端socket id，用于中转服务转发
    });
  });
}

/**
 * 生成检查分片任务的闭包函数
 * @param {Object} getCheckTarget 获取校验对象，最后会得到global.PRINT_FRAGMENTS_MAPPING
 * @returns {Function}
 */
function generateWatchTask(getCheckTarget) {
  // 记录当前检查任务是否开启，避免重复开启任务
  let isWatching = false;
  /**
   * @description: 检查分片任务实例创建函数
   * @param {Object} config 检查参数，根据实际情况调整
   * @param {number} [config.checkInterval=5] 执行内存检查的时间间隔，单位分钟
   * @param {number} [config.expire=10] 分片信息过期时间，单位分钟，不应过小
   */
  return function generateWatchTaskInstance(config = {}) {
    // 合并用户和默认配置
    const realConfig = Object.assign(
      {
        checkInterval: 5, // 默认检查间隔
        expire: 10, // 默认过期时间
      },
      config,
    );
    return {
      startWatch() {
        if (isWatching) return;
        this.createWatchTimeout();
      },
      createWatchTimeout() {
        // 更新开关状态
        isWatching = true;
        return setTimeout(
          this.clearFragmentsWhichIsExpired.bind(this),
          realConfig.checkInterval * 60 * 1000,
        );
      },
      clearFragmentsWhichIsExpired() {
        const checkTarget = getCheckTarget();
        const currentTimeStamp = Date.now();
        Object.entries(checkTarget).map(([id, fragmentInfo]) => {
          // 获取任务最后更新时间
          const { updateTime } = fragmentInfo;
          // 任务过期时，清除任务信息释放内存
          if (currentTimeStamp - updateTime > realConfig.expire * 60 * 1000) {
            delete checkTarget[id];
          }
        });
        // 获取剩余任务数量
        const printTaskCount = Object.keys(checkTarget).length;
        // 还有打印任务，继续创建检查任务
        if (printTaskCount) this.createWatchTimeout();
        // 更新开关状态
        else isWatching = false;
      },
    };
  };
}

/**
 * @description: 作为本地服务端时绑定的 socket 事件
 * @param {*} server
 * @return {void}
 */
function initServeEvent(server) {
  // 必须传入实体
  if (!server) return false;

  /**
   * @description: 校验 token 并设置 clientId
   */
  server.use((socket, next) => {
    const token = store.get("token");
    if (token && token !== socket.handshake.auth.token) {
      console.log(
        `==> 插件端 Authentication error: ${socket.id}, token: ${socket.handshake.auth.token}`,
      );
      const err = new Error("Authentication error");
      err.data = {
        content: "Token 错误",
      };
      next(err);
    } else {
      // 设置 clientId 为 socket.id
      socket.clientId = socket.id;
      next();
    }
  });

  /**
   * @description: 新的 web client 连入，绑定 socket 事件
   */
  server.on("connect", async (socket) => {
    console.log(`==> 插件端 New Connected: ${socket.id}`);

    // 通知渲染进程已连接
    MAIN_WINDOW.webContents.send(
      "serverConnection",
      server.engine.clientsCount,
    );

    // 判断是否允许通知
    if (store.get("allowNotify")) {
      // 弹出连接成功通知
      const notification = new Notification({
        title: "新的连接",
        body: `已建立新的连接，当前连接数：${server.engine.clientsCount}`,
      });
      // 显示通知
      notification.show();
    }

    // 设置本机 clientId（使用第一个连接的客户端ID）
    // 但不要覆盖已经连接中转服务时设置的 SERVER socket.id

    // 只有当 LOCAL_CLIENT_ID 是初始的 "local-*" 值时，才更新为 SERVER 的 socket.id
    // 如果已经是非"local-"格式的值（说明已经生成过socket.id格式的），则保持不变
    const isInitialClientId = global.LOCAL_CLIENT_ID && global.LOCAL_CLIENT_ID.startsWith('local-');
    if (isInitialClientId) {
      global.LOCAL_CLIENT_ID = socket.id;
    }

    // 同步到渲染进程（使用本机 clientId，不是 socket.id）
    if (MAIN_WINDOW && MAIN_WINDOW.webContents) {
      MAIN_WINDOW.webContents.executeJavaScript(`
        window.localClientId = '${global.LOCAL_CLIENT_ID}';
        console.log('同步本机 clientId 到渲染进程: ${global.LOCAL_CLIENT_ID}');
      `).catch((err) => {
        console.error('同步到渲染进程失败:', err);
      });
    }

    // 如果设置窗口已打开，也同步到设置窗口
    if (SET_WINDOW && SET_WINDOW.webContents) {
      SET_WINDOW.webContents.executeJavaScript(`
        window.localClientId = '${global.LOCAL_CLIENT_ID}';
        console.log('同步本机 clientId 到设置窗口: ${global.LOCAL_CLIENT_ID}');
      `).catch((err) => {
        console.error('同步到设置窗口失败:', err);
      });
    }

    // 向 client 发送打印机列表
    socket.emit(
      "printerList",
      await MAIN_WINDOW.webContents.getPrintersAsync(),
    );

    // 向 client 发送客户端信息
    emitClientInfo(socket);

    /**
     * @description: client 请求客户端信息
     */
    socket.on("getClientInfo", () => {
      console.log(`插件端 ${socket.id}: getClientInfo`);
      emitClientInfo(socket);
    });

    /**
     * @description: client请求 address ，获取本机 IP、IPV6、MAC 地址
     * @description: addressType 为 null 时，返回所有地址
     * @description: 逐步废弃该 api
     * @param {String} addressType ip、ipv6、mac、all === null
     */
    socket.on("address", (addressType) => {
      console.log(
        `插件端 ${socket.id}: get address(${addressType || "未指定类型"})`,
      );
      switch (addressType) {
        case "ip":
        case "ipv6":
          socket.emit("address", addressType, _address[addressType]());
          break;
        case "dns":
        case "interface":
        case "vboxnet":
          // 用处不大的几个信息，直接废弃
          socket.emit("address", addressType, null, "This type is removed.");
          break;
        default:
          addressType = addressType === "mac" ? "mac" : "all";
          _address[addressType]().then((res) => {
            socket.emit("address", addressType, res);
          });
          break;
      }
    });

    /**
     * @description: client 请求刷新打印机列表
     */
    socket.on("refreshPrinterList", async () => {
      // 本机作为 SERVER，需要汇总所有连接的 CLIENT 的打印机列表
      // 包括：
      // 1. 直接连接本机 SERVER 的 web 应用（但它们没有打印机）
      // 2. 本机作为 CLIENT 连接的上级中央中转服务（如果有）

      const allPrinters = [];
      let processedCount = 0;
      const totalClients = 1 + (global.SOCKET_CLIENT?.connected ? 1 : 0); // 本机 + 上级中转服务

      // 1. 添加本机打印机
      try {
        const localPrinters = await MAIN_WINDOW.webContents.getPrintersAsync();
        
        localPrinters.forEach(printer => {
          allPrinters.push({
            ...printer,
            server: {
              clientId: global.LOCAL_CLIENT_ID,
              hostname: os.hostname(),
              version: app.getVersion(),
              platform: process.platform,
              arch: process.arch,
              mac: 'N/A',
              ip: _address.ip(),
              ipv6: _address.ipv6(),
              clientUrl: `http://${_address.ip()}:${store.get("port") || 17521}`,
              machineId: getMachineId(),
              nickName: store.get("nickName"),
            }
          });
        });
        processedCount++;
      } catch (error) {
        console.error('获取本机打印机列表失败:', error);
        processedCount++;
      }

      // 2. 如果连接了上级中央中转服务，请求汇总的打印机列表
      if (global.SOCKET_CLIENT && global.SOCKET_CLIENT.connected) {
        // 使用 replyId 机制确保收到响应
        const replyId = `rid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const timeout = setTimeout(() => {
          completeAndReturn();
        }, 5000);

        const originalHandler = (printers) => {
          clearTimeout(timeout);
          global.SOCKET_CLIENT.removeListener(`printerList-${replyId}`, originalHandler);

          if (printers && Array.isArray(printers)) {
            printers.forEach(printer => {
              allPrinters.push(printer);
            });
          }

          processedCount++;
          completeAndReturn();
        };

        global.SOCKET_CLIENT.on(`printerList-${replyId}`, originalHandler);
        global.SOCKET_CLIENT.emit("refreshPrinterList", { replyId });

        function completeAndReturn() {
          socket.emit("printerList", allPrinters);
        }
      } else {
        // 没有连接上级中转服务，直接返回本机打印机
        socket.emit("printerList", allPrinters);
      }
    });

    /**
     * @description: client 获取打印机纸张信息
     */
    socket.on("getPaperSizeInfo", (printer) => {
      console.log(`插件端 ${socket.id}: getPaperSizeInfo`);
      if (process.platform === "win32") {
        try {
          let paper = printer ? safeGetPaperSizeInfo(printer) : safeGetPaperSizeInfoAll();
          paper && socket.emit("paperSizeInfo", paper);
        } catch (error) {
          console.error("获取打印机纸张信息失败:", error.message);
          socket.emit("error", {
            msg: "获取打印机纸张信息失败",
          });
        }
      }
    });

    /**
     * @description: client 调用 ipp 打印 详见：https://www.npmjs.com/package/ipp
     */
    socket.on("ippPrint", (options) => {
      console.log(`插件端 ${socket.id}: ippPrint`);
      try {
        const { url, opt, action, message } = options;
        let printer = ipp.Printer(url, opt);
        socket.emit("ippPrinterConnected", printer);
        let msg = Object.assign(
          {
            "operation-attributes-tag": {
              "requesting-user-name": "hiPrint",
            },
          },
          message,
        );
        // data 必须是 Buffer 类型
        if (msg.data && !Buffer.isBuffer(msg.data)) {
          if ("string" === typeof msg.data) {
            msg.data = Buffer.from(msg.data, msg.encoding || "utf8");
          } else {
            msg.data = Buffer.from(msg.data);
          }
        }
        /**
         * action: Get-Printer-Attributes 获取打印机支持参数
         * action: Print-Job 新建打印任务
         * action: Cancel-Job 取消打印任务
         */
        printer.execute(action, msg, (err, res) => {
          socket.emit(
            "ippPrinterCallback",
            err ? { type: err.name, msg: err.message } : null,
            res,
          );
        });
      } catch (error) {
        console.log(`插件端 ${socket.id}: ippPrint error: ${error.message}`);
        socket.emit("ippPrinterCallback", {
          type: error.name,
          msg: error.message,
        });
      }
    });

    /**
     * @description: client ipp request 详见：https://www.npmjs.com/package/ipp
     */
    socket.on("ippRequest", (options) => {
      console.log(`插件端 ${socket.id}: ippRequest`);
      try {
        const { url, data } = options;
        let _data = ipp.serialize(data);
        ipp.request(url, _data, (err, res) => {
          socket.emit(
            "ippRequestCallback",
            err ? { type: err.name, msg: err.message } : null,
            res,
          );
        });
      } catch (error) {
        console.log(`插件端 ${socket.id}: ippRequest error: ${error.message}`);
        socket.emit("ippRequestCallback", {
          type: error.name,
          msg: error.message,
        });
      }
    });

    /**
     * @description: client 常规打印任务
     */
    socket.on("news", (data) => {
      if (data) {
        // 检查是否指定了目标客户端 (printer 参数可能是 clientId)
        const targetClientId = data.printer;
        const looksLikeClientId = targetClientId && targetClientId.length >= 15;
        const isLocalClientId = looksLikeClientId && targetClientId === global.LOCAL_CLIENT_ID;

        // 如果是本机的客户端ID，在本机执行打印
        if (isLocalClientId) {
          // 使用本机实际打印机名称，而不是 clientId
          // 去掉前缀 [IP地址] 获取纯打印机名称
          let localPrinter = store.get("defaultPrinter") || "";
          if (localPrinter && localPrinter.includes('] ')) {
            localPrinter = localPrinter.substring(localPrinter.indexOf('] ') + 2);
          }
          PRINT_RUNNER.add((done) => {
            data.socketId = socket.id;
            data.taskId = uuidv7();
            data.clientType = "local";
            // 不修改 data.printer，保持原始的 clientId 用于结果反馈
            // 但传递 localPrinter 给打印窗口
            const printData = { ...data, printer: localPrinter };
            PRINT_WINDOW.webContents.send("print-new", printData);
            MAIN_WINDOW.webContents.send("printTask", true);
            PRINT_RUNNER_DONE[data.taskId] = done;
          });
        } else if (targetClientId && targetClientId !== socket.id && looksLikeClientId) {
          // 检查是否是远程客户端ID，如果是远程但未连接中转服务，给出提示
          const cacheResult = queryPrinterCache(data.printer);
          if (cacheResult && (!global.SOCKET_CLIENT || !global.SOCKET_CLIENT.connected)) {
            // 这是远程打印机，但未连接中转服务
            console.log(`客户端 ${targetClientId} 不在线，且未连接中央中转服务，打印机：${data.printer}`);
            socket.emit("error", {
              msg: `您选择的是远程打印机（${data.printer}），但未连接中转服务。请选择不带IP前缀的本机打印机进行打印。`,
              templateId: data.templateId,
              replyId: data.replyId,
            });
            return;
          }
          // 如果指定了其他客户端ID，则转发给目标客户端

          const targetSocket = SOCKET_SERVER.sockets.sockets.get(targetClientId);

          if (targetSocket) {
            targetSocket.emit("news", data);
          } else {
            // 如果连接了中央中转服务，转发给中央中转服务
            if (global.SOCKET_CLIENT && global.SOCKET_CLIENT.connected) {

              // 提取实际的打印机名称（去掉IP前缀）
              let actualPrinterName = data.printer;
              if (actualPrinterName && actualPrinterName.includes('] ')) {
                actualPrinterName = actualPrinterName.substring(actualPrinterName.indexOf('] ') + 2);
              }

              // 确定目标客户端ID
              // 如果targetClientId看起来像clientId，直接使用
              // 否则从缓存查询
              const looksLikeClientId = targetClientId && targetClientId.length >= 15;

              if (!looksLikeClientId) {
                // printer可能是显示名称，需要从缓存查询clientId
                const cacheResult = queryPrinterCache(data.printer);
                if (cacheResult) {
                  targetClientId = cacheResult.clientId;
                  actualPrinterName = cacheResult.originalName || actualPrinterName;
                } else {
                  targetClientId = data.printer; // 回退到原始值
                }
              }

              // 将printer参数映射为client参数，供中转服务识别
              // 中转服务期望"client"字段来识别目标客户端，而不是"printer"
              const forwardData = {
                ...data,
                client: targetClientId,  // 使用clientId而不是printer名称
                printer: actualPrinterName  // 传递实际的打印机名称（去掉IP前缀）
              };

              global.SOCKET_CLIENT.emit("news", forwardData);
            } else {
              socket.emit("error", {
                msg: `客户端 ${targetClientId} 不在线，且未连接中央中转服务`,
                templateId: data.templateId,
                replyId: data.replyId,
              });
            }
          }
        } else {
          // 没有指定目标客户端或就是自己，在本地执行打印
          PRINT_RUNNER.add((done) => {
            data.socketId = socket.id;
            data.taskId = uuidv7();
            data.clientType = "local";
            PRINT_WINDOW.webContents.send("print-new", data);
            MAIN_WINDOW.webContents.send("printTask", true);
            PRINT_RUNNER_DONE[data.taskId] = done;
          });
        }
      }
    });

    /**
     * @description: client 分批打印任务
     */
    socket.on("printByFragments", (data) => {
      if (data) {
        const { total, index, htmlFragment, id } = data;
        const currentInfo =
          PRINT_FRAGMENTS_MAPPING[id] ||
          (PRINT_FRAGMENTS_MAPPING[id] = {
            total,
            fragments: [],
            count: 0,
            updateTime: 0,
          });
        // 添加片段信息
        currentInfo.fragments[index] = htmlFragment;
        // 计数
        currentInfo.count++;
        // 记录更新时间
        currentInfo.updateTime = Date.now();
        // 全部片段已传输完毕
        if (currentInfo.count === currentInfo.total) {
          // 清除全局缓存
          delete PRINT_FRAGMENTS_MAPPING[id];
          // 合并全部打印片段信息
          data.html = currentInfo.fragments.join("");
          // 添加打印任务
          PRINT_RUNNER.add((done) => {
            data.socketId = socket.id;
            data.taskId = uuidv7();
            data.clientType = "local";
            PRINT_WINDOW.webContents.send("print-new", data);
            MAIN_WINDOW.webContents.send("printTask", true);
            PRINT_RUNNER_DONE[data.taskId] = done;
          });
        }
        // 开始检查任务
        watchTaskInstance.startWatch();
      }
    });

    socket.on("render-print", (data) => {
      if (data) {
        RENDER_RUNNER.add((done) => {
          data.socketId = socket.id;
          data.taskId = uuidv7();
          data.clientType = "local";
          RENDER_WINDOW.webContents.send("print", data);
          RENDER_RUNNER_DONE[data.taskId] = done;
        });
      }
    });

    socket.on("render-jpeg", (data) => {
      if (data) {
        RENDER_RUNNER.add((done) => {
          data.socketId = socket.id;
          data.taskId = uuidv7();
          data.clientType = "local";
          RENDER_WINDOW.webContents.send("png", data);
          RENDER_RUNNER_DONE[data.taskId] = done;
        });
      }
    });

    socket.on("render-pdf", (data) => {
      if (data) {
        RENDER_RUNNER.add((done) => {
          data.socketId = socket.id;
          data.taskId = uuidv7();
          data.clientType = "local";
          RENDER_WINDOW.webContents.send("pdf", data);
          RENDER_RUNNER_DONE[data.taskId] = done;
        });
      }
    });

    /**
     * @description: client 断开连接
     */
    socket.on("disconnect", () => {
      console.log(`==> 插件端 Disconnect: ${socket.id}`);
      MAIN_WINDOW?.webContents?.send(
        "serverConnection",
        server.engine.clientsCount,
      );
    });
  });
}

/**
 * @description: 作为客户端连接中转服务时绑定的 socket 事件
 * @return {void}
 */
function initClientEvent() {
  // 作为客户端连接中转服务时只有一个全局 client
  var client = global.SOCKET_CLIENT;

  /**
   * @description: 连接中转服务成功，绑定 socket 事件
   */
  client.on("connect", async () => {
    console.log(`==> 中转服务 Connect: ${client.id}`);

    // 立即发送连接状态（dom-ready 事件也会检查并发送，确保状态同步）
    if (MAIN_WINDOW && MAIN_WINDOW.webContents && !MAIN_WINDOW.isDestroyed()) {
      console.log('发送 clientConnection: true 到渲染进程');
      MAIN_WINDOW.webContents.send("clientConnection", true);
    } else {
      console.log('MAIN_WINDOW 尚未准备好，等待 dom-ready 事件');
    }

    // 判断是否允许通知
    if (store.get("allowNotify")) {
      // 弹出连接成功通知
      const notification = new Notification({
        title: "已连接中转服务器",
        body: `已连接至中转服务器【${store.get("transitUrl")}】，即刻开印！`,
      });
      // 显示通知
      notification.show();
    }

    // 同步到渲染进程（保持使用 SERVER 的 socket.id，而不是 CLIENT 的）
    if (MAIN_WINDOW && MAIN_WINDOW.webContents) {
      MAIN_WINDOW.webContents.executeJavaScript(`
        window.localClientId = '${global.LOCAL_CLIENT_ID}';
        console.log('同步本机 clientId 到渲染进程（基于 SERVER）: ${global.LOCAL_CLIENT_ID}');
      `).catch(() => {});
    }

    // 向 中转服务 发送打印机列表
    const printers = await MAIN_WINDOW.webContents.getPrintersAsync();
    client.emit("printerList", printers);

    // 向 中转服务 发送客户端信息（使用 SERVER 的 socket.id）
    emitClientInfo(client, global.LOCAL_CLIENT_ID);

    // 延迟3秒后，主动请求最新的 printerList（包含所有客户端的）
    // 这样可以确保本机收到汇总结果并更新 clientId
    setTimeout(() => {
      client.emit("refreshPrinterList");
    }, 3000);
  });

  /**
   * @description: 中转服务 请求客户端信息
   */
  client.on("getClientInfo", () => {
    console.log(`中转服务 ${client.id}: getClientInfo`);
    // 中转服务请求客户端信息时，也使用 SERVER 的 socket.id
    emitClientInfo(client, global.LOCAL_CLIENT_ID);
  });

  /**
   * @description: 中转服务 请求刷新打印机列表
   */
  client.on("refreshPrinterList", async (data) => {
    const printers = await MAIN_WINDOW.webContents.getPrintersAsync();

    // 为每个打印机添加服务器信息
    const printersWithServer = printers.map(printer => ({
      ...printer,
      server: {
        clientId: global.LOCAL_CLIENT_ID,
        hostname: os.hostname(),
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        mac: 'N/A',
        ip: _address.ip(),
        ipv6: _address.ipv6(),
        clientUrl: `http://${_address.ip()}:${store.get("port") || 17521}`,
        machineId: getMachineId(),
        nickName: store.get("nickName"),
      }
    }));

    // 如果有 replyId，返回给指定的 replyId，否则发送到默认事件
    if (data && data.replyId) {
      client.emit(`printerList-${data.replyId}`, printersWithServer);
    } else {
      client.emit("printerList", printersWithServer);
    }
  });

  /**
   * @description: 中转服务 调用 ipp 打印 详见：https://www.npmjs.com/package/ipp
   */
  client.on("ippPrint", (options) => {
    console.log(`中转服务 ${client.id}: ippPrint`);
    try {
      const { url, opt, action, message, replyId } = options;
      let printer = ipp.Printer(url, opt);
      client.emit("ippPrinterConnected", { printer, replyId });
      let msg = Object.assign(
        {
          "operation-attributes-tag": {
            "requesting-user-name": "hiPrint",
          },
        },
        message,
      );
      // data 必须是 Buffer 类型
      if (msg.data && !Buffer.isBuffer(msg.data)) {
        if ("string" === typeof msg.data) {
          msg.data = Buffer.from(msg.data, msg.encoding || "utf8");
        } else {
          msg.data = Buffer.from(msg.data);
        }
      }
      /**
       * action: Get-Printer-Attributes 获取打印机支持参数
       * action: Print-Job 新建打印任务
       * action: Cancel-Job 取消打印任务
       */
      printer.execute(action, msg, (err, res) => {
        client.emit(
          "ippPrinterCallback",
          err ? { type: err.name, msg: err.message, replyId } : { replyId },
          res,
        );
      });
    } catch (error) {
      console.log(`中转服务 ${client.id}: ippPrint error: ${error.message}`);
      client.emit("ippPrinterCallback", {
        type: error.name,
        msg: error.message,
        replyId,
      });
    }
  });

  /**
   * @description: 中转服务 ipp request 详见：https://www.npmjs.com/package/ipp
   */
  client.on("ippRequest", (options) => {
    console.log(`中转服务 ${client.id}: ippRequest`);
    try {
      const { url, data, replyId } = options;
      let _data = ipp.serialize(data);
      ipp.request(url, _data, (err, res) => {
        client.emit(
          "ippRequestCallback",
          err ? { type: err.name, msg: err.message, replyId } : { replyId },
          res,
        );
      });
    } catch (error) {
      console.log(`中转服务 ${client.id}: ippRequest error: ${error.message}`);
      client.emit("ippRequestCallback", {
        type: error.name,
        msg: error.message,
        replyId,
      });
    }
  });

  /**
   * @description: 中转服务 常规打印任务
   */
  client.on("news", (data) => {
    if (data) {
      // 检查是否指定了目标客户端 (printer 或 client 参数可能是 clientId)
      // 注意：中转服务转发时会将 printer 映射为 client
      const targetClientId = data.client || data.printer;
      const looksLikeClientId = targetClientId && targetClientId.length >= 15;

      // 只有当这个打印请求不是来自本地（replyId存在），才需要转发到其他客户端
      // 如果是本地的打印请求，需要检查目标是否为本机
      if (data.replyId) {
        // 这是从另一个客户端转发过来的远程打印请求
        // 检查目标是否是本机
        const isTargetLocal = targetClientId === global.LOCAL_CLIENT_ID;

        if (isTargetLocal) {
          // 目标为本机，在本机执行打印
          // 如果请求中包含 client 参数（中转服务转发的请求），需要将 client 转换回 printer
          // 这是因为本机在发送请求时将 printer 映射为了 client，现在需要还原
          if (data.client && !data.printer) {
            data.printer = data.client;
          }

          // 从 data.printer 中提取实际打印机名称
          // data.printer 可能是 displayName "[IP] 打印机名称" 或原始打印机名称
          let actualPrinterName = data.printer;
          if (actualPrinterName && actualPrinterName.includes('] ')) {
            actualPrinterName = actualPrinterName.substring(actualPrinterName.indexOf('] ') + 2);
          }

          PRINT_RUNNER.add((done) => {
            data.socketId = client.id;
            data.taskId = uuidv7();
            data.clientType = "transit";
            // 不修改 data.printer，保持原始的 displayName/clientId 用于结果反馈
            // 但传递 actualPrinterName 给打印窗口
            const printData = { ...data, printer: actualPrinterName };
            PRINT_WINDOW.webContents.send("print-new", printData);
            MAIN_WINDOW.webContents.send("printTask", true);
            PRINT_RUNNER_DONE[data.taskId] = done;
          });
        } else if (targetClientId && targetClientId !== client.id && looksLikeClientId) {
          // 目标为其他客户端，转发给中转服务
          // 提取实际的打印机名称（去掉IP前缀）
          let actualPrinterName = data.printer;
          if (actualPrinterName && actualPrinterName.includes('] ')) {
            actualPrinterName = actualPrinterName.substring(actualPrinterName.indexOf('] ') + 2);
          }

          // 确定目标客户端ID
          // 如果targetClientId看起来像clientId，直接使用
          // 否则从缓存查询
          let clientIdForTransit = targetClientId;
          if (!looksLikeClientId) {
            // targetClientId可能不是clientId，需要从缓存查询
            const printerParam = data.client || data.printer;
            const cacheResult = queryPrinterCache(printerParam);
            if (cacheResult) {
              clientIdForTransit = cacheResult.clientId;
              actualPrinterName = cacheResult.originalName || actualPrinterName;
            } else {
              clientIdForTransit = targetClientId; // 回退到原始值
            }
          }

          // 将printer参数映射为client参数，供中转服务识别
          // 中转服务期望"client"字段来识别目标客户端，而不是"printer"
          const forwardData = {
            ...data,
            client: clientIdForTransit,  // 使用clientId而不是printer名称
            printer: actualPrinterName  // 传递实际的打印机名称（去掉IP前缀）
          };

          client.emit("news", forwardData);
        } else {
          // 没有指定有效目标，按本地打印机处理

          // 如果请求中包含 client 参数（中转服务转发的请求），需要将 client 转换回 printer
          // 这是因为本机在发送请求时将 printer 映射为了 client，现在需要还原
          if (data.client && !data.printer) {
            data.printer = data.client;
          }

          PRINT_RUNNER.add((done) => {
            data.socketId = client.id;
            data.taskId = uuidv7();
            data.clientType = "transit";

            // 如果打印机名称包含IP前缀，需要去掉前缀
            let printerName = data.printer;
            if (printerName && printerName.includes('] ')) {
              printerName = printerName.substring(printerName.indexOf('] ') + 2);
              data.printer = printerName;
            }

            PRINT_WINDOW.webContents.send("print-new", data);
            MAIN_WINDOW.webContents.send("printTask", true);
            PRINT_RUNNER_DONE[data.taskId] = done;
          });
        }
      } else {
        // 这是本地打印请求（从本地web应用发送的）
        const isLocalClientId = looksLikeClientId && targetClientId === global.LOCAL_CLIENT_ID;

        if (isLocalClientId) {
          // 目标为本机
          // 如果请求中包含 client 参数（中转服务转发的请求），需要将 client 转换回 printer
          // 这是因为本机在发送请求时将 printer 映射为了 client，现在需要还原
          if (data.client && !data.printer) {
            data.printer = data.client;
          }

          // 从 data.printer 中提取实际打印机名称
          // data.printer 可能是 displayName "[IP] 打印机名称" 或原始打印机名称
          let actualPrinterName = data.printer;
          if (actualPrinterName && actualPrinterName.includes('] ')) {
            actualPrinterName = actualPrinterName.substring(actualPrinterName.indexOf('] ') + 2);
          }

          PRINT_RUNNER.add((done) => {
            data.socketId = client.id;
            data.taskId = uuidv7();
            data.clientType = "transit";
            // 不修改 data.printer，保持原始的 displayName/clientId 用于结果反馈
            // 但传递 actualPrinterName 给打印窗口
            const printData = { ...data, printer: actualPrinterName };
            PRINT_WINDOW.webContents.send("print-new", printData);
            MAIN_WINDOW.webContents.send("printTask", true);
            PRINT_RUNNER_DONE[data.taskId] = done;
          });
        } else if (targetClientId && targetClientId !== client.id && looksLikeClientId) {
          // 目标为其他客户端，转发给中转服务
          // 提取实际的打印机名称（去掉IP前缀）
          let actualPrinterName = data.printer;
          if (actualPrinterName && actualPrinterName.includes('] ')) {
            actualPrinterName = actualPrinterName.substring(actualPrinterName.indexOf('] ') + 2);
          }

          // 确定目标客户端ID
          // 如果targetClientId看起来像clientId，直接使用
          // 否则从缓存查询
          let clientIdForTransit = targetClientId;
          if (!looksLikeClientId) {
            // targetClientId可能不是clientId，需要从缓存查询
            const printerParam = data.client || data.printer;
            const cacheResult = queryPrinterCache(printerParam);
            if (cacheResult) {
              clientIdForTransit = cacheResult.clientId;
              actualPrinterName = cacheResult.originalName || actualPrinterName;
            } else {
              clientIdForTransit = targetClientId; // 回退到原始值
            }
          }

          // 将printer参数映射为client参数，供中转服务识别
          // 中转服务期望"client"字段来识别目标客户端，而不是"printer"
          const forwardData = {
            ...data,
            client: clientIdForTransit,  // 使用clientId而不是printer名称
            printer: actualPrinterName  // 传递实际的打印机名称（去掉IP前缀）
          };

          client.emit("news", forwardData);
        } else {
          // 没有指定客户端ID或就是自己，按本地打印机处理
          PRINT_RUNNER.add((done) => {
            data.socketId = client.id;
            data.taskId = uuidv7();
            data.clientType = "transit";
            PRINT_WINDOW.webContents.send("print-new", data);
            MAIN_WINDOW.webContents.send("printTask", true);
            PRINT_RUNNER_DONE[data.taskId] = done;
          });
        }
      }
    }
  });

  client.on("render-print", (data) => {
    if (data) {
      RENDER_RUNNER.add((done) => {
        data.socketId = client.id;
        data.taskId = uuidv7();
        data.clientType = "transit";
        RENDER_WINDOW.webContents.send("print", data);
        RENDER_RUNNER_DONE[data.taskId] = done;
      });
    }
  });

  client.on("render-jpeg", (data) => {
    if (data) {
      RENDER_RUNNER.add((done) => {
        data.socketId = client.id;
        data.taskId = uuidv7();
        data.clientType = "transit";
        RENDER_WINDOW.webContents.send("png", data);
        RENDER_RUNNER_DONE[data.taskId] = done;
      });
    }
  });

  client.on("render-pdf", (data) => {
    if (data) {
      RENDER_RUNNER.add((done) => {
        data.socketId = client.id;
        data.taskId = uuidv7();
        data.clientType = "transit";
        RENDER_WINDOW.webContents.send("pdf", data);
        RENDER_RUNNER_DONE[data.taskId] = done;
      });
    }
  });

  /**
   * @description: 中转服务 断开连接
   */
  client.on("disconnect", () => {
    console.log(`==> 中转服务 Disconnect: ${client.id}`);
    if (MAIN_WINDOW && MAIN_WINDOW.webContents && !MAIN_WINDOW.isDestroyed()) {
      MAIN_WINDOW.webContents.send("clientConnection", false);
    } else {
      console.log('MAIN_WINDOW 不可用，跳过发送断开状态');
    }
  });

  /**
   * @description: 中转服务返回打印机列表
   * 注意：中转服务只给请求者返回汇总结果，其他客户端不会收到
   * 但客户端仍然需要处理，以便更新缓存和匹配本机信息
   */
  client.on("printerList", (printers) => {
    if (printers && printers.length > 0) {
    }
    console.log(`==> 中转服务返回打印机列表: ${printers ? printers.length : 'undefined'}台 <==`);

    if (!global.TRANSIT_PRINTERS_CACHE) {
      global.TRANSIT_PRINTERS_CACHE = {};
    }

    let list = [];
    const cacheForRenderer = {};

    // 首先获取本机 IP，用于匹配本机的 clientId
    const localIp = _address.ip();

    // 处理中转服务返回的打印列表
    printers.forEach((item, index) => {
      const server = item.server || {};
      const clientId = server.clientId;
      const nickName = server.nickName || '';
      const ip = server.ip || '';

      // 如果是本机的打印列表项，使用中转服务返回的 clientId 更新本机 clientId
      if (ip && ip === localIp && clientId) {
        global.LOCAL_CLIENT_ID = clientId;

        // 同步到渲染进程
        if (MAIN_WINDOW && MAIN_WINDOW.webContents) {
          MAIN_WINDOW.webContents.executeJavaScript(`
            window.localClientId = '${clientId}';
            console.log('同步中转服务返回的 clientId 到渲染进程: ${clientId}');
          `).catch((err) => {
            console.error('同步到渲染进程失败:', err);
          });
        }

        // 同步到设置窗口
        if (SET_WINDOW && SET_WINDOW.webContents) {
          SET_WINDOW.webContents.executeJavaScript(`
            window.localClientId = '${clientId}';
            console.log('同步中转服务返回的 clientId 到设置窗口: ${clientId}');
          `).catch((err) => {
            console.error('同步到设置窗口失败:', err);
          });
        }
      }

      // 构建客户端标识符
      let clientLabel = '';
      if (nickName && nickName.trim()) {
        // 如果有昵称，优先显示昵称
        clientLabel = nickName;
      } else if (ip) {
        // 如果没有昵称，显示IP
        clientLabel = ip;
      }

      // 生成显示名称，格式：[客户端标识符] 打印机名称
      const displayName = `${clientLabel ? `[${clientLabel}] ` : ''}${item.displayName || item.name || item}`;

      // 存储客户端信息到缓存
      if (clientId) {
        global.TRANSIT_PRINTERS_CACHE[displayName] = {
          displayName: displayName,
          originalName: item.name || item,
          server: server,
          clientId: clientId  // 同时保存 clientId 到值中
        };
        cacheForRenderer[displayName] = {
          clientId: clientId,
          originalName: item.name || item
        };
        list.push({ label: displayName, value: displayName, clientId: clientId });
      } else {
        // 如果没有 clientId，视为本地打印机
        const printerName = item.displayName || item.name || item;
        list.push({ label: printerName, value: printerName });
      }
    });

    // 发送到设置窗口（使用 SERVER 的 socket.id，而不是 CLIENT 的）
    if (SET_WINDOW) {
      SET_WINDOW.webContents.send("getPrintersList", { printers: list, cache: cacheForRenderer, clientId: global.LOCAL_CLIENT_ID });
      // 同步缓存到设置窗口
      SET_WINDOW.webContents.executeJavaScript(`
        window.globalTransitPrinterCache = ${JSON.stringify(cacheForRenderer)};
      `).catch((err) => {
        console.error('同步缓存到设置窗口失败:', err);
      });
    }

    // 同时同步到渲染进程的全局变量，保持一致性
    // 这样可以在 print.js 中访问到缓存
    if (MAIN_WINDOW && MAIN_WINDOW.webContents) {
      MAIN_WINDOW.webContents.executeJavaScript(`
        window.globalTransitPrinterCache = ${JSON.stringify(cacheForRenderer)};
      `).catch((err) => {
        console.error('同步缓存到主窗口失败:', err);
      });
    }
  });
}

/**
 * @description: 打印机状态码 十进制 -> 十六进制, 返回对应的详细错误信息， 详见：https://github.com/mlmdflr/win32-pdf-printer/blob/51f7a9b3687e260a7d83ea467b22b374fb153b52/paper-size-info/Status.cs
 * @param { String } printerName  打印机名称
 * @return { Object  { StatusMsg: String // 打印机状态详情信息 } }
 */

function getCurrentPrintStatusByName(printerName) {
  if (process.platform === "win32") {
    try {
      const paperList = safeGetPaperSizeInfoAll();
      const printerInfo = paperList.find(
        (item) => item.PrinterName === printerName,
      );
      return {
        StatusMsg: printerInfo?.StatusMsg || "未找到打印机",
      };
    } catch (error) {
      console.error("获取打印机状态失败:", error.message);
      return {
        StatusMsg: "获取打印机状态失败",
      };
    }
  }
  return { StatusMsg: "非Windows系统, 暂不支持" };
}

function showAboutDialog() {
  const detail = `版本: ${app.getVersion()}
提交: ${buildInfo.commitId}
日期: ${buildInfo.commitDate}
Electron: ${process.versions.electron}
Chromium: ${process.versions.chrome}
Node.js: ${process.versions.node}
V8: ${process.versions.v8}
OS: ${os.type()} ${os.arch()} ${os.release()}`.trim();
  const title = store.get("mainTitle") || "Electron-hiprint";
  dialog
    .showMessageBox({
      title: `关于 ${title}`,
      message: title,
      type: "info",
      buttons: ["反馈", "复制", "确定"],
      noLink: true,
      defaultId: 0,
      detail,
      cancelId: 2,
      normalizeAccessKeys: true,
    })
    .then((result) => {
      if (result.response === 0) {
        const issuesUrl = new URL(
          `https://github.com/CcSimple/electron-hiprint/issues/new`,
        );
        issuesUrl.searchParams.set(
          "title",
          `[反馈][${app.getVersion()}] 在此处完善反馈标题`,
        );
        const issuesBody = `## 问题描述
请在此处详细描述你遇到的问题

## 版本信息
  
${detail}`;
        issuesUrl.searchParams.set("body", issuesBody);
        shell.openExternal(issuesUrl.href);
      }
      if (result.response === 1) {
        clipboard.writeText(detail);
      }
    });
}

module.exports = {
  store,
  address: _address,
  initServeEvent,
  initClientEvent,
  getCurrentPrintStatusByName,
  getMachineId,
  showAboutDialog,
  DEFAULT_SELF_SERVICE_PRINT_URL,
};
