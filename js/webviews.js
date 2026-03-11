var urlParser = require('util/urlParser.js')
var settings = require('util/settings/settings.js')
const { ipcRenderer } = require('electron')

/* implements selecting webviews, switching between them, and creating new ones. */

var placeholderImg = document.getElementById('webview-placeholder')

var hasSeparateTitlebar = settings.get('useSeparateTitlebar')
var windowIsMaximized = false // affects navbar height on Windows
var windowIsFullscreen = false

function captureCurrentTab(options) {
  if (tabs.get(tabs.getSelected()).private) {
    // don't capture placeholders for private tabs
    return
  }

  if (webviews.placeholderRequests.length > 0 && !(options && options.forceCapture === true)) {
    // capturePage doesn't work while the view is hidden
    return
  }

  ipc.send('getCapture', {
    id: webviews.selectedId,
    width: Math.round(window.innerWidth / 10),
    height: Math.round(window.innerHeight / 10)
  })
}

// V2 DNN hostname detection using full BIP39 wordlist
const bip39WordsForDNN = require('./util/bip39words.js')

function matchBIP39Word(str) {
  const maxLen = Math.min(8, str.length)
  for (let len = maxLen; len >= 3; len--) {
    if (bip39WordsForDNN.has(str.slice(0, len))) return str.slice(0, len)
  }
  return null
}

// Helper to check if hostname is a DNN pattern (V2 format)
function isDNNHostname(hostname) {
  if (!hostname || hostname.length < 8) return false
  const parts = hostname.toLowerCase().split('.')
  const tld = parts[parts.length - 1]
  if (!tld.startsWith('n') || tld.length < 8) return false
  let rest = tld.slice(1)
  const w1 = matchBIP39Word(rest)
  if (!w1) return false
  rest = rest.slice(w1.length)
  const w2 = matchBIP39Word(rest)
  if (!w2) return false
  rest = rest.slice(w2.length)
  return rest && /^\d*[a-z]+$/.test(rest)
}

// Map tab IDs to their DNN names (for URL display override)
const tabDnnMap = new Map()

// Expose globally so viewManager can set it
if (typeof window !== 'undefined') {
  window.tabDnnMap = tabDnnMap
}

// IPC handler for main process to set tab-DNN mapping
ipcRenderer.on('set-tab-dnn-mapping', (e, data) => {
  console.log('[DNN URL] Received tab-DNN mapping:', data)
  tabDnnMap.set(data.tabId, data.dnnName)
})

// IPC handler for DNN certificate status updates
ipcRenderer.on('dnn-cert-status', (e, data) => {
  console.log('[DNN URL] Received cert status:', data)
  // Find all tabs with this DNN name and update their secure status
  tabs.get().forEach(tab => {
    const storedDnn = tabDnnMap.get(tab.id) || tab.dnnName
    if (storedDnn && storedDnn.toLowerCase() === data.dnnName.toLowerCase()) {
      tabs.update(tab.id, {
        secure: data.certVerified
      })
      console.log(`[DNN URL] Updated tab ${tab.id} secure status to: ${data.certVerified}`)
    }
  })
})

