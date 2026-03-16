const punycode = require('punycode')
const path = require('path')

const searchEngine = require('util/searchEngine.js')
const hosts = require('./hosts.js')
const httpsTopSites = require('../../ext/httpsUpgrade/httpsTopSites.json')
const publicSuffixes = require('../../ext/publicSuffixes/public_suffix_list.json')
const bip39Words = require('./bip39words.js')

// DNN (Decentralized Naming Network) configuration
// Seed nodes as fallback when IPC to main process is unavailable
const DNN_SEED_NODES = [
  'https://node.icannot.xyz',
  'http://64.111.92.122:8080'
]
const DNN_CACHE = new Map() // Cache resolved DNN names

// Get the best available DNN node list:
// 1. Try IPC to get dynamic nodes from main process (peer discovery module)
// 2. Fall back to hardcoded seed nodes
function getDNNNodes() {
  try {
    const { ipcRenderer } = require('electron')
    if (ipcRenderer) {
      const nodes = ipcRenderer.sendSync('getDnnNodes')
      if (nodes && nodes.length > 0) {
        return nodes
      }
    }
  } catch (e) {
    // IPC not available (e.g., during tests or early startup)
  }
  return DNN_SEED_NODES
}

// Match the longest BIP39 word at the start of a string (greedy, longest first).
// Returns the matched word or null.
function matchBIP39WordFromStart(str) {
  if (!str || str.length < 3) return null
  const maxLen = Math.min(8, str.length)
  for (let len = maxLen; len >= 3; len--) {
    const candidate = str.slice(0, len).toLowerCase()
    if (bip39Words.has(candidate)) {
      return candidate
    }
  }
  return null
}

// Check if a string looks like a DNN name
// Supports multiple formats:
// 1. V2 encoded format: n + BIP39word + BIP39word + optional cycle digits + position letters
//    Examples: nabandonzooa, ndieseljazzas, nabandon1areab
// 2. DNN block format with position: n4.8, n5h.1 (must have .{number} at end)
// 3. Bitcoin block format with position: b922664.8, b1m50.1 (must have .{number} at end)
// 4. Subdomains: freakoverse.nabandonzooa, alice.n4.8
function isDNNName(name) {
  if (!name || name.length < 4) return false

  // Spaces mean it's a search query, not a domain
  if (name.indexOf(' ') >= 0) return false

  // Remove trailing dot if present (FQDN format)
  name = name.endsWith('.') ? name.slice(0, -1) : name

  // Split by dots to analyze the parts  
  const parts = name.split('.')

  // Check if this ends with a position number (like .8 in n4.8)
  const lastPart = parts[parts.length - 1]
  const hasPositionSuffix = /^[0-9]+$/.test(lastPart)

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].toLowerCase()
    const nextPart = parts[i + 1]

    // Pattern 1: DNN/Bitcoin block format WITH position suffix
    // Examples: n4.8, b922664.8, n5h.1, b1m50.3
    // These are safe to detect because .{number} is not a valid TLD
    if ((part.charAt(0) === 'n' || part.charAt(0) === 'b') && /^\d/.test(part.charAt(1))) {
      const rest = part.slice(1)
      if (/^[0-9hkmbtqdsop]+$/i.test(rest)) {
        // Must have position suffix to be auto-detected (e.g., n4.8 not just n4)
        if (hasPositionSuffix && nextPart && /^[0-9]+$/.test(nextPart)) {
          console.log('[DNN] Matched block+position format:', name)
          return true
        }
        // Without position, only if it's a subdomain pattern (e.g., name.n4 not just n4)
        if (i > 0 && !nextPart) {
          console.log('[DNN] Matched subdomain.block format:', name)
          return true
        }
      }
    }

    // Pattern 2: V2 encoded format with two BIP39 words
    // Must start with 'n', then two consecutive BIP39 words, optional cycle digits, position letters
    // Examples: nabandonzooa, ndieseljazzas
    if (part.charAt(0) === 'n' && part.length >= 8) {
      let rest = part.slice(1)
      const word1 = matchBIP39WordFromStart(rest)
      if (word1) {
        rest = rest.slice(word1.length)
        const word2 = matchBIP39WordFromStart(rest)
        if (word2) {
          rest = rest.slice(word2.length)
          // Remaining: optional cycle digits + one or more position letters
          if (rest && /^\d*[a-z]+$/.test(rest)) {
            console.log('[DNN] Matched V2 encoded format:', part, 'words:', word1 + '+' + word2)
            return true
          }
        }
      }
    }
  }

  console.log('[DNN] No DNN pattern matched for:', name)
  return false
}

