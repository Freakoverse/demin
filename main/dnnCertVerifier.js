// DNN Certificate Verifier
// Verifies DNN certificates by:
// 1. Comparing server's TLS cert with cert declared in connection event
// 2. (Optional) Logging expiry - but DNN doesn't fail on expired certs
// NOTE: We intentionally do NOT check if cert's SAN matches the domain.
// DNN trust comes from the 62600 Nostr event, not traditional PKI.
// NOTE: This runs in the main process

const crypto = require('crypto')

/**
 * Extract DNN ID (DNS name) from certificate's Subject Alternative Name (SAN) field
 * @param {string} certPem - The X.509 certificate in PEM format
 * @returns {string|null} The first non-wildcard DNS name found, or null
 */
function extractDnnIdFromCert(certPem) {
    try {
        // Create X509Certificate object from PEM
        const cert = new crypto.X509Certificate(certPem)

        // Get the Subject Alternative Name extension
        const san = cert.subjectAltName
        if (!san) {
            console.log('[DNN Cert] No SAN extension found in certificate')
            return null
        }

        // Parse SAN - format is like "DNS:example.com, DNS:*.example.com, IP:1.2.3.4"
        const sanParts = san.split(',').map(s => s.trim())

        // Find first non-wildcard DNS entry
        for (const part of sanParts) {
            if (part.startsWith('DNS:')) {
                const dnsName = part.substring(4) // Remove "DNS:" prefix
                // Skip wildcard entries
                if (!dnsName.startsWith('*.')) {
                    console.log('[DNN Cert] Found DNN ID in SAN:', dnsName)
                    return dnsName.toLowerCase()
                }
            }
        }

        console.log('[DNN Cert] No non-wildcard DNS name found in SAN')
        return null
    } catch (e) {
        console.error('[DNN Cert] Failed to extract DNN ID from cert:', e.message)
        return null
    }
}

/**
 * Check if a certificate's SAN covers the visited domain
 * Supports exact matches and wildcard matches (single level only)
 * @param {string} certPem - The X.509 certificate in PEM format
 * @param {string} visitedDomain - The domain being visited (e.g., "blossom.freakoverse.nabtaabove")
 * @returns {boolean} True if cert SAN covers the domain
 */
function certCoversDomain(certPem, visitedDomain) {
    try {
        const cert = new crypto.X509Certificate(certPem)
        const san = cert.subjectAltName
        if (!san) {
            console.log('[DNN Cert] No SAN extension found in certificate')
            return false
        }

        const visited = visitedDomain.toLowerCase()
        const sanParts = san.split(',').map(s => s.trim())

        for (const part of sanParts) {
            if (!part.startsWith('DNS:')) continue
            const sanName = part.substring(4).toLowerCase()

            // Exact match
            if (visited === sanName) {
                console.log(`[DNN Cert] ✓ SAN exact match: ${sanName}`)
                return true
            }

            // Wildcard match: *.freakoverse.nabtaabove matches blossom.freakoverse.nabtaabove
            // Wildcard only matches ONE level (standard TLS behavior)
            if (sanName.startsWith('*.')) {
                const wildcardSuffix = sanName.substring(1) // ".freakoverse.nabtaabove"
                if (visited.endsWith(wildcardSuffix)) {
                    const prefix = visited.substring(0, visited.length - wildcardSuffix.length)
                    // Prefix should not contain any dots (single level only)
                    if (!prefix.includes('.') && prefix.length > 0) {
                        console.log(`[DNN Cert] ✓ SAN wildcard match: ${sanName} covers ${visited}`)
                        return true
                    }
                }
            }
        }

        console.log(`[DNN Cert] ✗ SAN does not cover domain: ${visited}`)
        console.log(`[DNN Cert]   Available SANs: ${sanParts.filter(p => p.startsWith('DNS:')).join(', ')}`)
        return false
    } catch (e) {
        console.error('[DNN Cert] Failed to check SAN coverage:', e.message)
        return false
    }
}

/**
 * Extract expiry date from certificate
 * @param {string} certPem - The X.509 certificate in PEM format
 * @returns {Date|null} The expiry date, or null if parsing failed
 */