// called whenever a new page starts loading, or an in-page navigation occurs
function onPageURLChange(tab, url) {
  // Check for secure protocols
  let hostname = ''
  let port = ''
  try {
    const urlObj = new URL(url)
    hostname = urlObj.hostname
    port = urlObj.port || '443'
  } catch (e) { }

  const isDNN = isDNNHostname(hostname)

  // Check if this IP maps to a DNN name
  let dnnName = null
  let displayUrl = url
  let certVerified = false

  // If it's an IP address, check if we have a DNN mapping for it
  if (!isDNN && /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    // Check tabDnnMap first (set by viewManager when loading DNN URL)
    if (tabDnnMap.has(tab)) {
      dnnName = tabDnnMap.get(tab)
    }
    // Also try to get from ipcRenderer
    if (!dnnName) {
      try {
        // Ask main process for DNN name mapping
        const result = ipcRenderer.sendSync('getDnnNameForIp', { ip: hostname, port: port })
        if (result && result.dnnName) {
          dnnName = result.dnnName
          tabDnnMap.set(tab, dnnName)
        }
      } catch (e) {
        // IPC not available or error
      }
    }

    if (dnnName) {
      // Replace IP in URL with DNN name for display
      try {
        const urlObj = new URL(url)
        urlObj.hostname = dnnName
        urlObj.port = '' // DNN URLs don't show port
        displayUrl = urlObj.toString()
        console.log(`[DNN URL] Tab ${tab}: IP ${hostname} -> DNN ${dnnName}, display: ${displayUrl}`)
      } catch (e) {
        // URL reconstruction failed
      }

      // Get cert status from main process
      try {
        const certResult = ipcRenderer.sendSync('getDnnCertStatus', { dnnName: dnnName })
        if (certResult && certResult.certVerified !== undefined) {
          certVerified = certResult.certVerified
          console.log(`[DNN URL] Tab ${tab}: Got cert status for ${dnnName}: ${certVerified}`)
        }
      } catch (e) {
        console.log(`[DNN URL] Tab ${tab}: Could not get cert status for ${dnnName}`)
      }
    }
  }

  // For direct DNN hostnames, also get cert status
  if (isDNN) {
    try {
      const certResult = ipcRenderer.sendSync('getDnnCertStatus', { dnnName: hostname })
      if (certResult && certResult.certVerified !== undefined) {
        certVerified = certResult.certVerified
        console.log(`[DNN URL] Tab ${tab}: Got cert status for ${hostname}: ${certVerified}`)
      }
    } catch (e) {
      // IPC not available
    }
  }

  if (isDNN || dnnName) {
    // DNN URLs - use the cert verification status we got
    tabs.update(tab, {
      secure: certVerified,
      url: displayUrl,
      dnnName: dnnName || hostname // Store real DNN name
    })
  } else if (url.indexOf('min://app/pages/dnn-warning/') === 0) {
    // DNN warning page - show insecure and extract original URL for display
    try {
      const urlObj = new URL(url)
      const originalUrl = urlObj.searchParams.get('url')
      if (originalUrl) {
        const origUrlObj = new URL(originalUrl)
        tabs.update(tab, {
          secure: false,
          url: originalUrl,
          dnnName: origUrlObj.hostname || null
        })
      } else {
        tabs.update(tab, {
          secure: false,
          url: url
        })
      }
    } catch (e) {
      tabs.update(tab, {
        secure: false,
        url: url
      })
    }
  } else if (url.indexOf('https://') === 0 || url.indexOf('about:') === 0 || url.indexOf('chrome:') === 0 || url.indexOf('file://') === 0 || url.indexOf('min://') === 0) {
    tabs.update(tab, {
      secure: true,
      url: url
    })
  } else {
    tabs.update(tab, {
      secure: false,
      url: url
    })
  }

  webviews.callAsync(tab, 'setVisualZoomLevelLimits', [1, 3])
}

// called whenever a navigation finishes
function onNavigate(tabId, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId) {
  if (isMainFrame) {
    onPageURLChange(tabId, url)
  }
}

// called whenever the page finishes loading
function onPageLoad(tabId) {
  // capture a preview image if a new page has been loaded
  if (tabId === tabs.getSelected()) {
    setTimeout(function () {
      // sometimes the page isn't visible until a short time after the did-finish-load event occurs
      captureCurrentTab()
    }, 250)
  }
}

function scrollOnLoad(tabId, scrollPosition) {
  const listener = function (eTabId) {
    if (eTabId === tabId) {
      // the scrollable content may not be available until some time after the load event, so attempt scrolling several times
      // but stop once we've successfully scrolled once so we don't overwrite user scroll attempts that happen later
      for (let i = 0; i < 3; i++) {
        var done = false
        setTimeout(function () {
          if (!done) {
            webviews.callAsync(tabId, 'executeJavaScript', `
            (function() {
              window.scrollTo(0, ${scrollPosition})
              return window.scrollY === ${scrollPosition}
            })()
            `, function (err, completed) {
              if (!err && completed) {
                done = true
              }
            })
          }
        }, 750 * i)
      }
      webviews.unbindEvent('did-finish-load', listener)
    }
  }
  webviews.bindEvent('did-finish-load', listener)
}

