
// ==UserScript==
// @name         知乎不显示登录框
// @namespace    http://tampermonkey.net/
// @version      0.2.1
// @description  通过样式隐藏知乎登录框，让弹框从头到尾不出现
// @author       pomelo-alias
// @match        https://*.zhihu.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=zhihu.com
// @grant        none
// ==/UserScript==

(function() {
    'use strict';
    var styleDom = document.createElement('style')
    styleDom.type = `text/css`
    styleDom.innerHTML = `
        html{ overflow: auto!important; margin-right: 0!important }
        .Modal-enter,.Modal-enter-active,.Modal-enter-done{display: none!important}
    `
    document.head.appendChild(styleDom)
})();