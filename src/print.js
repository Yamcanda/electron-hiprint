"use strict";

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { printPdf, printPdfBlob } = require("./pdf-print");
const { store, getCurrentPrintStatusByName } = require("../tools/utils");
const db = require("../tools/database");
const dayjs = require("dayjs");
const { v7: uuidv7 } = require("uuid");

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
async function isLocalPrinter(printerName) {
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
 * @description: 创建打印窗口
 * @return {BrowserWindow} PRINT_WINDOW 打印窗口
 */
async function createPrintWindow() {
  const windowOptions = {
    width: 100, // 窗口宽度
    height: 100, // 窗口高度
    show: false, // 不显示
    webPreferences: {
      contextIsolation: false, // 设置此项为false后，才可在渲染进程中使用electron api
      nodeIntegration: true,
    },
    // 为窗口设置背景色可能优化字体模糊问题
    // https://www.electronjs.org/zh/docs/latest/faq#文字看起来很模糊这是什么原因造成的怎么解决这个问题呢
    backgroundColor: "#fff",
  };

  // 创建打印窗口
  PRINT_WINDOW = new BrowserWindow(windowOptions);

  // 加载打印渲染进程页面
  let printHtml = path.join("file://", app.getAppPath(), "/assets/print.html");
  PRINT_WINDOW.webContents.loadURL(printHtml);

  // 未打包时打开开发者工具
  // if (!app.isPackaged) {
  //   PRINT_WINDOW.webContents.openDevTools();
  // }

  // 绑定窗口事件
  initPrintEvent();

  return PRINT_WINDOW;
}

/**
 * @description: 绑定打印窗口事件
 * @return {Void}
 */
function initPrintEvent() {
  ipcMain.on("getPrinterList", (event) => {
    PRINT_WINDOW.webContents.getPrintersAsync().then(printers => {
      event.sender.send('printerList', printers);
    });
  });

  ipcMain.on("print-new-test", async (event, data) => {
    const jsonData = JSON.stringify(data);
    // console.log(`"【debug】print-new-test 测试打印：" ${jsonData}`);
    
    // 获取本机 clientId
    let localClientId = null;
    try {
      // 优先从主进程全局变量获取
      localClientId = global.LOCAL_CLIENT_ID || null;

      // 如果主进程没有，则从渲染进程获取
      if (!localClientId && MAIN_WINDOW && MAIN_WINDOW.webContents) {
        try {
          const result = await MAIN_WINDOW.webContents.executeJavaScript('window.localClientId || null');
          localClientId = result;
        } catch (err) {
          console.error('从渲染进程获取本机 clientId 失败:', err);
        }
      }

      // 如果还是没有，使用 IPC 请求主进程返回
      if (!localClientId && event && event.sender) {
        localClientId = await new Promise((resolve) => {
          // 创建一个临时监听器，等待主进程返回
          const tempHandler = (event, clientId) => {
            ipcMain.removeListener('localClientId', tempHandler);
            resolve(clientId);
          };

          // 临时监听响应
          ipcMain.once('localClientId', tempHandler);

          // 发送请求给主进程
          event.sender.send('getLocalClientId');

          // 5秒超时
          setTimeout(() => {
            ipcMain.removeListener('localClientId', tempHandler);
            resolve(null);
          }, 5000);
        });
      }
    } catch (err) {
      console.error('获取本机 clientId 失败:', err);
    }

    // 处理中转服务测试打印
    if (data.clientType === "transit" && data.replyId) {
      // 先从缓存查询打印机信息
      const cacheResult = queryPrinterCache(data.printer);

      // 如果缓存中有这个打印机的信息
      if (cacheResult && cacheResult.server && cacheResult.clientId) {
        const targetClientId = cacheResult.clientId;
        const serverInfo = cacheResult.server;

        // 如果这个打印机属于本机，在本机打印
        if (global.LOCAL_CLIENT_ID && targetClientId === global.LOCAL_CLIENT_ID) {
          data.clientType = "local";
          // 使用本机实际打印机名称，而不是带IP前缀的显示名称
          // 去掉前缀 [IP地址]  获取纯打印机名称
          let printerName = cacheResult.originalName || data.printer;
          if (printerName && printerName.includes('] ')) {
            printerName = printerName.substring(printerName.indexOf('] ') + 2);
          }
          data.printer = printerName;
          PRINT_WINDOW.webContents.send("print-new", data);
          return;
        }

        // 如果这个打印机属于远程客户端，发送到中转服务
        if (global.SOCKET_CLIENT && global.SOCKET_CLIENT.connected) {
          // 直接发送给中央中转服务
          if (!data.replyId) {
            data.replyId = `rid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          }

          // 提取实际的打印机名称（去掉IP前缀）
          let actualPrinterName = cacheResult.originalName || data.printer;
          if (actualPrinterName && actualPrinterName.includes('] ')) {
            actualPrinterName = actualPrinterName.substring(actualPrinterName.indexOf('] ') + 2);
          }

          // 将参数映射为中转服务期望的格式
          const forwardData = {
            ...data,
            client: targetClientId,  // 使用clientId而不是printer名称
            printer: actualPrinterName  // 传递实际的打印机名称（去掉IP前缀）
          };

          global.SOCKET_CLIENT.emit("news", forwardData);
        } else {
          event.sender.send("printTestError", {
            message: "未连接中转服务"
          });
        }
        return;
      }

      // 如果缓存中没有这个打印机，可能是本机打印机
      // 检查是否是本机clientId
      const looksLikeClientId = data.printer && data.printer.length >= 15;
      const isLocalClientId = looksLikeClientId && localClientId && data.printer === localClientId;

      // 如果是本机的客户端ID，在本机打印
      if (isLocalClientId) {
        data.clientType = "local";
        // 使用本机实际打印机名称，而不是 clientId
        // 去掉前缀 [IP地址]  获取纯打印机名称
        let printerName = store.get("defaultPrinter") || "";
        if (printerName && printerName.includes('] ')) {
          printerName = printerName.substring(printerName.indexOf('] ') + 2);
        }
        data.printer = printerName;
        PRINT_WINDOW.webContents.send("print-new", data);
        return;
      }

      // 尝试从本机打印机列表中查找是否有同名打印机
      const localPrinters = await PRINT_WINDOW.webContents.getPrintersAsync();
      const localPrinterNames = localPrinters.map(p => p.name);
      const cleanName = data.printer && data.printer.includes('] ')
        ? data.printer.substring(data.printer.indexOf('] ') + 2)
        : data.printer;
      const hasLocalPrinter = localPrinterNames.includes(cleanName) || localPrinterNames.includes(data.printer);

      if (hasLocalPrinter) {
        // 本机有同名打印机，在本机打印
        data.clientType = "local";
        data.printer = cleanName;
        PRINT_WINDOW.webContents.send("print-new", data);
        return;
      }

      // 如果本机没有这个打印机且已连接中转服务，发送到中转服务
      if (global.SOCKET_CLIENT && global.SOCKET_CLIENT.connected) {
        const isClientId = queryPrinterCache(data.printer);
        if (isClientId && isClientId.server && isClientId.clientId) {
          const forwardData = {
            ...data,
            client: isClientId.clientId,
            printer: cleanName
          };
          global.SOCKET_CLIENT.emit("news", forwardData);
        } else {
          // 没有缓存信息，可能是远程打印机但缓存中没有，提示错误
          event.sender.send("printTestError", {
            message: `未找到打印机 ${data.printer} 的缓存信息`
          });
        }
      } else {
        event.sender.send("printTestError", {
          message: `未连接中转服务，无法打印远程打印机 ${data.printer}`
        });
      }
      return;
    }

    // 本地测试打印
    PRINT_WINDOW.webContents.send("print-new", data);
  });

  ipcMain.on("do", async (event, data) => {
    // console.log(`${data.html}`); // for debug
    var st = new Date().getTime();
    let socket = null;
    if (data.clientType === "local") {
      socket = SOCKET_SERVER.sockets.sockets.get(data.socketId);
    } else {
      socket = SOCKET_CLIENT;
    }
    const printers = await PRINT_WINDOW.webContents.getPrintersAsync();
    let havePrinter = false;
    let defaultPrinter = data.printer || store.get("defaultPrinter", "");
    let printerError = false;
    printers.forEach((element) => {
      // 获取默认打印机
      if (
        element.isDefault &&
        (defaultPrinter == "" || defaultPrinter == void 0)
      ) {
        defaultPrinter = element.name;
      }
      // 判断打印机是否存在
      if (element.name === defaultPrinter) {
        // 打印机状态检查优化：只有在明确的错误状态时才认为异常
        // win32: https://learn.microsoft.com/en-us/windows/win32/printdocs/printer-info-2
        // 状态值说明：0=空闲，1=暂停，2=错误，3=打印中，4=预热，5=停止，6=离线
        if (process.platform === "win32") {
          // 只有在明确的错误状态（2=错误，5=停止，6=离线）时才认为异常
          // 状态 0=空闲, 1=暂停, 3=打印中, 4=预热 都是正常的
          // if (element.status === 2 || element.status === 5 || element.status === 6) {
          if (![0, 512, 1024].includes(element.status)) {
            printerError = true;
          }
        } else {
          // Unix/Linux 系统，只有明确的错误状态才认为异常
          // cups 状态：3=idle（空闲），5=stopped（停止），其他状态需要具体判断
          if (element.status != 3) {
            printerError = true;
          }
        }
        havePrinter = true;
      }
    });
    // 检查打印机是否存在
    if (!havePrinter) {
      console.log(
        `${data.replyId ? "中转服务" : "插件端"} ${socket ? socket.id : '未知'} 模板 【${
          data.templateId
        }】 打印失败，打印机不存在，打印机：${defaultPrinter}`,
      );
      socket &&
        socket.emit("error", {
          msg: data.printer + "打印机不存在",
          templateId: data.templateId,
          replyId: data.replyId,
        });
      if (data.taskId) {
        // 通过 taskMap 调用 task done 回调
        PRINT_RUNNER_DONE[data.taskId]();
        delete PRINT_RUNNER_DONE[data.taskId];
      }
      MAIN_WINDOW.webContents.send("printTask", PRINT_RUNNER.isBusy());
      return;
    }
    if (printerError) {
      const { StatusMsg } = getCurrentPrintStatusByName(defaultPrinter);
      console.log(
        `${data.replyId ? "中转服务" : "插件端"} ${socket ? socket.id : '未知'} 模板 【${
          data.templateId
        }】 打印失败，打印机异常，打印机：${defaultPrinter}, 打印机状态：${StatusMsg}`,
      );
      socket &&
        socket.emit("error", {
          msg: data.printer + "打印机异常",
          templateId: data.templateId,
          replyId: data.replyId,
        });
      if (data.taskId) {
        // 通过 taskMap 调用 task done 回调
        PRINT_RUNNER_DONE[data.taskId]();
        delete PRINT_RUNNER_DONE[data.taskId];
      }
      MAIN_WINDOW.webContents.send("printTask", PRINT_RUNNER.isBusy());
      return;
    }
    let deviceName = defaultPrinter;

    const logPrintResult = (status, errorMessage = "") => {
      db.run(
        `INSERT INTO print_logs (socketId, clientType, printer, templateId, data, pageNum, status, rePrintAble, errorMessage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          socket?.id,
          data.clientType,
          deviceName,
          data.templateId,
          JSON.stringify(data),
          data.pageNum,
          status,
          data.rePrintAble ?? 1,
          errorMessage,
        ],
        (err) => {
          if (err) {
            console.error("Failed to log print result", err);
          }
        },
      );

      // 限制防止 sqlite 数据量太大
      db.get(
        `SELECT COUNT(*) AS count FROM print_logs`,
        (err, row) => {
          if (err) {
            console.error("Failed to log print result", err);
            return;
          }
          
          if (row.count > 10000) {
            db.run(`DELETE FROM print_logs WHERE id IN (SELECT id FROM print_logs ORDER BY id ASC LIMIT ?)`,
              [row.count - 10000],
              (err) => {
                if (err) {
                  console.error("Failed to cleanup old print logs", err);
                }
              }
            );
          }
        },
      );
    };

    // pdf 打印
    let isPdf = data.type && `${data.type}`.toLowerCase() === "pdf";
    if (isPdf) {
      const pdfPath = path.join(
        store.get("pdfPath") || os.tmpdir(),
        "hiprint",
        dayjs().format(`YYYY_MM_DD HH_mm_ss_`) + `${uuidv7()}.pdf`,
      );
      fs.mkdirSync(path.dirname(pdfPath), {
        recursive: true,
      });
      PRINT_WINDOW.webContents
        .printToPDF({
          landscape: data.landscape ?? false, // 横向打印
          displayHeaderFooter: data.displayHeaderFooter ?? false, // 显示页眉页脚
          printBackground: data.printBackground ?? true, // 打印背景色
          scale: data.scale ?? 1, // 渲染比例 默认 1
          pageSize: data.pageSize,
          margins: data.margins ?? {
            marginType: "none",
          }, // 边距
          pageRanges: data.pageRanges, // 打印页数范围
          headerTemplate: data.headerTemplate, // 页头模板 (html)
          footerTemplate: data.footerTemplate, // 页脚模板 (html)
          preferCSSPageSize: data.preferCSSPageSize ?? false,
        })
        .then((pdfData) => {
          fs.writeFileSync(pdfPath, pdfData);
          printPdf(pdfPath, deviceName, data)
            .then(() => {
              console.log(
                `${data.replyId ? "中转服务" : "插件端"} ${socket ? socket.id : '未知'} 模板 【${
                  data.templateId
                }】 打印成功，打印类型：PDF，打印机：${deviceName}，页数：${
                  data.pageNum
                }`,
              );
              if (socket) {
                const result = {
                  msg: "打印成功",
                  templateId: data.templateId,
                  replyId: data.replyId,
                };
                // socket.emit("successs", result); // 兼容 vue-plugin-hiprint 0.0.56 之前包
                socket.emit("success", result);
              }
              logPrintResult("success");
            })
            .catch((err) => {
              console.log(
                `${data.replyId ? "中转服务" : "插件端"} ${socket ? socket.id : '未知'} 模板 【${
                  data.templateId
                }】 打印失败，打印类型：PDF，打印机：${deviceName}，原因：${
                  err.message
                }`,
              );
              socket &&
                socket.emit("error", {
                  msg: "打印失败: " + err.message,
                  templateId: data.templateId,
                  replyId: data.replyId,
                });
              logPrintResult("failed", err.message);
            })
            .finally(() => {
              if (data.taskId) {
                // 通过taskMap 调用 task done 回调
                PRINT_RUNNER_DONE[data.taskId]();
                // 删除 task
                delete PRINT_RUNNER_DONE[data.taskId];
              }
              MAIN_WINDOW.webContents.send("printTask", PRINT_RUNNER.isBusy());
            });
        });
      return;
    }
    // url_pdf 打印
    const isUrlPdf = data.type && `${data.type}`.toLowerCase() === "url_pdf";
    if (isUrlPdf) {
      printPdf(data.pdf_path, deviceName, data)
        .then(() => {
          console.log(
            `${data.replyId ? "中转服务" : "插件端"} ${socket ? socket.id : '未知'} 模板 【${
              data.templateId
            }】 打印成功，打印类型：URL_PDF，打印机：${deviceName}，页数：${
              data.pageNum
            }`,
          );
          if (socket) {
            checkPrinterStatus(deviceName, () => {
              const result = {
                msg: "打印成功",
                templateId: data.templateId,
                replyId: data.replyId,
              };
              // socket.emit("successs", result); // 兼容 vue-plugin-hiprint 0.0.56 之前包
              socket.emit("success", result);
            });
          }
          logPrintResult("success");
        })
        .catch((err) => {
          console.log(
            `${data.replyId ? "中转服务" : "插件端"} ${socket ? socket.id : '未知'} 模板 【${
              data.templateId
            }】 打印失败，打印类型：URL_PDF，打印机：${deviceName}，url: ${data.pdf_path}，原因：${
              err.message
            }`,
          );
          socket &&
            socket.emit("error", {
              msg: "打印失败: " + err.message,
              templateId: data.templateId,
              replyId: data.replyId,
            });
          logPrintResult("failed", err.message);
        })
        .finally(() => {
          if (data.taskId) {
            // 通过 taskMap 调用 task done 回调
            PRINT_RUNNER_DONE[data.taskId]();
            // 删除 task
            delete PRINT_RUNNER_DONE[data.taskId];
          }
          MAIN_WINDOW.webContents.send("printTask", PRINT_RUNNER.isBusy());
        });
      return;
    }

    // blob_pdf 打印 - 直接接收二进制PDF数据
    const isBlobPdf = data.type && `${data.type}`.toLowerCase() === "blob_pdf";
    if (isBlobPdf) {
      // 验证必要参数
      if (!data.pdf_blob) {
        const errorMsg = "blob_pdf类型打印缺少pdf_blob参数";
        console.log(
          `${data.replyId ? "中转服务" : "插件端"} ${socket?.id} 模板 【${
            data.templateId
          }】 打印失败，原因：${errorMsg}`,
        );
        socket &&
        socket.emit("error", {
          msg: errorMsg,
          templateId: data.templateId,
          replyId: data.replyId,
        });
        logPrintResult("failed", errorMsg);
        if (data.taskId) {
          PRINT_RUNNER_DONE[data.taskId]();
          delete PRINT_RUNNER_DONE[data.taskId];
        }
        MAIN_WINDOW.webContents.send("printTask", PRINT_RUNNER.isBusy());
        return;
      }
      let pdfBlob = data.pdf_blob;
      delete data.pdf_blob;
      printPdfBlob(pdfBlob, deviceName, data)
        .then(() => {
          console.log(
            `${data.replyId ? "中转服务" : "插件端"} ${socket ? socket.id : '未知'} 模板 【${
              data.templateId
            }】 打印成功，打印类型：BLOB_PDF，打印机：${deviceName}，页数：${
              data.pageNum
            }`,
          );
          if (socket) {
            checkPrinterStatus(deviceName, () => {
              const result = {
                msg: "打印成功",
                templateId: data.templateId,
                replyId: data.replyId,
              };
              // socket.emit("successs", result); // 兼容 vue-plugin-hiprint 0.0.56 之前包
              socket.emit("success", result);
            });
          }
          logPrintResult("success");
        })
        .catch((err) => {
          console.log(
            `${data.replyId ? "中转服务" : "插件端"} ${socket ? socket.id : '未知'} 模板 【${
              data.templateId
            }】 打印失败，打印类型：BLOB_PDF，打印机：${deviceName}，原因：${
              err.message
            }`,
          );
          socket &&
          socket.emit("error", {
            msg: "打印失败: " + err.message,
            templateId: data.templateId,
            replyId: data.replyId,
          });
          logPrintResult("failed", err.message);
        })
        .finally(() => {
          if (data.taskId) {
            // 通过 taskMap 调用 task done 回调
            PRINT_RUNNER_DONE[data.taskId]();
            // 删除 task
            delete PRINT_RUNNER_DONE[data.taskId];
          }
          MAIN_WINDOW.webContents.send("printTask", PRINT_RUNNER.isBusy());
        });
      return;
    }

    // 批量打印时，在打印前等待一小段时间，避免竞态条件
    // if (data.batchPrint) {
    //   await new Promise(resolve => setTimeout(resolve, 200));
    // }

    // 打印 详见https://www.electronjs.org/zh/docs/latest/api/web-contents
    PRINT_WINDOW.webContents.print(
      {
        silent: data.silent ?? true, // 静默打印
        printBackground: data.printBackground ?? true, // 是否打印背景
        deviceName: deviceName, // 打印机名称
        color: data.color ?? true, // 是否打印颜色
        margins: data.margins ?? {
          marginType: "none",
        }, // 边距
        landscape: data.landscape ?? false, // 是否横向打印
        scaleFactor: data.scaleFactor ?? 100, // 打印缩放比例
        pagesPerSheet: data.pagesPerSheet ?? 1, // 每张纸的页数
        collate: data.collate ?? true, // 是否排序
        copies: data.copies ?? 1, // 打印份数
        pageRanges: data.pageRanges ?? {}, // 打印页数
        duplexMode: data.duplexMode, // 打印模式 simplex,shortEdge,longEdge
        dpi: data.dpi ?? 300, // 打印机DPI
        header: data.header, // 打印头
        footer: data.footer, // 打印尾
        pageSize: data.pageSize, // 打印纸张
      },
      (success, failureReason) => {
        const debugHtmlData = data.html;
        let codeNumMatch = "测试打印";
        if(debugHtmlData.indexOf(codeNumMatch) < 0) {
          const codeNumReg = /<div[^>]*>(\d{10,16})<\/div>/;
          const match = debugHtmlData.match(codeNumReg);
          codeNumMatch = match ? match[1] : "未找到条码/回执等编号";
        }
        
        if (success) {
          var printTime = (new Date().getTime()) - st;
          console.log(
            `${data.replyId ? "中转服务" : "插件端"} ${socket?.id} 模板 【${
              data.templateId
            }】 打印成功，打印类型 HTML，打印机：${deviceName}，页数：${
              data.pageNum
            }，codeNum：${codeNumMatch}, time: ${printTime}`,
          );
          logPrintResult("success");
        } else {
          var printTime = (new Date().getTime()) - st;
          console.log(
            `${data.replyId ? "中转服务" : "插件端"} ${socket?.id} 模板 【${
              data.templateId
            }】 打印失败，打印类型 HTML，打印机：${deviceName}，原因：${
              failureReason
            }，codeNum：${codeNumMatch}, time: ${printTime}`,
          );
          logPrintResult("failed", failureReason);
        }
        if (socket) {
          if (success) {
            const result = {
              msg: "打印成功",
              templateId: data.templateId,
              replyId: data.replyId,
            };
            //socket.emit("successs", result); // 兼容 vue-plugin-hiprint 0.0.56 之前包
            socket.emit("success", result);
          } else {
            socket.emit("error", {
              msg: failureReason,
              templateId: data.templateId,
              replyId: data.replyId,
            });
          }
        }
        // 通过 taskMap 调用 task done 回调
        if (data.taskId) {
          PRINT_RUNNER_DONE[data.taskId] && PRINT_RUNNER_DONE[data.taskId]();
          // 删除 task
          delete (PRINT_RUNNER_DONE[data.taskId] && PRINT_RUNNER_DONE[data.taskId]);
        }
        MAIN_WINDOW.webContents.send("printTask", PRINT_RUNNER.isBusy());
      },
    );
  });
}

function checkPrinterStatus(deviceName, callback) {
  const intervalId = setInterval(() => {
    PRINT_WINDOW.webContents
      .getPrintersAsync()
      .then((printers) => {
        const printer = printers.find((printer) => printer.name === deviceName);
        console.log(`current printer: ${JSON.stringify(printer)}`);
        const ISCAN_STATUS = process.platform === "win32" ? 0 : 3;
        if (printer && printer.status === ISCAN_STATUS) {
          callback && callback();
          clearInterval(intervalId); // Stop polling when status is 0
          console.log(
            `Printer ${deviceName} is now ready (status: ${ISCAN_STATUS})`,
          );
          // You can add any additional logic here for when the printer is ready
        }
      })
      .catch((error) => {
        clearInterval(intervalId); // Also clear interval on error
        console.log(`Error checking printer status: ${error}`);
      });
  }, 1000); // Check every 1 second (adjust interval as needed)

  return intervalId; // Return the interval ID in case you need to cancel it externally
}

module.exports = async () => {
  // 创建打印窗口
  await createPrintWindow();
};
