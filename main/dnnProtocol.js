// DNN HTTPS Handler
// Intercepts HTTPS requests for DNN domain names and proxies to resolved IP addresses
// NOTE: net, session, app, protocol are already available globally from main.js

const https = require('https')
const http = require('http')
const tls = require('tls')
const nobleSecp = require('@noble/secp256k1')
const schnorr = nobleSecp.schnorr
const nodeCrypto = require('crypto')
// Configure @noble/secp256k1 v1.x to use Node.js crypto for hashing
nobleSecp.utils.sha256Sync = (...msgs) => {
    const hash = nodeCrypto.createHash('sha256')
    msgs.forEach(m => hash.update(m))
    return Uint8Array.from(hash.digest())
}
// dnnNodeDiscovery is available as a global var (concatenated before this file)

// Start node discovery on module load
dnnNodeDiscovery.start()

// Cache for DNN resolutions (60 second TTL)
const dnnCache = new Map()

// Track verified certificates per domain
const certVerifiedMap = new Map()

// Reverse mapping: IP:port -> DNN name (for cert status matching)
const ipToDnnMap = new Map()

// Track domains that are being resolved (for async coordination)
const pendingResolutions = new Map()

// Clear the DNN cache (for manual refresh)
function clearDNNCache(name = null) {
    if (name) {
        dnnCache.delete(name.toLowerCase())
        certVerifiedMap.delete(name.toLowerCase())
        console.log(`[DNN] Cleared cache for: ${name}`)
    } else {
        dnnCache.clear()
        certVerifiedMap.clear()
        console.log('[DNN] Cleared entire cache')
    }
}

// Expose globally for potential use from renderer
global.clearDNNCache = clearDNNCache

// Request queue for concurrency limiting
const MAX_CONCURRENT_REQUESTS = 6
let activeRequests = 0
const requestQueue = []

// Multi-node resolution constants (mirrors daemon)
const MAX_NODES_PER_SET = 3
const MAX_RETRY_SETS = 3
const PARALLEL_TIMEOUT_MS = 2000 // 2 second timeout per parallel set

// Wrapper for net.fetch with concurrency limiting and timeout
const REQUEST_TIMEOUT_MS = 15000 // 15 second timeout

async function throttledFetch(url, options) {
    return new Promise((resolve, reject) => {
        const execute = async () => {
            activeRequests++
            try {
                // Add timeout to prevent hanging
                const controller = new AbortController()
                const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

                const response = await net.fetch(url, {
                    ...options,
                    signal: controller.signal
                })
                clearTimeout(timeoutId)
                resolve(response)
            } catch (e) {
                if (e.name === 'AbortError') {
                    reject(new Error('Request timeout'))
                } else {
                    reject(e)
                }
            } finally {
                activeRequests--
                // Process next queued request
                if (requestQueue.length > 0) {
                    const next = requestQueue.shift()
                    next()
                }
            }
        }

        if (activeRequests < MAX_CONCURRENT_REQUESTS) {
            execute()
        } else {
            // Queue the request
            requestQueue.push(execute)
        }
    })
}

/**
 * Verify a Nostr event signature (BIP-340 Schnorr)
 * @param {object} event - Nostr event with id, pubkey, sig, created_at, kind, tags, content
 * @returns {boolean} - True if the signature is valid
 */
function verifyNostrEvent(event) {
    try {
        if (!event || !event.id || !event.pubkey || !event.sig) {
            return false
        }

        // Serialize the event per NIP-01: [0, pubkey, created_at, kind, tags, content]
        const serialized = JSON.stringify([
            0,
            event.pubkey,
            event.created_at,
            event.kind,
            event.tags || [],
            event.content || ''
        ])

        // Hash with SHA-256
        const hash = nodeCrypto.createHash('sha256').update(serialized).digest()

        // Verify the hash matches the event ID
        const computedId = hash.toString('hex')
        if (computedId !== event.id) {
            console.log(`[DNN] Event ID mismatch: computed=${computedId}, event=${event.id}`)
            return false
        }

        // Verify Schnorr signature using verifySync (configured with sha256Sync above)
        const sigBytes = Buffer.from(event.sig, 'hex')
        const pubkeyBytes = Buffer.from(event.pubkey, 'hex')
        return schnorr.verifySync(sigBytes, hash, pubkeyBytes)
    } catch (e) {
        console.log(`[DNN] Signature verification error: ${e.message}`)
        return false
    }
}

