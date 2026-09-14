'use strict';

// Shared functional artwork only. User media and third-party pages never pass through here.
(() => {
  const names = ['library', 'video', 'audio', 'document', 'image', 'studio', 'sparkle', 'knowledge', 'import', 'film', 'overview', 'media-index', 'obsidian', 'help'];
  const paths = Object.freeze(Object.fromEntries(names.map(name => [name, 'assets/ui/creator/' + name + '-3d-v1.png'])));
  const badges = new Set(['overview', 'media-index', 'obsidian']);
  const src = name => paths[name] || paths.library;
  const html = name => '<img class="ui-icon' + (badges.has(name) ? ' ui-icon-badge' : '') + '" src="' + src(name) + '" alt="" aria-hidden="true" draggable="false" decoding="async">';
  const hydrate = () => {
    document.querySelectorAll('[data-ui-icon]').forEach(slot => {
      slot.classList.add('ui-icon-slot');
      slot.innerHTML = html(slot.dataset.uiIcon);
    });
  };
  window.UIIcons = Object.freeze({ paths, src, html });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hydrate, { once: true });
  else hydrate();
})();