// Check if a DNN address needs the /resolve/ path format
// Returns true for addresses ending in .{number} (position-based like n4.8, b922664.8)
// These need dnn://resolve/ because the hostname would be invalid for URL parsing
function needsResolvePath(name) {
  if (!name) return false
  name = name.endsWith('.') ? name.slice(0, -1) : name
  const parts = name.split('.')
  // Check if last part is all digits (position number)
  return parts.length >= 2 && /^[0-9]+$/.test(parts[parts.length - 1])
}

// Synchronously get cached DNN resolution, or return null
function getCachedDNNResolution(name) {
  name = name.endsWith('.') ? name.slice(0, -1) : name
  return DNN_CACHE.get(name.toLowerCase())
}

// Async function to resolve DNN name with fallback across nodes
// Uses dynamic node list from main process peer discovery when available
async function resolveDNNAsync(name) {
  name = name.endsWith('.') ? name.slice(0, -1) : name
  const cacheKey = name.toLowerCase()

  // Get dynamic nodes from main process peer discovery, or fall back to seeds
  const nodes = getDNNNodes()

  // Try each node until one works
  for (const nodeURL of nodes) {
    try {
      const response = await fetch(`${nodeURL}/dnn/resolve/${name}`)
      if (!response.ok) continue

      const data = await response.json()

      // Extract the IP from connection records
      if (data.connection && data.connection.records) {
        const aRecord = data.connection.records.find(r => r.type === 'A')
        if (aRecord) {
          // records have 'values' array, not 'value'
          const ip = aRecord.values ? aRecord.values[0] : aRecord.value
          if (ip) {
            // For IP addresses, always use HTTP (self-signed certs don't work in Chromium)
            const isIPAddress = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)
            const protocol = isIPAddress ? 'http' : 'https'
            const resolved = `${protocol}://${ip}`
            DNN_CACHE.set(cacheKey, { url: resolved, data: data })
            console.log(`[DNN] Resolved ${name} via ${nodeURL}`)
            return resolved
          }
        }
      }
    } catch (e) {
      console.log(`[DNN] Node ${nodeURL} failed for ${name}: ${e.message}`)
      continue
    }
  }

  // All nodes failed
  console.error('[DNN] All nodes failed to resolve:', name)
  DNN_CACHE.set(cacheKey, { error: true })
  return null
}

function removeWWW(domain) {
  return (domain.startsWith('www.') ? domain.slice(4) : domain)
}
function removeTrailingSlash(url) {
  return (url.endsWith('/') ? url.slice(0, -1) : url)
}

