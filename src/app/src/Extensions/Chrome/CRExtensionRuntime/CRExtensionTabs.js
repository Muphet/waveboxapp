import { webContents } from 'electron'
import { evtMain } from 'AppEvents'
import CRDispatchManager from '../CRDispatchManager'
import {
  CRX_TABS_QUERY_,
  CRX_TABS_GET_,
  CRX_TABS_REMOVE_,
  CRX_TABS_UPDATE_,
  CRX_TABS_CREATED_,
  CRX_TABS_REMOVED_,
  CRX_TAB_ACTIVATED_,
  CRX_TAB_UPDATED_,
  CRX_TAB_EXECUTE_SCRIPT_
} from 'shared/crExtensionIpcEvents'
import { WBECRX_EXECUTE_SCRIPT } from 'shared/ipcEvents'
import { CR_EXTENSION_PROTOCOL } from 'shared/extensionApis'
import CRExtensionMatchPatterns from 'shared/Models/CRExtension/CRExtensionMatchPatterns'
import { URL } from 'url'
import fs from 'fs-extra'
import path from 'path'
import CRExtensionTab from './CRExtensionTab'
import pathTool from 'shared/pathTool'
import WaveboxWindow from 'Windows/WaveboxWindow'

class CRExtensionTabs {
  /* ****************************************************************************/
  // Lifecycle
  /* ****************************************************************************/

  constructor (extension) {
    this.extension = extension
    this.backgroundPageSender = null
    this.extensionWindowSender = null

    evtMain.on(evtMain.WB_TAB_CREATED, this.handleTabCreated)
    evtMain.on(evtMain.WB_TAB_DESTROYED, this.handleTabDestroyed)
    evtMain.on(evtMain.WB_TAB_ACTIVATED, this.handleTabActivated)

    CRDispatchManager.registerHandler(`${CRX_TABS_GET_}${this.extension.id}`, this.handleGetTab)
    CRDispatchManager.registerHandler(`${CRX_TABS_QUERY_}${this.extension.id}`, this.handleQueryTabs)
    CRDispatchManager.registerHandler(`${CRX_TABS_REMOVE_}${this.extension.id}`, this.handleRemoveTabs)
    CRDispatchManager.registerHandler(`${CRX_TABS_UPDATE_}${this.extension.id}`, this.handleUpdateTab)
    CRDispatchManager.registerHandler(`${CRX_TAB_EXECUTE_SCRIPT_}${this.extension.id}`, this.handleExecuteScript)
  }

  destroy () {
    evtMain.removeListener(evtMain.WB_TAB_CREATED, this.handleTabCreated)
    evtMain.removeListener(evtMain.WB_TAB_DESTROYED, this.handleTabDestroyed)
    evtMain.removeListener(evtMain.WB_TAB_ACTIVATED, this.handleTabActivated)

    CRDispatchManager.unregisterHandler(`${CRX_TABS_GET_}${this.extension.id}`, this.handleGetTab)
    CRDispatchManager.unregisterHandler(`${CRX_TABS_QUERY_}${this.extension.id}`, this.handleQueryTabs)
    CRDispatchManager.unregisterHandler(`${CRX_TABS_REMOVE_}${this.extension.id}`, this.handleRemoveTabs)
    CRDispatchManager.unregisterHandler(`${CRX_TABS_UPDATE_}${this.extension.id}`, this.handleUpdateTab)
    CRDispatchManager.unregisterHandler(`${CRX_TAB_EXECUTE_SCRIPT_}${this.extension.id}`, this.handleExecuteScript)
  }

  /* ****************************************************************************/
  // Utils
  /* ****************************************************************************/

  /**
  * Generates the tab data from the given web contentsId depending on the permissions
  * @param webContentsId: the webcontent id to generate from
  * @return the raw tab data
  */
  _tabDataFromWebContentsId (webContentsId) {
    return CRExtensionTab.dataFromWebContentsId(this.extension, webContentsId)
  }

  /**
  * Generates the tab data from the given web contents depending on the permissions
  * @param webContents: the webcontents to generate from
  * @return the raw tab data
  */
  _tabDataFromWebContents (webContents) {
    return CRExtensionTab.dataFromWebContents(this.extension, webContents)
  }