/**
 * Query a single node and return the result
 * @param {string} nodeURL - Node URL
 * @param {string} name - Full DNN name (including subdomain)
 * @returns {Promise<object>} - { data, connEvent, domainFound, nodeURL, error }
 */
async function queryNode(nodeURL, name) {
    try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), PARALLEL_TIMEOUT_MS)

        const response = await net.fetch(`${nodeURL}/dnn/resolve/${name}`, {
            signal: controller.signal
        })
        clearTimeout(timeoutId)

        if (!response.ok) {
            return { nodeURL, error: `HTTP ${response.status}` }
        }

        const data = await response.json()

        // Extract connection_event_raw and domain_found
        let connEvent = null
        if (data.connection_event_raw) {
            // Parse if it's a string, otherwise use as-is
            connEvent = typeof data.connection_event_raw === 'string'
                ? JSON.parse(data.connection_event_raw)
                : data.connection_event_raw
        }

        // Default domainFound to true for backwards compatibility
        const domainFound = data.domain_found !== undefined ? data.domain_found : true

        return { data, connEvent, domainFound, nodeURL, error: null }
    } catch (e) {
        return { nodeURL, error: e.message }
    }
}

/**
 * Pick the best result from parallel node responses.
 * Mirrors daemon's pickBestResult logic:
 * 1. Filter errors
 * 2. Verify signatures
 * 3. Check pubkey consistency
 * 4. Pick newest created_at
 * 5. Check domain_found
 * @param {Array} results - Array of queryNode results
 * @returns {object|null} - Best result or null
 */
function pickBestResult(results) {
    // Filter to valid results (no error, has data)
    const validResults = []

    for (const r of results) {
        if (r.error || !r.data) {
            console.log(`[DNN] Skipping node ${r.nodeURL}: ${r.error}`)
            continue
        }

        let createdAt = 0
        let pubkey = null
        let sigValid = false

        if (r.connEvent) {
            // Verify signature
            sigValid = verifyNostrEvent(r.connEvent)
            if (!sigValid) {
                console.log(`[DNN] ✗ Invalid signature from ${r.nodeURL}, discarding`)
                continue
            }
            createdAt = r.connEvent.created_at || 0
            pubkey = r.connEvent.pubkey
            console.log(`[DNN] ✓ Valid signature from ${r.nodeURL} (created_at: ${createdAt})`)
        } else {
            // No raw event — backwards compatibility, treat as created_at=0
            console.log(`[DNN] Node ${r.nodeURL} has no connection_event_raw, using created_at=0`)
        }

        validResults.push({
            ...r,
            createdAt,
            pubkey,
            sigValid
        })
    }

    if (validResults.length === 0) {
        console.log('[DNN] No valid results from any node')
        return null
    }

    // Check pubkey consistency among results that have a pubkey
    const pubkeys = [...new Set(validResults.filter(r => r.pubkey).map(r => r.pubkey))]
    if (pubkeys.length > 1) {
        console.log(`[DNN] ⚠ Pubkey mismatch across nodes: ${pubkeys.join(', ')}`)
        return null
    }

    // Pick the result with the newest created_at
    validResults.sort((a, b) => b.createdAt - a.createdAt)
    const best = validResults[0]

    // If the freshest says domain not found, the domain was removed
    if (!best.domainFound) {
        console.log(`[DNN] Freshest result says domain_found=false (created_at: ${best.createdAt}) — domain was removed`)
        return null
    }

    console.log(`[DNN] Best result from ${best.nodeURL} (created_at: ${best.createdAt}, domain_found: ${best.domainFound})`)
    return best
}

