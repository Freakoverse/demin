var searchbar = require('searchbar/searchbar.js')
var webviews = require('webviews.js')
var modalMode = require('modalMode.js')
var urlParser = require('util/urlParser.js')
var keyboardNavigationHelper = require('util/keyboardNavigationHelper.js')
var bookmarkStar = require('navbar/bookmarkStar.js')
var contentBlockingToggle = require('navbar/contentBlockingToggle.js')

const tabEditor = {
  container: document.getElementById('tab-editor'),
  input: document.getElementById('tab-editor-input'),
  star: null,
  isShown: false,
  show: function (tabId, editingValue, showSearchbar) {
    /* Edit mode is not available in modal mode. */
    if (modalMode.enabled()) {
      return
    }

    tabEditor.isShown = true

    bookmarkStar.update(tabId, tabEditor.star)
    contentBlockingToggle.update(tabId, tabEditor.contentBlockingToggle)

    var currentURL = urlParser.getSourceURL(tabs.get(tabId).url)
    if (currentURL === 'min://newtab') {
      currentURL = ''
    }

    tabEditor.input.value = editingValue || currentURL
    tabEditor.input.focus()
    if (!editingValue) {
      tabEditor.input.select()
    }
    tabEditor.input.scrollLeft = 0

    // Hide the BrowserView so the searchbar dropdown is visible
    // (BrowserView is a native window that covers all HTML content)
    webviews.requestPlaceholder('editMode')

    searchbar.show(tabEditor.input)

    if (showSearchbar !== false) {
      if (editingValue) {
        searchbar.showResults(editingValue, null)
      } else {
        searchbar.showResults('', null)
      }
    }
  },
  hide: function () {
    if (!tabEditor.isShown) {
      // Update the URL display even if not in edit mode
      tabEditor.updateURLDisplay()
      return
    }
    tabEditor.isShown = false

    tabEditor.input.blur()
    searchbar.hide()

    // Restore the BrowserView
    webviews.hidePlaceholder('editMode')

    // Update the address bar to show the current URL
    tabEditor.updateURLDisplay()
  },
  // Show the current tab's URL in the address bar (non-edit mode)
  updateURLDisplay: function () {
    var selectedTab = tabs.getSelected && tabs.getSelected()
    if (selectedTab) {
      var tabData = tabs.get(selectedTab)
      if (tabData) {
        var url = urlParser.getSourceURL(tabData.url)
        if (url === 'min://newtab' || !url) {
          tabEditor.input.value = ''
        } else {
          tabEditor.input.value = url
        }
        // Always update bookmark star and content blocking toggle
        if (tabEditor.star) {
          bookmarkStar.update(selectedTab, tabEditor.star)
        }
        if (tabEditor.contentBlockingToggle) {
          contentBlockingToggle.update(selectedTab, tabEditor.contentBlockingToggle)
        }
      }
    }
  },
  initialize: function () {
    tabEditor.input.setAttribute('placeholder', l('searchbarPlaceholder'))

    tabEditor.star = bookmarkStar.create()
    tabEditor.container.appendChild(tabEditor.star)

    tabEditor.contentBlockingToggle = contentBlockingToggle.create()
    tabEditor.container.appendChild(tabEditor.contentBlockingToggle)

    keyboardNavigationHelper.addToGroup('searchbar', tabEditor.container)

    tabEditor.input.addEventListener('input', function (e) {
      searchbar.showResults(this.value, {
        isDeletion: e.inputType.includes('delete')
      })
    })

    // Focus the input when clicked (enter edit mode)
    tabEditor.input.addEventListener('focus', function (e) {
      if (!tabEditor.isShown) {
        tabEditor.show(tabs.getSelected())
      }
    })

    tabEditor.input.addEventListener('keypress', function (e) {
      if (e.keyCode === 13) {
        if (this.getAttribute('data-autocomplete') && this.getAttribute('data-autocomplete').toLowerCase() === this.value.toLowerCase()) {
          searchbar.openURL(this.getAttribute('data-autocomplete'), e)
        } else {
          searchbar.openURL(this.value, e)
        }
        e.preventDefault()
      }

      if (e.key && this.selectionEnd === this.value.length && this.value[this.selectionStart] === e.key) {
        this.selectionStart += 1
        e.preventDefault()
        searchbar.showResults(this.value.substring(0, this.selectionStart), {})
      }
    })

    // Click on webview dismisses search, but address bar stays
    document.getElementById('webviews').addEventListener('click', function () {
      tabEditor.hide()
    })

    // Update URL display when tab changes
    tasks.on('tab-selected', function () {
      setTimeout(function () {
        tabEditor.updateURLDisplay()
      }, 50)
    })
    tasks.on('tab-updated', function (id, key) {
      if ((key === 'url' || key === 'title') && id === tabs.getSelected()) {
        if (!tabEditor.isShown) {
          tabEditor.updateURLDisplay()
        }
      }
    })
  }
}

tabEditor.initialize()

module.exports = tabEditor