function setAudioMutedOnCreate(tabId, muted) {
  const listener = function () {
    webviews.callAsync(tabId, 'setAudioMuted', muted)
    webviews.unbindEvent('did-navigate', listener)
  }
  webviews.bindEvent('did-navigate', listener)
}

const webviews = {
  viewFullscreenMap: {}, // tabId, isFullscreen
  selectedId: null,
  placeholderRequests: [],
  asyncCallbacks: {},
  internalPages: {
    error: 'min://app/pages/error/index.html'
  },
  events: [],
  IPCEvents: [],
  hasViewForTab: function (tabId) {
    return tabId && tasks.getTaskContainingTab(tabId) && tasks.getTaskContainingTab(tabId).tabs.get(tabId).hasWebContents
  },
  bindEvent: function (event, fn) {
    webviews.events.push({
      event: event,
      fn: fn
    })
  },
  unbindEvent: function (event, fn) {
    for (var i = 0; i < webviews.events.length; i++) {
      if (webviews.events[i].event === event && webviews.events[i].fn === fn) {
        webviews.events.splice(i, 1)
        i--
      }
    }
  },
  emitEvent: function (event, tabId, args) {
    if (!webviews.hasViewForTab(tabId)) {
      // the view could have been destroyed between when the event was occured and when it was recieved in the UI process, see https://github.com/minbrowser/min/issues/604#issuecomment-419653437
      return
    }
    webviews.events.forEach(function (ev) {
      if (ev.event === event) {
        ev.fn.apply(this, [tabId].concat(args))
      }
    })
  },
  bindIPC: function (name, fn) {
    webviews.IPCEvents.push({
      name: name,
      fn: fn
    })
  },
  viewMargins: [0, 0, 0, 0], // top, right, bottom, left
  adjustMargin: function (margins) {
    for (var i = 0; i < margins.length; i++) {
      webviews.viewMargins[i] += margins[i]
    }
    webviews.resize()
  },
  getViewBounds: function () {
    if (webviews.viewFullscreenMap[webviews.selectedId]) {
      return {
        x: 0,
        y: 0,
        width: window.innerWidth,
        height: window.innerHeight
      }
    } else {
      if (!hasSeparateTitlebar && (window.platformType === 'linux' || window.platformType === 'windows') && !windowIsMaximized && !windowIsFullscreen) {
        var navbarHeight = 48
      } else {
        var navbarHeight = 36
      }

      const viewMargins = webviews.viewMargins

      let position = {
        x: 0 + Math.round(viewMargins[3]),
        y: 0 + Math.round(viewMargins[0]) + navbarHeight,
        width: window.innerWidth - Math.round(viewMargins[1] + viewMargins[3]),
        height: window.innerHeight - Math.round(viewMargins[0] + viewMargins[2]) - navbarHeight
      }

      return position
    }
  },
  add: function (tabId, existingViewId) {
    var tabData = tabs.get(tabId)

    // needs to be called before the view is created to that its listeners can be registered
    if (tabData.scrollPosition) {
      scrollOnLoad(tabId, tabData.scrollPosition)
    }

    if (tabData.muted) {
      setAudioMutedOnCreate(tabId, tabData.muted)
    }

    // if the tab is private, we want to partition it. See http://electron.atom.io/docs/v0.34.0/api/web-view-tag/#partition
    // since tab IDs are unique, we can use them as partition names
    if (tabData.private === true) {
      var partition = tabId.toString() // options.tabId is a number, which remote.session.fromPartition won't accept. It must be converted to a string first
    }

    ipc.send('createView', {
      existingViewId,
      id: tabId,
      webPreferences: {
        partition: partition || 'persist:webcontent'
      },
      boundsString: JSON.stringify(webviews.getViewBounds()),
      events: webviews.events.map(e => e.event).filter((i, idx, arr) => arr.indexOf(i) === idx)
    })

    if (!existingViewId) {
      if (tabData.url) {
        ipc.send('loadURLInView', { id: tabData.id, url: urlParser.parse(tabData.url) })
      } else if (tabData.private) {
        // workaround for https://github.com/minbrowser/min/issues/872
        ipc.send('loadURLInView', { id: tabData.id, url: urlParser.parse('min://newtab') })
      }
    }

    tasks.getTaskContainingTab(tabId).tabs.update(tabId, {
      hasWebContents: true
    })
  },
  setSelected: function (id, options) { // options.focus - whether to focus the view. Defaults to true.
    webviews.emitEvent('view-hidden', webviews.selectedId)

    webviews.selectedId = id

    // create the view if it doesn't already exist
    if (!webviews.hasViewForTab(id)) {
      webviews.add(id)
    }

    if (webviews.placeholderRequests.length > 0) {
      // update the placeholder instead of showing the actual view
      webviews.requestPlaceholder()
      return
    }

    ipc.send('setView', {
      id: id,
      bounds: webviews.getViewBounds(),
      focus: !options || options.focus !== false
    })
    webviews.emitEvent('view-shown', id)
  },
  update: function (id, url) {
    ipc.send('loadURLInView', { id: id, url: urlParser.parse(url) })
  },
  destroy: function (id) {
    webviews.emitEvent('view-hidden', id)

    if (webviews.hasViewForTab(id)) {
      tasks.getTaskContainingTab(id).tabs.update(id, {
        hasWebContents: false
      })
    }
    //we may be destroying a view for which the tab object no longer exists, so this message should be sent unconditionally
    ipc.send('destroyView', id)

    delete webviews.viewFullscreenMap[id]
    if (webviews.selectedId === id) {
      webviews.selectedId = null
    }
  },
  requestPlaceholder: function (reason) {
    if (reason && !webviews.placeholderRequests.includes(reason)) {
      webviews.placeholderRequests.push(reason)
    }
    if (webviews.placeholderRequests.length >= 1) {
      // create a new placeholder

      var associatedTab = tasks.getTaskContainingTab(webviews.selectedId).tabs.get(webviews.selectedId)
      var img = associatedTab.previewImage
      if (img) {
        placeholderImg.src = img
        placeholderImg.hidden = false
      } else if (associatedTab && associatedTab.url) {
        captureCurrentTab({ forceCapture: true })
      } else {
        placeholderImg.hidden = true
      }
    }
    setTimeout(function () {
      // wait to make sure the image is visible before the view is hidden
      // make sure the placeholder was not removed between when the timeout was created and when it occurs
      if (webviews.placeholderRequests.length > 0) {
        ipc.send('hideCurrentView')
        webviews.emitEvent('view-hidden', webviews.selectedId)
      }
    }, 0)
  },
  hidePlaceholder: function (reason) {
    if (webviews.placeholderRequests.includes(reason)) {
      webviews.placeholderRequests.splice(webviews.placeholderRequests.indexOf(reason), 1)
    }

    if (webviews.placeholderRequests.length === 0) {
      // multiple things can request a placeholder at the same time, but we should only show the view again if nothing requires a placeholder anymore
      if (webviews.hasViewForTab(webviews.selectedId)) {
        ipc.send('setView', {
          id: webviews.selectedId,
          bounds: webviews.getViewBounds(),
          focus: true
        })
        webviews.emitEvent('view-shown', webviews.selectedId)
      }
      // wait for the view to be visible before removing the placeholder
      setTimeout(function () {
        if (webviews.placeholderRequests.length === 0) { // make sure the placeholder hasn't been re-enabled
          placeholderImg.hidden = true
        }
      }, 400)
    }
  },
  releaseFocus: function () {
    ipc.send('focusMainWebContents')
  },
  focus: function () {
    if (webviews.selectedId) {
      ipc.send('focusView', webviews.selectedId)
    }
  },
  resize: function () {
    ipc.send('setBounds', { id: webviews.selectedId, bounds: webviews.getViewBounds() })
  },
  goBackIgnoringRedirects: async function (id) {
    const navHistory = await webviews.getNavigationHistory(id)
    // If the current page is an internal page resulting from a redirect (error pages or reader mode), go back two pages

    var url = navHistory.entries[navHistory.activeIndex].url

    if (urlParser.isInternalURL(url) && navHistory.activeIndex > 1 && navHistory.entries[navHistory.activeIndex - 1].url === urlParser.getSourceURL(url)) {
      webviews.callAsync(id, 'canGoToOffset', -2, function (err, result) {
        if (!err && result === true) {
          webviews.callAsync(id, 'goToOffset', -2)
        } else {
          webviews.callAsync(id, 'goBack')
        }
      })
    } else {
      webviews.callAsync(id, 'goBack')
    }
  },
  /*
  Can be called as
  callAsync(id, method, args, callback) -> invokes method with args, runs callback with (err, result)
  callAsync(id, method, callback) -> invokes method with no args, runs callback with (err, result)
  callAsync(id, property, value, callback) -> sets property to value
  callAsync(id, property, callback) -> reads property, runs callback with (err, result)
   */
  callAsync: function (id, method, argsOrCallback, callback) {
    var args = argsOrCallback
    var cb = callback
    if (argsOrCallback instanceof Function && !cb) {
      args = []
      cb = argsOrCallback
    }
    if (!(args instanceof Array)) {
      args = [args]
    }
    if (cb) {
      var callId = Math.random()
      webviews.asyncCallbacks[callId] = cb
    }
    ipc.send('callViewMethod', { id: id, callId: callId, method: method, args: args })
  },
  getNavigationHistory: function (id) {
    return ipc.invoke('getNavigationHistory', id)
  }
}

