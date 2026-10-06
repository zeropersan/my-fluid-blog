/* global Fluid, jQuery */

/**
 * 移动端文章阅读增强 / Mobile reading enhancements
 * ---------------------------------------------------------------------------
 * 为 Fluid 主题的文章页在 lg 断点以下（< 992px）补上：
 *   1. 目录按钮 —— 复用主题 #toc 组件（tocbot 已在移动端照常生成目录，
 *      只是所在侧栏被 d-none d-lg-block 隐藏），以底部抽屉形式展开；
 *   2. 返回顶部按钮 —— 主题的 #scroll-top-button 依据 #board 右侧留白定位，
 *      移动端留白不足 50px 会被永久隐藏，这里提供一个等效按钮。
 *
 * 桌面端（≥ 992px）不做任何干预，完全沿用主题原生交互。
 * 本文件不修改主题源码，主题升级不会覆盖这些改动。
 */
(function() {
  'use strict';

  var MOBILE_QUERY = '(max-width: 991.98px)';
  var ACTIONS_ID = 'mobile-reading-actions';
  var DRAWER_ID = 'mobile-toc-drawer';

  function createButton(id, iconClass, label) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = id;
    btn.className = 'mobile-reading-btn';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);

    var icon = document.createElement('i');
    icon.className = 'iconfont ' + iconClass;
    icon.setAttribute('aria-hidden', 'true');
    btn.appendChild(icon);

    return btn;
  }

  function scrollToTop() {
    if (window.jQuery) {
      jQuery('body,html').animate({ scrollTop: 0, easing: 'swing' });
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function boot() {
    // 仅文章正文页
    if (!document.querySelector('.post-content')) {
      return;
    }
    if (document.getElementById(ACTIONS_ID)) {
      return;
    }

    var mql = window.matchMedia(MOBILE_QUERY);
    var boardEl = document.getElementById('board');
    var tocEl = document.getElementById('toc');

    /* ------------------------------------------------------------------ */
    /* 悬浮按钮组                                                          */
    /* ------------------------------------------------------------------ */
    var actions = document.createElement('div');
    actions.id = ACTIONS_ID;
    actions.setAttribute('role', 'group');
    actions.setAttribute('aria-label', '阅读辅助');

    var tocBtn = null;
    if (tocEl) {
      tocBtn = createButton('mobile-reading-toc', 'icon-list', '目录');
      tocBtn.classList.add('is-hidden'); // tocbot 生成出目录后才显示
      tocBtn.setAttribute('aria-expanded', 'false');
      tocBtn.setAttribute('aria-controls', DRAWER_ID);
      actions.appendChild(tocBtn);
    }

    var topBtn = createButton('mobile-reading-top', 'icon-arrowup', '返回顶部');
    topBtn.classList.add('is-hidden');
    actions.appendChild(topBtn);

    document.body.appendChild(actions);

    /* ------------------------------------------------------------------ */
    /* 目录抽屉                                                            */
    /* ------------------------------------------------------------------ */
    var mask = null;
    var drawer = null;
    var openDrawer = function() {};
    var closeDrawer = function() {};
    var syncTocPlacement = function() {};

    if (tocEl) {
      mask = document.createElement('div');
      mask.className = 'mobile-toc-mask';

      drawer = document.createElement('div');
      drawer.id = DRAWER_ID;
      drawer.className = 'mobile-toc-drawer';
      drawer.setAttribute('role', 'dialog');
      drawer.setAttribute('aria-modal', 'true');
      drawer.setAttribute('aria-label', '文章目录');

      var grabber = document.createElement('div');
      grabber.className = 'mobile-toc-grabber';
      grabber.setAttribute('aria-hidden', 'true');
      drawer.appendChild(grabber);

      // 关闭按钮并入主题 #toc 的标题栏，随目录一起移动
      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'mobile-toc-close';
      closeBtn.setAttribute('aria-label', '关闭目录');
      closeBtn.innerHTML = '<span aria-hidden="true">&times;</span>';

      var tocHeader = tocEl.querySelector('.toc-header');
      if (tocHeader) {
        tocHeader.appendChild(closeBtn);
      } else {
        drawer.appendChild(closeBtn);
      }

      // 记录 #toc 的原始位置，供桌面端还原
      var tocOriginParent = tocEl.parentNode;
      var tocOriginNext = tocEl.nextSibling;

      syncTocPlacement = function() {
        if (!tocOriginParent) {
          return;
        }
        if (mql.matches) {
          if (tocEl.parentNode !== drawer) {
            drawer.appendChild(tocEl);
          }
        } else if (tocEl.parentNode !== tocOriginParent) {
          if (tocOriginNext && tocOriginNext.parentNode === tocOriginParent) {
            tocOriginParent.insertBefore(tocEl, tocOriginNext);
          } else {
            tocOriginParent.appendChild(tocEl);
          }
        }
      };

      openDrawer = function() {
        if (!mql.matches) {
          return;
        }
        syncTocPlacement();
        mask.classList.add('is-open');
        drawer.classList.add('is-open');
        document.body.classList.add('mobile-toc-open');
        tocBtn.setAttribute('aria-expanded', 'true');
      };

      closeDrawer = function() {
        mask.classList.remove('is-open');
        drawer.classList.remove('is-open');
        document.body.classList.remove('mobile-toc-open');
        if (tocBtn) {
          tocBtn.setAttribute('aria-expanded', 'false');
        }
      };

      document.body.appendChild(mask);
      document.body.appendChild(drawer);

      tocBtn.addEventListener('click', function() {
        if (drawer.classList.contains('is-open')) {
          closeDrawer();
        } else {
          openDrawer();
        }
      });
      mask.addEventListener('click', closeDrawer);
      closeBtn.addEventListener('click', closeDrawer);
      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' || e.keyCode === 27) {
          closeDrawer();
        }
      });
      // 点选目录项后收起抽屉，让滚动结果完整可见
      tocEl.addEventListener('click', function(e) {
        var anchor = e.target && e.target.closest ? e.target.closest('a') : null;
        if (anchor) {
          closeDrawer();
        }
      });

      // 目录生成是异步的（tocbot 由 CDN 载入），就绪后再放出按钮
      Fluid.utils.waitElementLoaded('#toc .toc-list-item', function() {
        tocBtn.classList.remove('is-hidden');
      });

      // 首次进入即就位，避免打开抽屉时目录"跳"进来
      syncTocPlacement();
    }

    /* ------------------------------------------------------------------ */
    /* 返回顶部                                                            */
    /* ------------------------------------------------------------------ */
    var threshold = 0;
    var canScrollTop = false;

    function computeThreshold() {
      var maxScroll = Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0
      ) - window.innerHeight;
      maxScroll = Math.max(0, maxScroll);

      var boardTop = boardEl
        ? boardEl.getBoundingClientRect().top + (window.pageYOffset || 0)
        : 0;
      if (boardTop <= 0) {
        boardTop = window.innerHeight;
      }

      // 与主题一致：以 #board 顶部为出现界限；但短文章里该阈值可能永远
      // 达不到，此时退化为"滚到底部才出现"，避免按钮彻底不可用。
      threshold = Math.min(boardTop, maxScroll);
      canScrollTop = maxScroll > 100;
    }

    // 先算阈值，listenScroll 会立即回调一次
    computeThreshold();

    topBtn.addEventListener('click', scrollToTop);

    Fluid.utils.listenScroll(function() {
      var y = window.pageYOffset || document.documentElement.scrollTop || 0;
      topBtn.classList.toggle('is-hidden', !canScrollTop || y < threshold);
    });

    window.addEventListener('load', computeThreshold);
    window.addEventListener('resize', computeThreshold);

    /* ------------------------------------------------------------------ */
    /* 视口切换（旋转屏幕 / 拉伸窗口）                                      */
    /* ------------------------------------------------------------------ */
    function onViewportChange() {
      syncTocPlacement();
      if (!mql.matches) {
        closeDrawer();
      }
      computeThreshold();
    }

    if (mql.addEventListener) {
      mql.addEventListener('change', onViewportChange);
    } else if (mql.addListener) {
      mql.addListener(onViewportChange);
    }

    // 主题内部的刷新回调（tocbot 会重建目录），同步一次状态
    if (Fluid.events && Fluid.events.registerRefreshCallback) {
      Fluid.events.registerRefreshCallback(function() {
        syncTocPlacement();
        if (tocBtn) {
          var hasToc = tocEl.querySelector('.toc-list-item') !== null;
          tocBtn.classList.toggle('is-hidden', !hasToc);
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