/**
 * Pick N random items from an array (Fisher-Yates shuffle, take N)
 */
function pickRandom(arr, n) {
    const shuffled = [...arr]
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    return shuffled.slice(0, n)
}

/**
 * Fetch the TLS certificate from a server
 * @param {string} host - Hostname or IP
 * @param {number} port - Port number (default 443)
 * @returns {Promise<string|null>} Certificate PEM or null
 */
async function fetchServerCert(host, port = 443) {
    return new Promise((resolve) => {
        const options = {
            host: host,
            port: port,
            rejectUnauthorized: false, // Accept self-signed certs
            timeout: 5000
        }

        const socket = tls.connect(options, () => {
            try {
                const cert = socket.getPeerCertificate(true)
                if (cert && cert.raw) {
                    // Convert DER to PEM
                    const derBuffer = cert.raw
                    const base64 = derBuffer.toString('base64')
                    const pem = `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`
                    socket.destroy()
                    resolve(pem)
                } else {
                    socket.destroy()
                    resolve(null)
                }
            } catch (e) {
                console.error('[DNN] Failed to get server certificate:', e)
                socket.destroy()
                resolve(null)
            }
        })

        socket.on('error', (e) => {
            console.error('[DNN] TLS connection error:', e.message)
            resolve(null)
        })

        socket.on('timeout', () => {
            console.error('[DNN] TLS connection timeout')
            socket.destroy()
            resolve(null)
        })
    })
}

// Import cert verifier (will be concatenated into main.build.js)
// The dnnCertVerify and dnnCertExtractFromConnection functions are made available globally

// V2 DNN pattern detection uses the global bip39Words Set from bip39words.js
// (concatenated before this file in buildMain.js)

/**
 * Try to match the longest BIP39 word at the start of a string.
 * Uses greedy matching (longest first) to avoid ambiguity.
 * Returns the matched word or null.
 */
function matchBIP39WordFromStart(str) {
    // BIP39 words are 3-8 chars. Try longest first for greedy match.
    const maxLen = Math.min(8, str.length)
    for (let len = maxLen; len >= 3; len--) {
        const candidate = str.slice(0, len)
        if (bip39Words.has(candidate)) {
            return candidate
        }
    }
    return null
}

/**
 * Check if a hostname looks like a DNN name (V2 encoded format).
 * V2 format: n{word1}{word2}[{cycle}]{posLetters}
 *   - word1, word2: BIP39 words encoding the block number
 *   - cycle: optional digits (omitted for cycle 0)
 *   - posLetters: bijective base-26 position (a-z, aa-zz, etc.)
 * Also supports subdomains: subdomain.nabandonzooa
 */
function isDNNHostname(hostname) {
    if (!hostname || hostname.length < 8) return false

    // Quick check: contains only alphanumeric and dots
    if (!/^[a-z0-9.]+$/i.test(hostname)) return false

    // Get the TLD (last part, or the DNN name for simple hostnames)
    const parts = hostname.toLowerCase().split('.')
    const tld = parts[parts.length - 1]

    // TLD must start with 'n' and be at least 8 chars (n + 3-char word + 3-char word + 1 pos letter)
    if (!tld.startsWith('n') || tld.length < 8) return false

    // Strip 'n' prefix and try to match two consecutive BIP39 words from the start
    let rest = tld.slice(1)

    const word1 = matchBIP39WordFromStart(rest)
    if (!word1) return false
    rest = rest.slice(word1.length)

    const word2 = matchBIP39WordFromStart(rest)
    if (!word2) return false
    rest = rest.slice(word2.length)

    // Remaining must be: optional cycle digits + one or more position letters
    if (!rest || !/^\d*[a-z]+$/.test(rest)) return false

    console.log(`[DNN] Detected DNN hostname: ${hostname} (words: ${word1}+${word2}, suffix: ${rest})`)
    return true
}