function extractCertExpiry(certPem) {
    try {
        const cert = new crypto.X509Certificate(certPem)
        return new Date(cert.validTo)
    } catch (e) {
        console.error('[DNN Cert] Failed to extract expiry from cert:', e.message)
        return null
    }
}

/**
 * Normalize a PEM string for comparison (remove whitespace differences)
 * @param {string} pem - PEM string to normalize
 * @returns {string} Normalized PEM string
 */
function normalizePem(pem) {
    if (!pem) return ''
    // Remove all whitespace and compare the base64 content
    return pem.replace(/[\r\n\s]/g, '')
}

/**
 * Compare two certificates for equality
 * @param {string} certPem1 - First certificate PEM
 * @param {string} certPem2 - Second certificate PEM
 * @returns {boolean} True if certificates are identical
 */
function compareCerts(certPem1, certPem2) {
    if (!certPem1 || !certPem2) {
        console.log('[DNN Cert] compareCerts: Missing cert(s) - declared:', !!certPem1, 'server:', !!certPem2)
        return false
    }
    const norm1 = normalizePem(certPem1)
    const norm2 = normalizePem(certPem2)
    const match = norm1 === norm2

    // Debug logging
    console.log('[DNN Cert] Comparing certs:')
    console.log('[DNN Cert]   Declared cert length:', norm1.length, 'first 50:', norm1.substring(0, 50))
    console.log('[DNN Cert]   Server cert length:', norm2.length, 'first 50:', norm2.substring(0, 50))
    console.log('[DNN Cert]   Match result:', match)

    if (!match && norm1.length > 0 && norm2.length > 0) {
        // Find first difference
        for (let i = 0; i < Math.min(norm1.length, norm2.length); i++) {
            if (norm1[i] !== norm2[i]) {
                console.log('[DNN Cert]   First diff at position', i, ':', norm1.substring(i, i + 20), 'vs', norm2.substring(i, i + 20))
                break
            }
        }
    }

    return match
}

/**
 * Verify a DNN certificate
 * @param {Object} options - Verification options
 * @param {string} options.declaredCertPem - Certificate PEM from connection event (what owner declared)
 * @param {string} options.serverCertPem - Certificate PEM from server's TLS handshake (what server uses)
 * @param {string} options.dnnName - The DNN name being accessed (e.g., "nabceabsurd")
 * @returns {Object} { valid: boolean, error?: string, details?: Object }
 */
function verifyCert(options) {
    const { declaredCertPem, serverCertPem, dnnName } = options

    const result = {
        valid: false,
        details: {}
    }

    // Check required fields
    if (!declaredCertPem) {
        result.error = 'No certificate declared in connection event'
        return result
    }

    // Step 1: If we have the server cert, compare it with declared cert
    if (serverCertPem) {
        const certsMatch = compareCerts(declaredCertPem, serverCertPem)
        result.details.certsMatch = certsMatch

        if (!certsMatch) {
            result.error = 'Server certificate does not match certificate declared in DNN connection event'
            return result
        }
        console.log('[DNN Cert] ✓ Server cert matches declared cert')
    } else {
        // No server cert available - we'll verify the declared cert only
        console.log('[DNN Cert] No server cert available, verifying declared cert only')
        result.details.serverCertAvailable = false
    }

    // Step 2: Check expiration (soft warning only - DNN doesn't rely on expiration dates)
    const expiry = extractCertExpiry(declaredCertPem)
    if (expiry) {
        const now = new Date()
        result.details.expiresAt = expiry.toISOString()
        if (expiry < now) {
            // Don't fail - just note it. DNN's trust comes from the 62600 event, not cert dates
            result.details.expired = true
            result.details.expiryWarning = "Certificate expired, but it doesn't matter, the Certificate still works and is valid in the eyes of DNN (assuming all other checks are valid)"
            console.log('[DNN Cert] ⚠ Certificate expired, but DNN considers it valid regardless (assuming all other checks are valid)')
        } else {
            result.details.notExpired = true
            console.log('[DNN Cert] ✓ Certificate not expired (expires:', expiry.toISOString(), ')')
        }
    }

    // NOTE: We do NOT check SAN coverage for DNN domains.
    // DNN trust comes from the 62600 Nostr event declaring the certificate.
    // If server cert matches declared cert, it's trusted - regardless of SAN.
    // This is fundamentally different from traditional PKI where SAN must match domain.

    // All checks passed!
    result.valid = true
    console.log('[DNN Cert] ✓ Certificate verified successfully for DNN:', dnnName)

    return result
}