window.addEventListener('resize', throttle(function () {
  if (webviews.placeholderRequests.length > 0) {
    // can't set view bounds if the view is hidden
    return
  }
  webviews.resize()
}, 75))

// leave HTML fullscreen when leaving window fullscreen
ipc.on('leave-full-screen', function () {
  // electron normally does this automatically (https://github.com/electron/electron/pull/13090/files), but it doesn't work for BrowserViews
  for (var view in webviews.viewFullscreenMap) {
    if (webviews.viewFullscreenMap[view]) {
      webviews.callAsync(view, 'executeJavaScript', 'document.exitFullscreen()')
    }
  }
})

webviews.bindEvent('enter-html-full-screen', function (tabId) {
  webviews.viewFullscreenMap[tabId] = true
  webviews.resize()
})

webviews.bindEvent('leave-html-full-screen', function (tabId) {
  webviews.viewFullscreenMap[tabId] = false
  webviews.resize()
})

ipc.on('maximize', function () {
  windowIsMaximized = true
  webviews.resize()
})

ipc.on('unmaximize', function () {
  windowIsMaximized = false
  webviews.resize()
})

ipc.on('enter-full-screen', function () {
  windowIsFullscreen = true
  webviews.resize()
})

ipc.on('leave-full-screen', function () {
  windowIsFullscreen = false
  webviews.resize()
})