// Resolve a DNN name to get the target URL and cert status
async function resolveDNN(name, forceRefresh = false) {
    // Check cache first (60 second cache for faster change propagation)
    const cached = dnnCache.get(name.toLowerCase())
    if (!forceRefresh && cached && (Date.now() - cached.timestamp < 60000)) { // 60 sec cache
        return {
            ip: cached.ip,
            port: cached.port,
            certVerified: cached.certVerified,
            certError: cached.certError,
            ownerPubkey: cached.ownerPubkey,
            certDnnId: cached.certDnnId
        }
    }

    // Parse the name to find subdomain (if any) BEFORE calling API
    // e.g., "blossom.freakoverse.nabtaabove" -> subdomain="blossom", baseName="freakoverse.nabtaabove"
    // e.g., "freakoverse.nabtaabove" -> subdomain=null, baseName="freakoverse.nabtaabove"
    let subdomain = null
    let baseName = name
    const parts = name.split('.')
    if (parts.length >= 3) {
        // Could be a subdomain - check if the suffix is a DNN name
        const potentialBase = parts.slice(1).join('.')
        if (isDNNHostname(potentialBase)) {
            subdomain = parts[0]
            baseName = potentialBase
            console.log(`[DNN] Detected subdomain: '${subdomain}' of base: '${baseName}'`)
        }
    }

    try {
        // Resolve the full name (including subdomain) so the node can check domain_found
        console.log(`[DNN] Resolving via multi-node parallel: ${name}`)

        // Multi-node parallel resolution with retry sets
        const allNodes = dnnNodeDiscovery.getNodes()
        const usedNodes = new Set()
        let bestResult = null

        for (let set = 0; set < MAX_RETRY_SETS && !bestResult; set++) {
            // Pick up to 3 random unused nodes
            const available = allNodes.filter(n => !usedNodes.has(n))
            if (available.length === 0) break

            const setNodes = pickRandom(available, Math.min(MAX_NODES_PER_SET, available.length))
            setNodes.forEach(n => usedNodes.add(n))

            console.log(`[DNN] Set ${set + 1}: querying ${setNodes.length} nodes in parallel`)

            // Query all nodes in parallel
            const results = await Promise.all(
                setNodes.map(nodeURL => queryNode(nodeURL, name))
            )

            bestResult = pickBestResult(results)
            if (!bestResult) {
                console.log(`[DNN] Set ${set + 1} failed, trying next set...`)
            }
        }

        if (!bestResult) {
            console.log(`[DNN] All node sets failed to resolve: ${name}`)
            return null
        }

        const data = bestResult.data

        // Extract IP from A record - with subdomain support
        if (data.connection && data.connection.records) {

            // Find the right A record
            // Records can be in format: { type: 'A', name: '@', values: ['1.2.3.4'] }
            // or array format from raw data: ["A", "blossom", "96.9.124.48", "3600"]
            let ip = null
            let subdomainIPs = {}

            for (const record of data.connection.records) {
                if (record.type === 'A' || (Array.isArray(record) && record[0] === 'A')) {
                    let recordName, recordIP

                    if (Array.isArray(record)) {
                        // Array format: ["A", "blossom", "96.9.124.48", "3600"]
                        recordName = record[1]
                        recordIP = record[2]
                    } else {
                        // Object format
                        recordName = record.name || '@'
                        recordIP = record.values ? record.values[0] : record.value
                    }

                    if (recordName === '@' || recordName === '' || !recordName) {
                        // Root A record
                        ip = recordIP
                    } else {
                        // Subdomain A record
                        subdomainIPs[recordName.toLowerCase()] = recordIP
                        console.log(`[DNN] Found subdomain A record: ${recordName} -> ${recordIP}`)
                    }
                }
            }

            // If there's a subdomain and it has its own A record, use that IP
            if (subdomain && subdomainIPs[subdomain.toLowerCase()]) {
                const subdomainIP = subdomainIPs[subdomain.toLowerCase()]
                console.log(`[DNN] Using subdomain IP for '${subdomain}': ${subdomainIP} (instead of root IP: ${ip})`)
                ip = subdomainIP
            }

            if (ip) {
                // Extract ports from SRV records (if available)
                let httpsPort = 443

                const httpsSrvRecord = data.connection.records.find(r => r.type === 'SRV' && r.name === '_https._tcp')
                if (httpsSrvRecord && httpsSrvRecord.port) {
                    httpsPort = httpsSrvRecord.port
                }

                console.log(`[DNN] Resolved ${name}: IP=${ip}, HTTPS port=${httpsPort}`)

                // Get owner pubkey from resolution
                const ownerPubkey = data.pubkey

                // Extract certificate from connection data FIRST to decide protocol
                const declaredCertPem = dnnCertExtractFromConnection(data.connection, name)

                let certVerified = false
                let certError = null
                let certDnnId = null

                if (declaredCertPem) {
                    // DNN cert is declared - try to verify
                    console.log(`[DNN] Fetching server TLS certificate from ${ip}:${httpsPort}...`)
                    const serverCertPem = await fetchServerCert(ip, httpsPort)

                    if (serverCertPem) {
                        console.log('[DNN] Got server certificate, verifying...')
                    } else {
                        console.log('[DNN] Could not fetch server certificate')
                    }

                    // Verify the certificate
                    const verifyResult = dnnCertVerify({
                        declaredCertPem: declaredCertPem,
                        serverCertPem: serverCertPem,
                        dnnName: name
                    })

                    certVerified = verifyResult.valid
                    certError = verifyResult.error || null
                    certDnnId = verifyResult.details?.certDnnId || null

                    if (certVerified) {
                        console.log(`[DNN] ✓ Certificate verified for ${name}`)
                    } else {
                        console.log(`[DNN] ✗ Certificate verification failed for ${name}: ${certError}`)
                    }
                } else {
                    // No DNN cert declared
                    console.log(`[DNN] No certificate found in connection event for ${name}`)
                    certError = 'No certificate declared in connection event'
                }

                // Cache the result with cert info
                dnnCache.set(name.toLowerCase(), {
                    ip,
                    port: httpsPort,
                    timestamp: Date.now(),
                    data,
                    certVerified,
                    certError,
                    ownerPubkey,
                    certDnnId
                })

                // Store cert verified status for setCertificateVerifyProc
                certVerifiedMap.set(name.toLowerCase(), certVerified)
                // Also map by IP for cert verification
                certVerifiedMap.set(`${ip}:${httpsPort}`, certVerified)
                certVerifiedMap.set(ip, certVerified)

                // Store reverse mapping: IP -> DNN name
                ipToDnnMap.set(`${ip}:${httpsPort}`, name.toLowerCase())
                ipToDnnMap.set(ip, name.toLowerCase())

                return {
                    ip,
                    port: httpsPort,
                    certVerified,
                    certError,
                    ownerPubkey,
                    certDnnId
                }
            }
        }
        return null
    } catch (e) {
        console.error('DNN resolution failed:', e)
        return null
    }
}

