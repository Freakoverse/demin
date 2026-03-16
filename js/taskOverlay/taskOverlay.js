/* Task overlay disabled — Chrome-style single tab group mode */

const keybindings = require('keybindings.js')

var taskOverlay = {
  isShown: false,
  show: function () { /* no-op */ },
  hide: function () { /* no-op */ },
  toggle: function () { /* no-op */ },
  render: function () { /* no-op */ },
  initialize: function () {
    // Keep the toggleTasks shortcut defined but make it a no-op
    // so existing keybinding references don't error
    keybindings.defineShortcut('toggleTasks', function () { /* no-op */ })
    keybindings.defineShortcut('addTask', function () { /* no-op */ })
  }
}

module.exports = taskOverlay
