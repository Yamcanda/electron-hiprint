"use strict";
const { app, globalShortcut } = require("electron");

/**
 * 退出应用
 *
 * @return {undefined}
 */
exports.appQuit = function() {
  console.log("==> Electron-hiprint 关闭 <==");
  // 清理全局快捷键
  if (globalShortcut && app.isReady()) {
    globalShortcut.unregisterAll();
  }
  SET_WINDOW && SET_WINDOW.destroy();
  PRINT_WINDOW && PRINT_WINDOW.destroy();
  MAIN_WINDOW && MAIN_WINDOW.destroy();
  APP_TRAY && APP_TRAY.destroy();
  app.quit();
};