// Track domains where user chose to proceed despite warning
const proceedAnywayDomains = new Set()

// Register DNN HTTPS interception for a session
function setupDNNInterception(ses) {

    // Set up certificate verification - this MUST allow DNN-resolved IPs
    ses.setCertificateVerifyProc((request, callback) => {
        const { hostname, certificate, verificationResult, errorCode } = request

        // Check if this is a DNN-resolved IP
        const isCertVerified = certVerifiedMap.get(hostname) === true
        const isDNNResolved = certVerifiedMap.has(hostname)

        // Check if this IP belongs to any DNN domain
        let isDNNIP = false
        for (const [name, cached] of dnnCache.entries()) {
            if (cached.ip === hostname) {
                isDNNIP = true
                console.log(`[DNN Cert] IP ${hostname} belongs to DNN name: ${name}`)
                break
            }
        }

        if (isCertVerified) {
            console.log(`[DNN Cert] Certificate verified for ${hostname}`)
            callback(0) // OK
        } else if (isDNNResolved || isDNNIP) {
            // It's a DNN IP - ALLOW the connection
            // The browser's cert check will still happen, but we override it
            console.log(`[DNN Cert] DNN-resolved IP ${hostname}, allowing connection`)
            callback(0) // Allow
        } else {
            // Not a DNN-related host, use Chromium's default
            callback(-3) // Use default
        }
    })

    console.log('[DNN] HTTPS interception configured for session')
}

