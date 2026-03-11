window.addEventListener('message', function (e) {
  if (!e.origin.startsWith('min://')) {
    return
  }

  if (e.data && e.data.message && e.data.message === 'getSettingsData') {
    ipc.send('getSettingsData')
  }

  if (e.data && e.data.message && e.data.message === 'setSetting') {
    ipc.send('setSetting', { key: e.data.key, value: e.data.value })
  }

  // DNN Node Pool messages
  if (e.data && e.data.message && e.data.message === 'getDNNNodePool') {
    ipc.send('getDNNNodePool')
  }

  if (e.data && e.data.message && e.data.message === 'refreshDNNNodePool') {
    ipc.send('refreshDNNNodePool')
  }

  if (e.data && e.data.message && e.data.message === 'dnnCustomNodesChanged') {
    ipc.send('dnnCustomNodesChanged', e.data.nodes)
  }
})

ipc.on('receiveSettingsData', function (e, data) {
  if (window.location.toString().startsWith('min://')) { // probably redundant, but might as well check
    window.postMessage({ message: 'receiveSettingsData', settings: data }, window.location.toString())
  }
})

ipc.on('receiveDNNNodePool', function (e, nodes) {
  if (window.location.toString().startsWith('min://')) {
    window.postMessage({ message: 'receiveDNNNodePool', nodes: nodes }, window.location.toString())
  }
})

