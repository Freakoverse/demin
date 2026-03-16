var places = require('places/places.js')
var webviews = require('webviews.js')
var urlParser = require('util/urlParser.js')
var searchbar = require('searchbar/searchbar.js')
var settings = require('util/settings/settings.js')

const bookmarksBar = {
  container: document.getElementById('bookmarks-bar'),
  itemsContainer: document.getElementById('bookmarks-bar-items'),
  isVisible: false,
  _lastToggle: 0,

  toggle: function () {
    if (bookmarksBar.isVisible) {
      bookmarksBar.hide()
    } else {
      bookmarksBar.show()
    }
    settings.set('showBookmarksBar', bookmarksBar.isVisible)
  },

  show: function () {
    bookmarksBar.container.hidden = false
    bookmarksBar.isVisible = true
    document.body.classList.add('bookmarks-bar-visible')
    webviews.resize()
    bookmarksBar.render()
  },

  hide: function () {
    bookmarksBar.container.hidden = true
    bookmarksBar.isVisible = false
    document.body.classList.remove('bookmarks-bar-visible')
    webviews.resize()
  },

  render: function () {
    while (bookmarksBar.itemsContainer.firstChild) {
      bookmarksBar.itemsContainer.removeChild(bookmarksBar.itemsContainer.firstChild)
    }

    places.searchPlaces('', { searchBookmarks: true, limit: 100 })
      .then(function (results) {
        if (results.length === 0) {
          var emptyMsg = document.createElement('span')
          emptyMsg.className = 'bookmarks-bar-empty'
          emptyMsg.textContent = 'Bookmarks will appear here'
          bookmarksBar.itemsContainer.appendChild(emptyMsg)
          return
        }

        // Sort by bookmarkedAt timestamp so newest bookmarks appear at the end
        results.sort(function (a, b) {
          return (a.bookmarkedAt || 0) - (b.bookmarkedAt || 0)
        })

        results.forEach(function (result) {
          var item = bookmarksBar.createItem(result)
          bookmarksBar.itemsContainer.appendChild(item)
        })
      })
  },

  createItem: function (bookmark) {
    var item = document.createElement('div')
    item.className = 'bookmark-bar-item'
    item.title = bookmark.title || urlParser.basicURL(bookmark.url)

    var favicon = document.createElement('img')
    favicon.className = 'bookmark-favicon'
    favicon.width = 14
    favicon.height = 14

    try {
      var urlObj = new URL(urlParser.getSourceURL(bookmark.url))
      favicon.src = 'https://www.google.com/s2/favicons?domain=' + urlObj.hostname + '&sz=32'
    } catch (e) {
      favicon.style.display = 'none'
    }
    favicon.onerror = function () {
      this.style.display = 'none'
    }
    item.appendChild(favicon)

    var title = document.createElement('span')
    title.className = 'bookmark-title'
    title.textContent = bookmark.title || urlParser.basicURL(bookmark.url)
    item.appendChild(title)

    item.addEventListener('click', function () {
      searchbar.openURL(bookmark.url, null)
    })

    item.addEventListener('auxclick', function (e) {
      if (e.button === 1) {
        searchbar.openURL(bookmark.url, { metaKey: true })
      }
    })

    item.addEventListener('contextmenu', function (e) {
      e.preventDefault()
      e.stopPropagation()

      ipc.send('showBookmarkContextMenu', {
        url: bookmark.url,
        x: e.screenX,
        y: e.screenY
      })
    })

    return item
  },

  initialize: function () {
    var savedState = settings.get('showBookmarksBar')
    if (savedState) {
      bookmarksBar.container.hidden = false
      bookmarksBar.isVisible = true
      document.body.classList.add('bookmarks-bar-visible')
      webviews.resize()

      // The places worker may not have loaded its database cache yet at startup.
      // Retry rendering after delays to catch when the cache becomes available.
      bookmarksBar.render()
      setTimeout(function () {
        bookmarksBar.render()
      }, 1000)
      setTimeout(function () {
        bookmarksBar.render()
      }, 3000)
    }

    // Listen for bookmark removal from native context menu
    ipc.on('removeBookmark', function (e, url) {
      places.updateItem(url, { isBookmarked: false }).then(function () {
        bookmarksBar.render()
      })
    })
  }
}

module.exports = bookmarksBar
