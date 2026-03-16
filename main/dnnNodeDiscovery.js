/**
 * DNN Node Discovery - Self-healing node pool for Demin browser
 * Mirrors the daemon's peerdiscovery package functionality
 */

const ndFs = require('fs')
const ndPath = require('path')

// Seed nodes - hardcoded initial nodes
const SEED_NODES = [
    'https://node.icannot.xyz',
    'http://64.111.92.122:8080'
]

// Configuration
const MAX_POOL_SIZE = 21
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours
const HEALTH_CHECK_TIMEOUT_MS = 10000
const CRAWL_TIMEOUT_MS = 15000
const POOL_MAX_AGE_MS = 48 * 60 * 60 * 1000 // 48 hours - discard saved pool if older

// State
let nodePool = []
let refreshTimer = null
let isRefreshing = false

/**
 * Get the file path for persisting the node pool
 */
function getPoolFilePath() {
    try {
        const userDataPath = app.getPath('userData')
        return ndPath.join(userDataPath, 'dnn-nodes.json')
    } catch (e) {
        return null
    }
}

/**
 * Save the node pool to disk
 */
function savePool() {
    const filePath = getPoolFilePath()
    if (!filePath) return

    try {
        const data = {
            savedAt: Date.now(),
            nodes: nodePool
        }
        ndFs.writeFileSync(filePath, JSON.stringify(data, null, 2))
    } catch (e) {
        console.log(`[NodeDiscovery] Failed to save pool: ${e.message}`)
    }
}

/**
 * Load the node pool from disk
 * @returns {string[]} - Saved nodes or empty array
 */
function loadPool() {
    const filePath = getPoolFilePath()
    if (!filePath) return []

    try {
        if (!ndFs.existsSync(filePath)) return []

        const raw = ndFs.readFileSync(filePath, 'utf-8')
        const data = JSON.parse(raw)

        // Discard if too old
        if (data.savedAt && (Date.now() - data.savedAt) > POOL_MAX_AGE_MS) {
            console.log('[NodeDiscovery] Saved pool too old, discarding')
            return []
        }

        if (Array.isArray(data.nodes) && data.nodes.length > 0) {
            console.log(`[NodeDiscovery] Loaded ${data.nodes.length} saved nodes from disk`)
            return data.nodes
        }
    } catch (e) {
        console.log(`[NodeDiscovery] Failed to load pool: ${e.message}`)
    }
    return []
}

/**
 * Normalize URL for comparison
 */
function normalizeURL(url) {
    return url.trim().replace(/\/$/, '').toLowerCase()
}

/**
 * Check if a node is a seed node
 */
function isSeedNode(node) {
    const normalized = normalizeURL(node)
    return SEED_NODES.some(seed => normalizeURL(seed) === normalized)
}

/**
 * Health check a single node
 * @param {string} nodeURL - Node URL to check
 * @returns {Promise<boolean>} - True if healthy
 */
async function healthCheck(nodeURL) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS)

    try {
        // Try /dnn/status first (returns JSON with node info)
        const statusURL = normalizeURL(nodeURL) + '/dnn/status'
        let resp = await fetch(statusURL, { signal: controller.signal })
        if (resp.ok) {
            clearTimeout(timeout)
            return true
        }
    } catch (e) {
        // Try fallback
    }

    try {
        // Fallback: try /dnn/peers - any HTTP response (even 4xx) means node is alive
        const peersURL = normalizeURL(nodeURL) + '/dnn/peers'
        const resp = await fetch(peersURL, { signal: controller.signal })
        clearTimeout(timeout)
        // Any HTTP response means the node is reachable and running
        return resp.status > 0
    } catch (e) {
        clearTimeout(timeout)
        console.log(`[NodeDiscovery] Health check failed for ${nodeURL}: ${e.message}`)
        return false
    }
}

/**
 * Fetch peers from a node endpoint
 * @param {string} nodeURL - Base node URL
 * @param {string} endpoint - Endpoint path
 * @returns {Promise<string[]>} - Array of peer URLs
 */
async function fetchPeers(nodeURL, endpoint) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), CRAWL_TIMEOUT_MS)

    try {
        const url = normalizeURL(nodeURL) + endpoint
        const resp = await fetch(url, { signal: controller.signal })
        clearTimeout(timeout)

        if (!resp.ok) return []

        const data = await resp.json()

        // Extract peer URLs from various response formats
        let items = []

        if (Array.isArray(data)) {
            items = data
        } else if (data && Array.isArray(data.results)) {
            items = data.results
        } else if (data && Array.isArray(data.items)) {
            items = data.items
        } else if (data && Array.isArray(data.peers)) {
            items = data.peers
        }



        // Extract URLs from items - handle both string URLs and peer objects
        const urls = []
        for (const item of items) {
            if (typeof item === 'string') {
                urls.push(item)
            } else if (item && typeof item === 'object') {
                const httpURL = item.address || item.url || item.api_url || item.http_url
                if (httpURL) {
                    urls.push(httpURL)
                    continue
                }
                const relayURL = item.relay_url || item.relayUrl
                if (relayURL) {
                    const httpEquiv = relayURL
                        .replace('wss://', 'https://')
                        .replace('ws://', 'http://')
                    urls.push(httpEquiv)
                }
            }
        }


        return urls
    } catch (e) {
        clearTimeout(timeout)

        return []
    }
}

