"use strict";

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const printPdf = require("./pdf-print");
const log = require("../tools/log");
const { store } = require("../tools/utils");
const db = require("../tools/database");
const dayjs = require("dayjs");
const { v7: uuidv7 } = require("uuid");

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
    console.info(data);
    PRINT_WINDOW.webContents.send("print-new", data);
  });

  ipcMain.on("do", async (event, data) => {
    // log(`${data.html}`); // for debug
    var st = new Date().getTime();
    let socket = null;
    if (data.clientType === "local") {
      socket = SOCKET_SERVER.sockets.sockets.get(data.socketId);
    } else {
      socket = SOCKET_CLIENT;
    }
    const printers = await PRINT_WINDOW.webContents.getPrintersAsync();
    let havePrinter = false;
    let defaultPrinter = "";
    let printerError = false;
    printers.forEach((element) => {
      // 判断打印机是否存在
      if (element.name === data.printer) {
        // todo: 打印机状态对照表
        // win32: https://learn.microsoft.com/en-us/windows/win32/printdocs/printer-info-2
        // cups: https://www.cups.org/doc/cupspm.html#ipp_status_e
        if (process.platform === "win32") {
          if (element.status != 0) {
            printerError = true;
          }
        } else {
          if (element.status != 3) {
            printerError = true;
          }
        }
        havePrinter = true;
      }
      // 获取默认打印机
      if (element.isDefault) {
        defaultPrinter = element.name;
      }
    });
    if (printerError) {
      log(
        `${data.replyId ? "中转服务" : "插件端"} ${socket.id} 模板 【${
          data.templateId
        }】 打印失败，打印机异常，打印机：${data.printer}`,
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
    let deviceName = havePrinter ? data.printer : defaultPrinter;

    const logPrintResult = (status, errorMessage = "") => {
      db.run(
        `INSERT INTO print_logs (socketId, clientType, printer, templateId, data, pageNum, status, errorMessage) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          socket?.id,
          data.clientType,
          deviceName,
          data.templateId,
          JSON.stringify(data),
          data.pageNum,
          status,
          errorMessage,
        ],
        (err) => {
          if (err) {
            console.error("Failed to log print result", err);
          }
        },
      );

      db.get(
        `SELECT COUNT(*) AS count FROM print_logs`,
        (err, row) => {
          if (err) {
            console.error("Failed to log print result", err);
            return;
          }
          
          if (row.count > 100) {
            db.run(`DELETE FROM print_logs WHERE id IN (SELECT id FROM print_logs ORDER BY id ASC LIMIT ?)`,
              [row.count - 100],
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
              log(
                `${data.replyId ? "中转服务" : "插件端"} ${socket.id} 模板 【${
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
                socket.emit("successs", result); // 兼容 vue-plugin-hiprint 0.0.56 之前包
                socket.emit("success", result);
              }
              logPrintResult("success");
            })
            .catch((err) => {
              log(
                `${data.replyId ? "中转服务" : "插件端"} ${socket.id} 模板 【${
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
              logPrintResult("failure", err.message);
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
          log(
            `${data.replyId ? "中转服务" : "插件端"} ${socket.id} 模板 【${
              data.templateId
            }】 打印成功，打印类型：URL_PDF，打印机：${deviceName}，页数：${
              data.pageNum
            }`,
          );
          if (socket) {
            const result = {
              msg: "打印成功",
              templateId: data.templateId,
              replyId: data.replyId,
            };
            socket.emit("successs", result); // 兼容 vue-plugin-hiprint 0.0.56 之前包
            socket.emit("success", result);
          }
          logPrintResult("success");
        })
        .catch((err) => {
          log(
            `${data.replyId ? "中转服务" : "插件端"} ${socket.id} 模板 【${
              data.templateId
            }】 打印失败，打印类型：URL_PDF，打印机：${deviceName}，原因：${
              err.message
            }`,
          );
          socket &&
            socket.emit("error", {
              msg: "打印失败: " + err.message,
              templateId: data.templateId,
              replyId: data.replyId,
            });
          logPrintResult("failure", err.message);
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
        dpi: data.dpi, // 打印机DPI
        header: data.header, // 打印头
        footer: data.footer, // 打印尾
        pageSize: data.pageSize, // 打印纸张
      },
      (success, failureReason) => {
        if (success) {
          var printTime = (new Date().getTime()) - st;
          log(
            `${data.replyId ? "中转服务" : "插件端"} ${socket?.id} 模板 【${
              data.templateId
            }】 打印成功，打印类型 HTML，打印机：${deviceName}，页数：${
              data.pageNum
            }，time: ${printTime}`,
          );
          logPrintResult("success");
        } else {
          log(
            `${data.replyId ? "中转服务" : "插件端"} ${socket?.id} 模板 【${
              data.templateId
            }】 打印失败，打印类型 HTML，打印机：${deviceName}，原因：${failureReason}`,
          );
          logPrintResult("failure", failureReason);
        }
        if (socket) {
          if (success) {
            const result = {
              msg: "打印成功",
              templateId: data.templateId,
              replyId: data.replyId,
            };
            socket.emit("successs", result); // 兼容 vue-plugin-hiprint 0.0.56 之前包
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

module.exports = async () => {
  // 创建打印窗口
  await createPrintWindow();
};