  /**
  * Emits an event to all the qualified listeners
  * @param ...args: the arguments to pass through
  */
  _emitEventToListeners (...args) {
    if (this.backgroundPageSender) {
      this.backgroundPageSender(...args)
    }
    if (this.extensionWindowSender) {
      this.extensionWindowSender(...args)
    }
  }

  /* ****************************************************************************/
  // Event listeners
  /* ****************************************************************************/

  /**
  * Handles a tab being attached by passing to the extension
  * @param evt: the event that fired
  * @param tabId: the id of the webcontents
  */
  handleTabCreated = (evt, tabId) => {
    // Bind tab listeners - even if there isn't a sender right now
    this.bindTabEventListeners(tabId)
    this._emitEventToListeners(`${CRX_TABS_CREATED_}${this.extension.id}`, this._tabDataFromWebContentsId(tabId))
  }

  /**
  * Handles a tab being detached by passing to the extension
  * @param evt: the event that fired
  * @param tabId: the id of the webcontents
  */
  handleTabDestroyed = (evt, tabId) => {
    this._emitEventToListeners(`${CRX_TABS_REMOVED_}${this.extension.id}`, this._tabDataFromWebContentsId(tabId))
  }

  /**
  * Handles a tab being activated
  * @param evt: the event that fired
  * @param browserWindowId: the id of the browser window
  * @param tabId: the id of the tab
  */
  handleTabActivated = (evt, browserWindowId, tabId) => {
    this._emitEventToListeners(`${CRX_TAB_ACTIVATED_}${this.extension.id}`, {
      windowId: browserWindowId,
      tabId: tabId
    })
  }

  /**
  * Binds the tab event listeners if permissions allow
  * @param tabId: the tab id to bind to
  */
  bindTabEventListeners = (tabId) => {
    if (!this.extension.manifest.permissions.has('tabs')) { return }
    const contents = webContents.fromId(tabId)
    if (!contents) { return }

    contents.on('page-title-updated', (evt, title) => {
      this._emitEventToListeners(`${CRX_TAB_UPDATED_}${this.extension.id}`, tabId, {
        title: title
      }, this._tabDataFromWebContentsId(tabId))
    })
    contents.on('did-navigate', (evt, url) => {
      this._emitEventToListeners(`${CRX_TAB_UPDATED_}${this.extension.id}`, tabId, {
        url: url
      }, this._tabDataFromWebContentsId(tabId))
    })
    contents.on('did-navigate-in-page', (evt, url, isMainFrame) => {
      if (!isMainFrame) { return }
      this._emitEventToListeners(`${CRX_TAB_UPDATED_}${this.extension.id}`, tabId, {
        url: url
      }, this._tabDataFromWebContentsId(tabId))
    })
  }

  /* ****************************************************************************/
  // Handlers
  /* ****************************************************************************/

  /**
  * Gets the tab with the given id
  * @param evt: the event that fired
  * @param [tabId]: the id of the tab
  * @param responseCallback: executed on completion
  */
  handleGetTab = (evt, [tabId], responseCallback) => {
    if (WaveboxWindow.fromTabId(tabId)) {
      responseCallback(null, this._tabDataFromWebContentsId(tabId))
    } else {
      responseCallback(null, null)
    }
  }

  /**
  * Queries the tabs
  * @param evt: the event that fired
  * @param [options]: the query info
  * @param responseCallback: executed on completion
  */
  handleQueryTabs = (evt, [options], responseCallback) => {
    const lastFocusedWindowId = WaveboxWindow.lastFocusedId()
    const hasTabsPermission = this.extension.manifest.permissions.has('tabs')

    const tabs = WaveboxWindow.allTabIds()
      .map((id) => this._tabDataFromWebContentsId(id))
      .filter((tab) => {
        if (!options) { return true }
        if (!tab) { return false }

        if (options.active !== undefined) {
          if (tab.active !== options.active) { return false }
        }
        if (options.windowId !== undefined) {
          if (tab.windowId !== options.windowId) { return false }
        }
        if (options.lastFocusedWindow === true) {
          if (lastFocusedWindowId === undefined || tab.windowId !== lastFocusedWindowId) { return false }
        }
        if (options.currentWindow === true) { // Not quite true - but close enough
          if (lastFocusedWindowId === undefined || tab.windowId !== lastFocusedWindowId) { return false }
        }

        if (hasTabsPermission) {
          if (typeof (options.url) === 'string' || Array.isArray(options.url)) {
            const urlQuery = typeof (options.url) === 'string' ? [options.url] : options.url
            const {protocol, hostname, pathname} = new URL(tab.url)
            const matches = CRExtensionMatchPatterns.matchUrls(
              protocol,
              hostname,
              pathname,
              urlQuery
            )
            if (!matches) { return false }
          }
        }

        return true
      })

    responseCallback(null, tabs)
  }