/**
 * Extract certificate from DNN connection data
 * Looks up certs by explicit domain name keys in the 62600 connection data.
 * @param {Object} connectionData - Parsed connection data from DNN resolution
 * @param {string} fullName - The full name being resolved (e.g., "banana.nabceabsurd")
 * @param {string} baseName - The base DNN name (e.g., "nabceabsurd") - optional
 * @returns {string|null} Certificate PEM string or null if not found
 */
function extractCertFromConnection(connectionData, fullName, baseName) {
    if (!connectionData) {
        return null
    }

    // Helper to extract PEM from cert object
    const getPem = (cert) => {
        if (!cert) return null
        // Handle nested structure: { pem, cert_signature, expires }
        if (cert.pem) return cert.pem
        // Handle chain format: { chain: [{ type: "leaf", pem: "..." }] }
        if (cert.chain && Array.isArray(cert.chain)) {
            const leaf = cert.chain.find(c => c.type === 'leaf') || cert.chain[0]
            if (leaf && leaf.pem) return leaf.pem
        }
        // Handle if cert is directly a PEM string
        if (typeof cert === 'string' && cert.includes('-----BEGIN')) return cert
        return null
    }

    // Extract subdomain from full name
    // e.g., "banana.nabceabsurd" -> "banana"
    // e.g., "nabceabsurd" -> null (no subdomain)
    let subdomain = null
    if (fullName && fullName.includes('.')) {
        const parts = fullName.split('.')
        if (parts.length >= 2) {
            subdomain = parts[0] // First part is the subdomain
        }
    }

    console.log('[DNN Cert] Looking for cert - fullName:', fullName, 'subdomain:', subdomain)
    console.log('[DNN Cert] connectionData keys:', Object.keys(connectionData || {}))

    // 1. If there's a subdomain, try to find its specific cert in the connection data
    if (subdomain && connectionData[subdomain] && connectionData[subdomain].cert) {
        console.log('[DNN Cert] Found cert for subdomain:', subdomain)
        return getPem(connectionData[subdomain].cert)
    }

    // 2. If subdomain has its own connection entry but no cert, don't fall through
    //    Each domain key is independent — no cert inheritance
    if (subdomain && connectionData[subdomain]) {
        const subdomainEntry = connectionData[subdomain]
        if (typeof subdomainEntry === 'object' && (subdomainEntry.records || subdomainEntry.delegation)) {
            console.log('[DNN Cert] Subdomain has connection data but no cert:', subdomain)
            return null
        }
    }

    // 3. Try the full name as key
    if (connectionData[fullName] && connectionData[fullName].cert) {
        console.log('[DNN Cert] Found cert for full name:', fullName)
        return getPem(connectionData[fullName].cert)
    }

    // 4. Try baseName as key (explicit domain name in 62600)
    if (baseName && connectionData[baseName] && connectionData[baseName].cert) {
        console.log('[DNN Cert] Found cert for base name:', baseName)
        return getPem(connectionData[baseName].cert)
    }

    // 5. Try top-level cert (flattened structure from node API's parsed response)
    if (connectionData.cert) {
        console.log('[DNN Cert] Using top-level cert')
        return getPem(connectionData.cert)
    }

    console.log('[DNN Cert] No certificate found in connection data')
    return null
}

// Make functions globally accessible for dnnProtocol.js
// (modules are concatenated, not bundled, so module.exports won't work)
var dnnCertVerify = verifyCert
var dnnCertExtractFromConnection = extractCertFromConnection
var dnnCertExtractDnnId = extractDnnIdFromCert
var dnnCertExtractExpiry = extractCertExpiry