webviews.bindEvent('did-start-navigation', onNavigate)
webviews.bindEvent('will-redirect', onNavigate)
webviews.bindEvent('did-navigate', function (tabId, url, httpResponseCode, httpStatusText) {
  onPageURLChange(tabId, url)
})

webviews.bindEvent('did-finish-load', onPageLoad)

webviews.bindEvent('page-title-updated', function (tabId, title, explicitSet) {
  tabs.update(tabId, {
    title: title
  })
})

webviews.bindEvent('did-fail-load', function (tabId, errorCode, errorDesc, validatedURL, isMainFrame) {
  if (errorCode && errorCode !== -3 && isMainFrame && validatedURL) {
    webviews.update(tabId, webviews.internalPages.error + '?ec=' + encodeURIComponent(errorCode) + '&url=' + encodeURIComponent(validatedURL))
  }
})

webviews.bindEvent('crashed', function (tabId, isKilled) {
  var url = tabs.get(tabId).url

  tabs.update(tabId, {
    url: webviews.internalPages.error + '?ec=crash&url=' + encodeURIComponent(url)
  })

  // the existing process has crashed, so we can't reuse it
  webviews.destroy(tabId)
  webviews.add(tabId)

  if (tabId === tabs.getSelected()) {
    webviews.setSelected(tabId)
  }
})

