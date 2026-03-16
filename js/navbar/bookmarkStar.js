const places = require('places/places.js')
const searchbarPlugins = require('searchbar/searchbarPlugins.js')

const bookmarkStar = {
  _justToggled: false,
  create: function () {
    const star = document.createElement('button')
    star.className = 'tab-editor-button bookmarks-button i carbon:star'
    star.setAttribute('aria-pressed', false)
    star.setAttribute('title', l('addBookmark'))
    star.setAttribute('aria-label', l('addBookmark'))

    star.addEventListener('click', function (e) {
      e.stopPropagation()
      e.preventDefault()
      bookmarkStar.onClick(star)
    })

    return star
  },
  onClick: function (star) {
    var tabId = star.getAttribute('data-tab')
    if (!tabId) {
      tabId = tabs.getSelected()
    }
    if (!tabId) return

    var tabData = tabs.get(tabId)
    if (!tabData || !tabData.url) return

    var isCurrentlyBookmarked = star.getAttribute('aria-pressed') === 'true'

    // Prevent update() from overriding visual state during async operation
    bookmarkStar._justToggled = true
    setTimeout(function () { bookmarkStar._justToggled = false }, 2000)

    if (isCurrentlyBookmarked) {
      // Remove bookmark — update visuals immediately
      star.classList.add('carbon:star')
      star.classList.remove('carbon:star-filled')
      star.setAttribute('aria-pressed', false)

      places.updateItem(tabData.url, {
        isBookmarked: false
      }).then(function () {
        var bookmarksBar = require('navbar/bookmarksBar.js')
        if (bookmarksBar.isVisible) {
          bookmarksBar.render()
        }
      }).catch(function (err) {
        console.error('[BookmarkStar] Error removing bookmark:', err)
      })
    } else {
      // Add bookmark — update visuals immediately
      star.classList.remove('carbon:star')
      star.classList.add('carbon:star-filled')
      star.setAttribute('aria-pressed', true)

      places.updateItem(tabData.url, {
        isBookmarked: true,
        bookmarkedAt: Date.now(),
        title: tabData.title
      }).then(function () {
        var bookmarksBar = require('navbar/bookmarksBar.js')
        if (bookmarksBar.isVisible) {
          bookmarksBar.render()
        }
      }).catch(function (err) {
        console.error('[BookmarkStar] Error adding bookmark:', err)
      })
    }
  },
  update: function (tabId, star) {
    // Always update the data-tab attribute so clicks target the correct tab
    star.setAttribute('data-tab', tabId)

    var tabUrl = tabs.get(tabId).url

    if (!tabUrl) {
      star.hidden = true
      return
    } else {
      star.hidden = false
    }

    // Skip visual state update if user just clicked the star (prevents race condition)
    if (bookmarkStar._justToggled) return

    places.getItem(tabUrl).then(function (item) {
      // Re-check: user might have clicked star while we were waiting
      if (bookmarkStar._justToggled) return

      if (item && item.isBookmarked) {
        star.classList.remove('carbon:star')
        star.classList.add('carbon:star-filled')
        star.setAttribute('aria-pressed', true)
      } else {
        star.classList.add('carbon:star')
        star.classList.remove('carbon:star-filled')
        star.setAttribute('aria-pressed', false)
      }
    })
  }
}

searchbarPlugins.register('simpleBookmarkTagInput', {
  index: 0
})

module.exports = bookmarkStar