var urlParser = {
  validIP4Regex: /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/i,
  validDomainRegex: /^(?!-)(?:.*@)*?([a-z0-9-._]+[a-z0-9]|\[[:a-f0-9]+\])/i,
  unicodeRegex: /[^\u0000-\u00ff]/,
  removeProtocolRegex: /^(https?|file):\/\//i,
  protocolRegex: /^[a-z0-9]+:\/\//, // URI schemes can be alphanum
  isURL: function (url) {
    return urlParser.protocolRegex.test(url) || url.indexOf('about:') === 0 || url.indexOf('chrome:') === 0 || url.indexOf('data:') === 0
  },
  isPossibleURL: function (url) {
    if (urlParser.isURL(url)) {
      return true
    } else {
      if (url.indexOf(' ') >= 0) {
        return false
      }
    }

    const domain = urlParser.getDomain(url)
    return hosts.includes(domain)
  },
  removeProtocol: function (url) {
    if (!urlParser.isURL(url)) {
      return url
    }

    /*
    Protocols removed: http:/https:/file:
    chrome:, about:, data: protocols intentionally not removed
    */
    return url.replace(urlParser.removeProtocolRegex, '')
  },
  isURLMissingProtocol: function (url) {
    return !urlParser.protocolRegex.test(url)
  },
  parse: function (url) {
    url = url.trim() // remove whitespace common on copy-pasted url's

    if (!url) {
      return 'about:blank'
    }

    if (url.indexOf('view-source:') === 0) {
      var realURL = url.replace('view-source:', '')

      return 'view-source:' + urlParser.parse(realURL)
    }

    if (url.startsWith('min:') && !url.startsWith('min://app/')) {
      // convert shortened min:// urls to full ones
      const urlChunks = url.split('?')[0].replace(/min:(\/\/)?/g, '').split('/')
      const query = url.split('?')[1]
      return 'min://app/pages/' + urlChunks[0] + (urlChunks[1] ? urlChunks.slice(1).join('/') : '/index.html') + (query ? '?' + query : '')
    }

    // if the url starts with a (supported) protocol
    if (urlParser.isURL(url)) {
      if (!urlParser.isInternalURL(url) && url.startsWith('http://')) {
        // prefer HTTPS over HTTP
        const noProtoURL = urlParser.removeProtocol(url)

        if (urlParser.isHTTPSUpgreadable(noProtoURL)) {
          return 'https://' + noProtoURL
        }
      }
      return url
    }

    // DNN: Check if this looks like a DNN name (before domain validation)
    // DNN domains use https:// - the browser intercepts and handles resolution
    if (isDNNName(url)) {
      return `https://${url}`
    }

    // if the url doesn't have any protocol and it's a valid domain, default to HTTPS
    if (urlParser.isURLMissingProtocol(url) && urlParser.validateDomain(urlParser.getDomain(url))) {
      return 'https://' + url
    }

    // else, do a search
    return searchEngine.getCurrent().searchURL.replace('%s', encodeURIComponent(url))
  },
  basicURL: function (url) {
    return removeWWW(urlParser.removeProtocol(removeTrailingSlash(url)))
  },
  prettyURL: function (url) {
    try {
      var urlOBJ = new URL(url)
      return removeWWW(removeTrailingSlash(urlOBJ.hostname + urlOBJ.pathname))
    } catch (e) { // URL constructor will throw an error on malformed URLs
      return url
    }
  },
  isInternalURL: function (url) {
    return url.startsWith('min://')
  },
  getSourceURL: function (url) {
    // DNN URLs use https:// now - no special handling needed

    // converts internal URLs (like the PDF viewer or the reader view) to the URL of the page they are displaying
    if (urlParser.isInternalURL(url)) {
      // Check for DNN resolver URL first - return just the DNN name
      if (url.includes('/pages/dnn/')) {
        try {
          var urlObj = new URL(url)
          var dnnName = urlObj.searchParams.get('name')
          if (dnnName) {
            return dnnName // Return just "nabandonzooa" or "freakoverse.nabandonzooa"
          }
        } catch (e) { }
      }
    }

    var representedURL
    try {
      representedURL = new URLSearchParams(new URL(url).search).get('url')
    } catch (e) { }
    if (representedURL) {
      return representedURL
    } else {
      try {
        var pageName = url.match(/\/pages\/([a-zA-Z]+)\//)
        var urlObj = new URL(url)
        if (pageName) {
          return 'min://' + pageName[1] + urlObj.search
        }
      } catch (e) { }
    }
    return url
  },
  getFileURL: function (path) {
    if (window.platformType === 'windows') {
      // convert backslash to forward slash
      path = path.replace(/\\/g, '/')
      // https://blogs.msdn.microsoft.com/ie/2006/12/06/file-uris-in-windows/

      // UNC path?
      if (path.startsWith('//')) {
        return encodeURI('file:' + path)
      } else {
        return encodeURI('file:///' + path)
      }
    } else {
      return encodeURI('file://' + path)
    }
  },
  getDomain: function (url) {
    url = urlParser.removeProtocol(url)
    return url.split(/[/:]/)[0].toLowerCase()
  },
  // primitive domain validation based on RFC1034
  validateDomain: function (domain) {
    domain = urlParser.unicodeRegex.test(domain)
      ? punycode.toASCII(domain)
      : domain

    if (!urlParser.validDomainRegex.test(domain)) {
      return false
    }
    const cleanDomain = RegExp.$1
    if (cleanDomain.length > 255) {
      return false
    }

    // is domain an ipv4/6 or known hostname?
    if ((urlParser.validIP4Regex.test(cleanDomain) || (cleanDomain.startsWith('[') && cleanDomain.endsWith(']'))) ||
      hosts.includes(cleanDomain)) {
      return true
    }
    // it has a public suffix?
    return publicSuffixes.find(s => cleanDomain.endsWith(s)) !== undefined
  },
  isHTTPSUpgreadable: function (url) {
    // TODO: parse and remove all subdomains, only leaving parent domain and tld
    const domain = removeWWW(urlParser.getDomain(url)) // list has no subdomains

    return httpsTopSites.includes(domain)
  },
  removeTextFragment: function (url) {
    try {
      var parsedURL = new URL(url)
      if (parsedURL.hash.startsWith('#:~:text=')) {
        parsedURL.hash = ''
        return parsedURL.toString()
      }
    } catch (e) { }
    return url
  }
}

module.exports = urlParser