/**
 * Crawl a node to get its peers
 * @param {string} nodeURL - Node URL to crawl
 * @returns {Promise<string[]>} - Array of discovered peer URLs
 */
async function crawlNode(nodeURL) {
    const peers1 = await fetchPeers(nodeURL, '/dnn/peers')
    const peers2 = await fetchPeers(nodeURL, '/dnn/discovered-peers')

    const allPeers = [...peers1, ...peers2]
    if (allPeers.length > 0) {
        console.log(`[NodeDiscovery] Found ${allPeers.length} peers from ${nodeURL}`)
    }
    return allPeers
}

/**
 * Refresh the node pool by crawling known nodes
 */
async function refreshPool() {
    if (isRefreshing) return
    isRefreshing = true

    console.log('[NodeDiscovery] Starting pool refresh...')

    const seen = new Set()
    const newPool = []
    let nodesToCrawl = [...SEED_NODES, ...nodePool]
    let crawled = 0

    while (nodesToCrawl.length > 0 && newPool.length < MAX_POOL_SIZE) {
        const node = nodesToCrawl.shift()
        const normalized = normalizeURL(node)

        // Skip if already seen
        if (seen.has(normalized)) continue
        seen.add(normalized)

        // Health check
        const healthy = await healthCheck(node)

        if (!healthy) continue

        // Add to pool if healthy and not a seed
        if (!isSeedNode(node) && newPool.length < MAX_POOL_SIZE) {
            newPool.push(node)
        }

        // Crawl for more peers
        const peers = await crawlNode(node)
        crawled++

        // Add new peers to crawl queue
        for (const peer of peers) {
            if (!seen.has(normalizeURL(peer))) {
                nodesToCrawl.push(peer)
            }
        }

        // Don't crawl too many nodes
        if (crawled > 50) break
    }

    nodePool = newPool
    isRefreshing = false

    // Persist to disk
    savePool()

    console.log(`[NodeDiscovery] Pool refreshed: ${newPool.length} discovered nodes (+ ${SEED_NODES.length} seed nodes)`)
}

/**
 * Start the discovery service
 */
function start() {
    console.log(`[NodeDiscovery] Starting with ${SEED_NODES.length} seed nodes`)

    // Load saved pool from previous session
    const savedNodes = loadPool()
    if (savedNodes.length > 0) {
        nodePool = savedNodes
        console.log(`[NodeDiscovery] Using ${savedNodes.length} nodes from previous session`)
    }

    // Refresh in the background (re-validates saved nodes + discovers new ones)
    refreshPool()

    // Schedule periodic refresh
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = setInterval(refreshPool, REFRESH_INTERVAL_MS)
}

/**
 * Stop the discovery service
 */
function stop() {
    if (refreshTimer) {
        clearInterval(refreshTimer)
        refreshTimer = null
    }
    console.log('[NodeDiscovery] Stopped')
}

/**
 * Get all available nodes (seeds + discovered)
 * @returns {string[]} - Array of node URLs
 */
function getNodes() {
    const result = [...SEED_NODES]
    for (const node of nodePool) {
        if (!isSeedNode(node)) {
            result.push(node)
        }
    }
    return result
}

/**
 * Get a healthy node for making requests, with fallback
 * Tries nodes in order until one works
 * @param {Function} requestFn - Async function(nodeURL) that makes the request
 * @returns {Promise<any>} - Result from requestFn
 * @throws {Error} - If all nodes fail
 */
async function withFallback(requestFn) {
    const nodes = getNodes()
    let lastError = null

    for (const node of nodes) {
        try {
            return await requestFn(node)
        } catch (e) {
            console.log(`[NodeDiscovery] Node ${node} failed: ${e.message}`)
            lastError = e
        }
    }

    throw lastError || new Error('All DNN nodes failed')
}

/**
 * Get the primary node URL (first seed node)
 * @returns {string}
 */
function getPrimaryNode() {
    return SEED_NODES[0]
}

/**
 * Get pool status for settings UI
 * @returns {Array<{url: string, status: string}>}
 */
function getPoolStatus() {
    const result = []

    // Add seed nodes
    for (const seed of SEED_NODES) {
        result.push({ url: seed, status: 'seed' })
    }

    // Add custom nodes
    for (const node of customNodes) {
        result.push({ url: node, status: 'custom' })
    }

    // Add discovered nodes
    for (const node of nodePool) {
        if (!isSeedNode(node) && !customNodes.includes(node)) {
            result.push({ url: node, status: 'healthy' })
        }
    }

    return result
}

// Custom nodes (added by user in settings)
let customNodes = []

/**
 * Set custom nodes from settings
 * @param {string[]} nodes - Array of custom node URLs
 */
function setCustomNodes(nodes) {
    customNodes = nodes || []
    console.log(`[NodeDiscovery] Custom nodes updated: ${customNodes.length} nodes`)
}

/**
 * Get all available nodes (seeds + custom + discovered)
 * @returns {string[]} - Array of node URLs
 */
function getAllNodes() {
    const result = [...SEED_NODES, ...customNodes]
    for (const node of nodePool) {
        if (!isSeedNode(node) && !customNodes.includes(node)) {
            result.push(node)
        }
    }
    return result
}

// Make functions globally accessible (modules are concatenated, not bundled)
var dnnNodeDiscovery = {
    start,
    stop,
    getNodes: getAllNodes,
    getPrimaryNode,
    withFallback,
    healthCheck,
    refreshPool,
    getPoolStatus,
    setCustomNodes,
    SEED_NODES
}