webviews.bindIPC('getSettingsData', function (tabId, args) {
  if (!urlParser.isInternalURL(tabs.get(tabId).url)) {
    throw new Error()
  }
  webviews.callAsync(tabId, 'send', ['receiveSettingsData', settings.list])
})
webviews.bindIPC('setSetting', function (tabId, args) {
  if (!urlParser.isInternalURL(tabs.get(tabId).url)) {
    throw new Error()
  }
  settings.set(args[0].key, args[0].value)
})

settings.listen(function () {
  tasks.forEach(function (task) {
    task.tabs.forEach(function (tab) {
      if (tab.url.startsWith('min://')) {
        try {
          webviews.callAsync(tab.id, 'send', ['receiveSettingsData', settings.list])
        } catch (e) {
          // webview might not actually exist
        }
      }
    })
  })
})

webviews.bindIPC('scroll-position-change', function (tabId, args) {
  tabs.update(tabId, {
    scrollPosition: args[0]
  })
})

webviews.bindIPC('downloadFile', function (tabId, args) {
  if (tabs.get(tabId).url.startsWith('min://')) {
    webviews.callAsync(tabId, 'downloadURL', [args[0]])
  }
})

ipc.on('view-event', function (e, args) {
  webviews.emitEvent(args.event, args.tabId, args.args)
})

ipc.on('async-call-result', function (e, args) {
  webviews.asyncCallbacks[args.callId](args.error, args.result)
  delete webviews.asyncCallbacks[args.callId]
})

ipc.on('view-ipc', function (e, args) {
  if (!webviews.hasViewForTab(args.id)) {
    // the view could have been destroyed between when the event was occured and when it was recieved in the UI process, see https://github.com/minbrowser/min/issues/604#issuecomment-419653437
    return
  }
  webviews.IPCEvents.forEach(function (item) {
    if (item.name === args.name) {
      item.fn(args.id, [args.data], args.frameId, args.frameURL)
    }
  })
})

setInterval(function () {
  captureCurrentTab()
}, 15000)

ipc.on('captureData', function (e, data) {
  tabs.update(data.id, { previewImage: data.url })
  if (data.id === webviews.selectedId && webviews.placeholderRequests.length > 0) {
    placeholderImg.src = data.url
    placeholderImg.hidden = false
  }
})

/* focus the view when the window is focused */

ipc.on('windowFocus', function () {
  if (webviews.placeholderRequests.length === 0 && document.activeElement.tagName !== 'INPUT') {
    webviews.focus()
  }
})

/* DNN certificate verification status - updates lock icon for DNN URLs */
ipcRenderer.on('dnn-cert-status', function (e, data) {
  try {
    // Send confirmation back to main process (visible in terminal)
    ipcRenderer.send('dnn-ipc-received', { received: data.dnnName, verified: data.certVerified })

    // Find the tab with this EXACT DNN URL hostname
    let matchingTab = null
    let matchingTask = null

    tasks.forEach(function (task) {
      task.tabs.forEach(function (tab) {
        const tabUrl = tab.url || ''
        try {
          const urlObj = new URL(tabUrl)
          const tabHostname = urlObj.hostname.toLowerCase()
          const certHostname = data.dnnName.toLowerCase()

          // Check if tab hostname matches the cert hostname
          // DNN URLs now use https:// with DNN hostnames
          if (isDNNHostname(tabHostname) && tabHostname === certHostname) {
            matchingTab = tab
            matchingTask = task
          }
        } catch (urlErr) {
          // URL parsing failed, skip
        }
      })
    })

    if (matchingTab && matchingTask) {
      ipcRenderer.send('dnn-ipc-received', { action: 'found', tabId: matchingTab.id, url: matchingTab.url, secure: matchingTab.secure })

      matchingTask.tabs.update(matchingTab.id, { secure: data.certVerified })

      var tabBar = require('navbar/tabBar.js')
      tabBar.updateTab(matchingTab.id)

      ipcRenderer.send('dnn-ipc-received', { action: 'updated', tabId: matchingTab.id, newSecure: data.certVerified })
    } else {
      ipcRenderer.send('dnn-ipc-received', { action: 'no-match', searchFor: data.dnnName })
    }
  } catch (err) {
    ipcRenderer.send('dnn-ipc-received', { error: err.message, stack: err.stack })
  }
})

module.exports = webviews

