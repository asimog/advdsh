'use strict';

// Runs inside each same-origin editor iframe before its own scripts. The editor
// iframe navigates to its own document, so the desktop API must be copied into
// the new window.
(function () {
  try {
    if (window.parent === window) return
    var parentApi = window.parent.AscDesktopEditor
    if (!parentApi) return
    window.AscDesktopEditor = parentApi
    window.desktop = parentApi
    if (!window.RendererProcessVariable) {
      window.RendererProcessVariable = { theme: { system: 'disabled' }, localthemes: {} }
    }
  } catch (error) {
    // Cross-origin frame: nothing to inject.
  }
})()