// Pre-resolve DNN names before navigation
async function preResolveDNN(hostname) {
    if (!isDNNHostname(hostname)) {
        return null
    }

    console.log(`[DNN] Pre-resolving: ${hostname}`)
    const resolution = await resolveDNN(hostname)

    if (resolution) {
        // Store IP mapping for cert verification
        certVerifiedMap.set(resolution.ip, resolution.certVerified)
        console.log(`[DNN] Pre-resolved ${hostname} to ${resolution.ip}:${resolution.port}`)
    }

    return resolution
}

// Expose pre-resolve globally
global.preResolveDNN = preResolveDNN
global.isDNNHostname = isDNNHostname

// Send cert status to renderer
function sendCertStatus(dnnName, resolution) {
    const { webContents } = require('electron')
    const allContents = webContents.getAllWebContents()
    console.log(`[DNN IPC] Sending cert status to ${allContents.length} webContents:`, {
        dnnName,
        certVerified: resolution.certVerified
    })
    allContents.forEach(wc => {
        wc.send('dnn-cert-status', {
            dnnName,
            certVerified: resolution.certVerified,
            certError: resolution.certError,
            certDnnId: resolution.certDnnId,
            ownerPubkey: resolution.ownerPubkey,
            url: `https://${dnnName}`
        })
    })
}

global.sendDNNCertStatus = sendCertStatus

// Handle navigation to DNN URLs - intercept and redirect
function setupDNNNavigation() {
    const { ipcMain, webContents } = require('electron')
    const path = require('path')

    // Listen for will-navigate to intercept DNN URLs
    app.on('web-contents-created', (event, contents) => {
        contents.on('will-navigate', async (navEvent, url) => {
            try {
                const urlObj = new URL(url)
                const hostname = urlObj.hostname

                if (isDNNHostname(hostname)) {
                    console.log(`[DNN] Intercepting navigation to: ${url}`)

                    // Check if user chose to proceed with __dnn_proceed flag
                    if (urlObj.searchParams.get('__dnn_proceed') === 'true') {
                        console.log(`[DNN] User chose to proceed for: ${hostname}`)
                        proceedAnywayDomains.add(hostname.toLowerCase())
                        // Remove the flag and continue
                        urlObj.searchParams.delete('__dnn_proceed')
                    }

                    // Pre-resolve the DNN name
                    const resolution = await resolveDNN(hostname)

                    if (resolution) {
                        // Check if cert is verified OR user chose to proceed
                        if (!resolution.certVerified && !proceedAnywayDomains.has(hostname.toLowerCase())) {
                            // Show warning page
                            console.log(`[DNN] Cert not verified for ${hostname}, showing warning page`)

                            // Build warning page URL
                            const warningUrl = `min://app/pages/dnn-warning/index.html?url=${encodeURIComponent(url)}&error=${encodeURIComponent(resolution.certError || 'Certificate not verified')}`

                            navEvent.preventDefault()
                            contents.loadURL(warningUrl)
                            return
                        }

                        // Redirect to the resolved IP
                        const redirectURL = `https://${resolution.ip}:${resolution.port}${urlObj.pathname}${urlObj.search}`
                        console.log(`[DNN] Redirecting navigation to: ${redirectURL}`)

                        // Prevent original navigation
                        navEvent.preventDefault()

                        // Load the resolved URL
                        contents.loadURL(redirectURL)

                        // Send cert status
                        sendCertStatus(hostname, resolution)
                    } else {
                        console.log(`[DNN] Could not resolve: ${hostname}`)
                    }
                }
            } catch (e) {
                console.error('[DNN] Error intercepting navigation:', e)
            }
        })

        // Also handle did-start-navigation for initial loads
        contents.on('did-start-navigation', async (navEvent, url, isInPlace, isMainFrame) => {
            if (!isMainFrame) return

            try {
                const urlObj = new URL(url)
                const hostname = urlObj.hostname

                if (isDNNHostname(hostname)) {
                    // Pre-resolve so cert verification has the IP cached
                    await preResolveDNN(hostname)
                }
            } catch (e) {
                // Ignore URL parse errors
            }
        })
    })
}

