// ==UserScript==
// @name         知乎右侧栏移除器
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  移除知乎页面的右侧栏并居中显示内容。支持：首页、问答页、专栏页、搜索页。
// @author       You
// @match        https://www.zhihu.com/*
// @match        https://zhuanlan.zhihu.com/p/*
// @icon         https://www.zhihu.com/favicon.ico
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // 统一定义需要隐藏的侧边栏选择器
    const sidebarSelectors = [
        '.GlobalSideBar',                // 首页侧边栏
        '.Question-sideColumn',          // 问答页侧边栏
        '.Post-SideActions',             // 专栏页侧边操作栏
        '.Post-Sub',                     // 专栏页右侧栏
        '.Post-Row-Content-right',       // 专栏页右侧容器
        '.Search-sideColumn',            // 搜索页侧边栏
        '.Topstory-sideColumn',          // 首页推荐页侧边栏
        '.Card.AnswerAuthor',            // 关于作者卡片
        '.Card.AuthorCard',              // 关于作者卡片
        '.HotSearchCard',                // 热搜卡片
        '.Question-sideColumnAdContainer'// 广告
    ].join(', ');

    // 构造CSS样式
    const css = `
        /* ---------------- 通用隐藏 ---------------- */
        ${sidebarSelectors},
        div[style*="position: sticky"] .Card,
        div[style*="position:sticky"] .Card,
        .Post-SideActions + div[style*="position: sticky"],
        .Post-SideActions + div[style*="position:sticky"] {
            display: none !important;
        }

        /* ---------------- 首页 (Home) 居中调整 - 稳健版 ---------------- */
        /* 策略：将容器缩窄至内容宽度并居中，而非全屏拉伸 */
        .Topstory-container {
            width: 694px !important;  /* 锁定为标准内容宽度 */
            min-width: 694px !important;
            margin: 0 auto !important;
            padding: 0 !important;
        }

        .Topstory-mainColumn {
            width: 100% !important;   /* 占满缩窄后的容器 */
            margin: 0 !important;
            float: none !important;
        }
        
        .Topstory {
           display: flex !important; 
           justify-content: center !important;
        }

        /* ---------------- 搜索页 (Search) 居中调整 ---------------- */
        .Search-container {
            width: 694px !important;
            margin: 0 auto !important;
            justify-content: center !important;
        }
        
        .Search-mainColumn {
             width: 100% !important;
             margin: 0 !important;
             flex: none !important;
        }

        /* ---------------- 问答页 (Question) 居中调整 ---------------- */
        .Question-mainColumn {
            width: 694px !important;
            margin: 0 auto !important;
            float: none !important;
            transform: none !important; /* 防止可能的位移 */
            display: block !important;
        }

        .Question-main {
            display: block !important; /* 问答页某些结构下 block 更容易控制 margin auto */
            margin: 0 auto !important;
            width: 694px !important;   /* 限制外层宽度 */
        }
        
        .Question-mainColumnWrap {
             width: 100% !important;
        }

        .QuestionPage .ListShortcut {
            width: 694px !important;
            margin: 0 auto !important;
        }

        /* ---------------- 专栏页 (Zhuanlan) 居中调整 ---------------- */
        /* 专栏页需要全宽背景，所以策略不同：全宽容器 + Flex居中 */
        .Post-content {
            display: flex !important;
            justify-content: center !important;
            width: 100% !important;
        }

        .Post-Row-Content {
            display: flex !important;
            justify-content: center !important;
            width: 100% !important;
            max-width: 100% !important; 
            margin: 0 !important;
            padding: 0 !important;
            box-sizing: border-box !important;
        }

        .Post-Row-Content-left {
            margin: 0 auto !important;
            width: 690px !important;
            max-width: 690px !important;
            flex: none !important;
            float: none !important;
            display: block !important;
        }
        
        .Post-Main {
            margin: 0 auto !important;
            width: 100% !important;
        }
        
        .Comment-container {
            margin: 0 auto !important;
            max-width: 690px !important;
            width: 690px !important;
        }

        .ColumnPageHeader-content {
            margin: 0 auto !important;
            width: 690px !important; 
            max-width: 1000px !important;
        }

        /* ---------------- 防抖动核心优化 ---------------- */
        /* 1. 禁用关键布局容器的动画和过渡，防止样式切换时的视觉抖动 */
        .Post-Row-Content, 
        .Post-Row-Content-left, 
        .Post-Main, 
        .Topstory-container, 
        .Topstory-mainColumn,
        .Question-mainColumn,
        .Question-main,
        .GlobalSideBar,
        .Post-Row-Content-right {
            transition: none !important;
            animation: none !important;
            transform: none !important; /* 禁止位移变换 */
        }

        /* 2. 强制页面滚动条稳定，防止因内容宽度变化导致滚动条闪烁从而引发页面抖动 */
        html {
            overflow-y: scroll !important;
            overflow-x: hidden !important;
        }
    `;

    // 注入CSS
    if (typeof GM_addStyle !== 'undefined') {
        GM_addStyle(css);
    } else {
        const style = document.createElement('style');
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    }

    // 优化的去抖动函数
    function debounce(func, wait) {
        let timeout;
        return function() {
            const context = this, args = arguments;
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(context, args), wait);
        };
    }

    // DOM加载后执行清理
    function cleanUp() {
       // 使用 requestAnimationFrame 确保在渲染帧执行，减少视觉闪烁
       requestAnimationFrame(() => {
           document.querySelectorAll('div[style*="position: sticky"], div[style*="position:sticky"]').forEach(div => {
               // 仅当元素可见时才操作，减少重绘
               if (div.style.display !== 'none' && div.querySelector('.Card, .AnswerAuthor, .HotSearchCard')) {
                   div.style.display = 'none';
               }
           });
       });
    }
    
    // 监听DOM变化，使用防抖处理
    const observer = new MutationObserver(debounce((mutations) => {
         cleanUp();
    }, 50)); // 50ms 延迟，合并短时间内的多次 DOM 变化

    observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', cleanUp);
    } else {
        cleanUp();
    }
    
    console.log('[知乎右侧栏移除器 v1.5] 已生效 - 防抖动优化版');
})();