  /**
  * Handles removing tabs
  * @param evt: the event that fired
  * @param [tabIds]: the ids of the tabs to remove
  * @param responseCallback: executed on completion
  */
  handleRemoveTabs = (evt, [tabIds], responseCallback) => {
    tabIds.forEach((tabId) => {
      const waveboxWindow = WaveboxWindow.fromTabId(tabId)
      if (waveboxWindow) {
        // We only partially support this. Basically with windows that only have
        // one tab
        if (waveboxWindow.windowType === WaveboxWindow.WINDOW_TYPES.CONTENT_POPUP) {
          waveboxWindow.close()
        } else if (waveboxWindow.windowType === WaveboxWindow.WINDOW_TYPES.CONTENT) {
          waveboxWindow.close()
        }
      }
    })

    responseCallback(null, null)
  }

  /**
  * Handles removing tabs
  * @param evt: the event that fired
  * @param [tabId, options]: the tabId and options to use
  * @param responseCallback: executed on completion
  */
  handleUpdateTab = (evt, [tabId, options], responseCallback) => {
    const waveboxWindow = WaveboxWindow.fromTabId(tabId)
    // If we got a wavebox window it means we're user facing tab
    // We only partially support this
    if (waveboxWindow && waveboxWindow.windowType === WaveboxWindow.WINDOW_TYPES.CONTENT_POPUP) {
      const wc = webContents.fromId(tabId)
      if (wc && !wc.isDestroyed()) {
        if (options.url) {
          if (wc.getURL().startsWith(CR_EXTENSION_PROTOCOL) && options.url.startsWith(CR_EXTENSION_PROTOCOL)) {
            wc.loadURL(options.url)
          }
        }
      }
    }

    responseCallback(null, this._tabDataFromWebContentsId(tabId))
  }

  /**
  * Handles executing a script in another tab
  * @param evt: the event that fired
  * @param [tabId, details]: the exec info
  * @param responseCallback: executed on completion
  */
  handleExecuteScript = (evt, [tabId, details], responseCallback) => {
    // Add defaults in late during execution step
    tabId = tabId === undefined ? WaveboxWindow.focusedTabId() : tabId

    if (!WaveboxWindow.fromTabId(tabId)) { // Do the check on the window to ensure we can't get bg page etc
      responseCallback(`Tab not found with id "${tabId}"`, null)
      return
    }

    const contents = webContents.fromId(tabId)
    const {protocol, hostname, pathname} = new URL(contents.getURL())
    const matches = CRExtensionMatchPatterns.matchUrls(
      protocol,
      hostname,
      pathname,
      Array.from(this.extension.manifest.permissions)
    )
    if (!matches) {
      responseCallback(`Permissions do not allow execution on tab with id "${tabId}"`, null)
      return
    }

    if (details.file) {
      const scopedPath = pathTool.scopeToDir(this.extension.srcPath, details.file)
      if (!scopedPath) {
        responseCallback(`Unable to load file with path "${details.file}"`, null)
        return
      }

      Promise.resolve()
        .then(() => fs.readFile(scopedPath, 'utf8'))
        .then((data) => {
          CRDispatchManager.requestOnTarget(
            contents,
            WBECRX_EXECUTE_SCRIPT,
            [this.extension.id, details, path.extname(scopedPath), data],
            (evt, err, response) => {
              responseCallback(err, response)
            }
          )
        })
        .catch((ex) => {
          responseCallback(`Unable to load file with path "${details.file}"`, null)
        })
    } else {
      responseCallback(`No loadable file provided`, null)
      // return
    }
  }
}

export default CRExtensionTabs
