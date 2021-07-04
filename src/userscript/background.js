function entry () {
    const isChrome = process.ctx.target === 'chrome'
    const vendorGlobal = isChrome ? chrome : browser
    const extraInfoSpecRequest = isChrome ? ['blocking', 'requestHeaders', 'extraHeaders'] : ['blocking', 'requestHeaders']

    let gExtensionUrl = chrome.extension.getURL('')
    if (gExtensionUrl[gExtensionUrl.length - 1] === '/') {
        gExtensionUrl = gExtensionUrl.substr(0, gExtensionUrl.length - 1)
    }
    const gHeadersToReplace = ['cookie', 'origin', 'referer']
    const gDummyHeaderPrefix = 'x-plashiki-'

    // part 2 of greasemonkey copy-pasting.
    const onConnectHandler = (port) => {
        if (port.name !== 'PageXhr') return

        let xhr = new XMLHttpRequest()
        port.onMessage.addListener((msg, src) => {
            switch (msg.name) {
            case 'open':
                open(xhr, msg.details, port, src.sender.tab.url)
                break
            default:
                console.warn('PageXhr port un-handled message name:', msg.name)
            }
        })
    }

    vendorGlobal.runtime.onConnect.addListener(onConnectHandler)
    if (isChrome) {
        vendorGlobal.runtime.onConnectExternal.addListener(onConnectHandler)
    }

    function open (xhr, d, port, tabUrl) {
        function xhrEventHandler (src, event) {
            const responseState = {
                context: d.context || null,
                finalUrl: xhr.responseURL,
                lengthComputable: null,
                loaded: null,
                readyState: xhr.readyState,
                response: xhr.response,
                responseHeaders: null,
                responseText: null,
                responseXML: null,
                status: null,
                statusText: null,
                total: null,
            }

            try {
                responseState.responseText = xhr.responseText
            } catch (e) {
                // Some response types don't have .responseText (but do have e.g. blob
                // .response).  Ignore.
            }

            try {
                // Pass a flag to the content side, that the XML should be parsed.
                responseState.responseXML = !!xhr.responseXML
            } catch (e) {
                // Ignore failure.  At least in responseType blob case, this access fails.
            }

            switch (event.type) {
            case 'progress':
                responseState.lengthComputable = event.lengthComputable
                responseState.loaded = event.loaded
                responseState.total = event.total
                break
            case 'error':
                console.log('error event?', event)
                break
            default:
                if (4 !== xhr.readyState) break
                responseState.responseHeaders = xhr.getAllResponseHeaders()
                responseState.status = xhr.status
                responseState.statusText = xhr.statusText
                break
            }

            port.postMessage(
                { 'src': src, 'type': event.type, 'responseState': responseState })
        }

        [
            'abort', 'error', 'load', 'loadend', 'loadstart', 'progress',
            'readystatechange', 'timeout',
        ].forEach(v => {
            if (d['on' + v]) {
                xhr.addEventListener(v, xhrEventHandler.bind(null, 'down'))
            }
        });

        [
            'abort', 'error', 'load', 'loadend', 'progress', 'timeout',
        ].forEach(v => {
            if (d.upload['on' + v]) {
                xhr.upload.addEventListener(v, xhrEventHandler.bind(null, 'up'))
            }
        })

        xhr.open(d.method, d.url, !d.synchronous, d.user || '', d.password || '')

        xhr.mozBackgroundRequest = !!d.mozBackgroundRequest
        d.overrideMimeType && xhr.overrideMimeType(d.overrideMimeType)
        d.responseType && (xhr.responseType = d.responseType)
        d.timeout && (xhr.timeout = d.timeout)

        let hasCookieHeader = false
        if (d.headers) {
            for (let prop in d.headers) {
                if (Object.prototype.hasOwnProperty.call(d.headers, prop)) {
                    let propLower = prop.toLowerCase()
                    hasCookieHeader = (propLower === 'cookie')
                    if (gHeadersToReplace.includes(propLower)) {
                        xhr.setRequestHeader(gDummyHeaderPrefix + propLower, d.headers[prop])
                    } else {
                        xhr.setRequestHeader(prop, d.headers[prop])
                    }
                }
            }
        }

        // If this is a same-origin XHR or the user opted in with withCredentials,
        // add cookies unless already specified by the user.
        vendorGlobal.cookies.getAll({ url: d.url }, cookies => {
            if (cookies.length && !hasCookieHeader
                && (d.withCredentials || isSameOrigin(tabUrl, d.url))
            ) {
                let cookieStrings = []
                for (let cookie of cookies) {
                    cookieStrings.push(cookie.name + '=' + cookie.value + ';')
                }
                xhr.setRequestHeader(gDummyHeaderPrefix + 'cookie', cookieStrings.join(' '))
            }

            const body = d.data || null
            if (d.binary && (body !== null)) {
                const bodyLength = body.length
                const bodyData = new Uint8Array(bodyLength)
                for (let i = 0; i < bodyLength; i++) {
                    bodyData[i] = body.charCodeAt(i) & 0xff
                }
                xhr.send(new Blob([bodyData]))
            } else {
                xhr.send(body)
            }
        })
    }


    function isSameOrigin (first, second) {
        let firstUrl, secondUrl
        try {
            firstUrl = new URL(first)
            secondUrl = new URL(second)
        } catch (e) {
            return false
        }
        return firstUrl.origin === secondUrl.origin
    }


    function getHeader (headers, name) {
        name = name.toLowerCase()
        for (let header of headers) {
            if (header.name.toLowerCase() === name) {
                return header
            }
        }
        return null
    }

    function rewriteRequestHeaders (e) {
        if (e.type === 'xmlhttprequest'
            && (e.initiator || e.originUrl) && (e.initiator || e.originUrl).startsWith(gExtensionUrl)
        ) {
            for (let name of gHeadersToReplace) {
                const prefixedHeader = getHeader(e.requestHeaders, gDummyHeaderPrefix + name)
                if (prefixedHeader) {
                    const unprefixedHeader = getHeader(e.requestHeaders, name)
                    if (unprefixedHeader) {
                        e.requestHeaders.splice(e.requestHeaders.indexOf(unprefixedHeader), 1)
                    }
                    e.requestHeaders.push({ name: name, value: prefixedHeader.value })
                    e.requestHeaders.splice(e.requestHeaders.indexOf(prefixedHeader), 1)
                }
            }
        }

        return { 'requestHeaders': e.requestHeaders }
    }

    vendorGlobal.webRequest.onBeforeSendHeaders.addListener(
        isChrome ? rewriteRequestHeaders : (e) => rewriteRequestHeaders(e),
        {
            urls: ['<all_urls>'],
            types: ['xmlhttprequest'],
            tabId: -1,
        },
        extraInfoSpecRequest
    )
}

module.exports = {
    entry,
}
