// ==UserScript==
// @name         GitHub to DeepWiki Shortcut
// @namespace    https://docs.scriptcat.org/
// @version      1.0
// @description  在 GitHub 仓库页面添加按钮，一键跳转到 DeepWiki
// @author       Gemini
// @match        https://github.com/*/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=github.com
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    function addDeepWikiButton() {
        // 检查是否已经在页面中添加过
        if (document.getElementById('deepwiki-button')) return;

        // 寻找 GitHub 顶部的操作栏 (Star, Fork 等按钮所在的 ul)
        const actionBar = document.querySelector('.pagehead-actions');

        if (actionBar) {
            const li = document.createElement('li');
            li.id = 'deepwiki-button';

            // 构造跳转链接
            const deepWikiUrl = window.location.href.replace('github.com', 'deepwiki.com');

            const iconStyle = `
                margin-right: 6px;
                width: 16px;
                height: 16px;
                border-radius: 2px;
                filter: grayscale(1);
                vertical-align: middle;
            `;

            const buttonStyle = `
                display: inline-flex;
                align-items: center;
                background-color: var(--button-default-bgColor-rest, var(--color-btn-bg));
                box-shadow: var(--button-default-shadow-resting, var(--color-btn-shadow));
                color: var(--button-default-fgColor-rest, var(--color-btn-text));
                border: var(--borderWidth-thin, 0.0625rem) solid var(--button-default-borderColor-rest, var(--color-btn-border));
                border-radius: var(--borderRadius-medium, 0.375rem);
                font-family: inherit;
                font-size: var(--text-body-size-small, 0.75rem);
                font-weight: var(--base-text-weight-medium, 500);
                height: var(--control-small-size, 1.75rem);
                padding: 0 var(--control-small-paddingInline-condensed, 0.5rem);
                gap: var(--control-small-gap, 0.25rem);
                align-items: center;
                display: inline-flex;
                cursor: pointer;
                text-decoration: none;
                transition: 80ms cubic-bezier(0.65, 0, 0.35, 1);
                transition-property: color, fill, background-color, border-color;
            `;

            // 创建按钮 HTML，保持与 GitHub 原生样式尽量一致
            li.innerHTML = `
                <a href="${deepWikiUrl}"
                   class="btn btn-sm"
                   style="${buttonStyle}"
                   target="_blank">
                    <img src="https://deepwiki.com/icon.png"
                         style="${iconStyle}"
                         alt="icon">
                    DeepWiki
                </a>
            `;

            actionBar.prepend(li);

            const link = li.querySelector('a');
            link.onmouseenter = () => {
                link.style.backgroundColor = 'var(--button-default-bgColor-hover, var(--color-btn-hover-bg))';
            };
            link.onmouseleave = () => {
                link.style.backgroundColor = 'var(--button-default-bgColor-rest, var(--color-btn-bg))';
            };
        }
    }

    // 初始化运行
    addDeepWikiButton();

    // 监听 GitHub 的 Turbo 页面加载（因为 GitHub 是单页应用，点击站内链接不会触发传统的 window.onload）
    document.addEventListener('turbo:render', addDeepWikiButton);
})();