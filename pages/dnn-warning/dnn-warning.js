// DNN Certificate Warning Page Script

// Parse URL parameters
const searchParams = new URLSearchParams(window.location.search)
const targetUrl = decodeURIComponent(searchParams.get('url') || '')
const certError = decodeURIComponent(searchParams.get('error') || 'Certificate not verified')

// Display domain name
const domainEl = document.getElementById('domain-name')
const errorEl = document.getElementById('cert-error')

try {
    const urlObj = new URL(targetUrl)
    domainEl.textContent = urlObj.hostname
} catch (e) {
    domainEl.textContent = targetUrl
}

errorEl.textContent = certError

// Button handlers
const proceedButton = document.getElementById('proceed-button')
const goBackButton = document.getElementById('go-back-button')

proceedButton.addEventListener('click', function () {
    if (targetUrl) {
        // Add proceed flag to URL
        const url = new URL(targetUrl)
        url.searchParams.set('__dnn_proceed', 'true')
        window.location = url.toString()
    }
})

goBackButton.addEventListener('click', function () {
    // Try to go back, or go to new tab
    if (window.history.length > 1) {
        window.history.back()
    } else {
        window.location = 'min://app/pages/newtab/index.html'
    }
})