// Register for default session and any new sessions
app.once('ready', () => {
    setupDNNInterception(session.defaultSession)
    setupDNNNavigation()
})

app.on('session-created', (ses) => {
    if (ses !== session.defaultSession) {
        setupDNNInterception(ses)
    }
})

// Expose globals for viewManager integration
global.isDNNHostname = isDNNHostname
global.resolveDNN = resolveDNN
global.ipToDnnMap = ipToDnnMap
global.dnnCache = dnnCache
global.proceedAnywayDomains = proceedAnywayDomains

// Get DNN cert status for a URL (can be IP or DNN name)
global.getDNNCertStatus = function (url) {
    try {
        const urlObj = new URL(url)
        const hostname = urlObj.hostname
        const port = urlObj.port || '443'

        // Check if this is a DNN hostname directly
        if (isDNNHostname(hostname)) {
            const cached = dnnCache.get(hostname.toLowerCase())
            return cached ? {
                dnnName: hostname,
                certVerified: cached.certVerified,
                certError: cached.certError
            } : null
        }

        // Check if this IP maps to a DNN name
        const dnnName = ipToDnnMap.get(`${hostname}:${port}`) || ipToDnnMap.get(hostname)
        if (dnnName) {
            const cached = dnnCache.get(dnnName)
            return cached ? {
                dnnName: dnnName,
                certVerified: cached.certVerified,
                certError: cached.certError
            } : null
        }

        return null
    } catch (e) {
        return null
    }
}

// IPC handler for renderer to get DNN name from IP
const { ipcMain } = require('electron')

ipcMain.on('getDnnNameForIp', (event, data) => {
    const { ip, port } = data
    const dnnName = ipToDnnMap.get(`${ip}:${port}`) || ipToDnnMap.get(ip)
    event.returnValue = dnnName ? { dnnName } : null
})

// IPC handler for renderer to get DNN cert status
// IPC handler for renderer to get DNN nodes from discovery module
ipcMain.on('getDnnNodes', (event) => {
    event.returnValue = dnnNodeDiscovery.getNodes()
})

ipcMain.on('getDnnCertStatus', (event, data) => {
    const { dnnName } = data
    if (!dnnName) {
        event.returnValue = null
        return
    }

    // Check the cache for this DNN name
    const cached = dnnCache.get(dnnName.toLowerCase())
    if (cached) {
        event.returnValue = {
            certVerified: cached.certVerified,
            certError: cached.certError
        }
        console.log(`[DNN IPC] getDnnCertStatus for ${dnnName}: certVerified=${cached.certVerified}`)
    } else {
        // Also check certVerifiedMap directly
        const verified = certVerifiedMap.get(dnnName.toLowerCase())
        if (verified !== undefined) {
            event.returnValue = {
                certVerified: verified,
                certError: null
            }
            console.log(`[DNN IPC] getDnnCertStatus for ${dnnName} (from map): certVerified=${verified}`)
        } else {
            event.returnValue = null
        }
    }
})

// Send DNN cert status to all renderer windows
global.sendDNNCertStatus = function (dnnName, resolution) {
    const { BrowserWindow } = require('electron')
    const windows = BrowserWindow.getAllWindows()

    windows.forEach(win => {
        if (win.webContents) {
            win.webContents.send('dnn-cert-status', {
                dnnName: dnnName,
                certVerified: resolution.certVerified,
                certError: resolution.certError
            })
            console.log(`[DNN IPC] Sending cert status to webContents: { dnnName: '${dnnName}', certVerified: ${resolution.certVerified} }`)
        }
    })
}

