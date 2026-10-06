import { localeByLanguage, resolveLanguage, translations } from './i18n.js';

(() => {
  'use strict';

  const REPO = 'kaigendev/Kaigen';
  const RELEASE_TAG = 'v0.2.9.9';
  const RELEASES_URL = `https://github.com/${REPO}/releases/tag/${RELEASE_TAG}`;
  const API_URL = `https://api.github.com/repos/${REPO}/releases/tags/${RELEASE_TAG}`;
  const LANGUAGE_STORAGE_KEY = 'kaigen-site-language';
  const isOnionHost = window.location.hostname.endsWith('.onion');
  const milestones = [
    { version: '0.1.1', titleKey: 'milestone.v011.title' },
    { version: '0.2.0', titleKey: 'milestone.v020.title' },
    { version: '0.2.1', titleKey: 'milestone.v021.title' },
    { version: '0.2.2', titleKey: 'milestone.v022.title' },
    { version: '0.2.2.1', titleKey: 'milestone.v0221.title' },
    { version: '0.2.2.2', label: '0.2.2.2-web.RC2', titleKey: 'milestone.v0222.title' },
    { version: '0.2.3', titleKey: 'milestone.v023.title' },
    { version: '0.2.4', titleKey: 'milestone.v024.title' },
    { version: '0.2.4.5', titleKey: 'milestone.v0245.title' },
    { version: '0.2.5', titleKey: 'milestone.v025.title' },
    { version: '0.2.6', titleKey: 'milestone.v026.title' },
    { version: '0.2.7', titleKey: 'milestone.v027.title' },
    { version: '0.2.8', titleKey: 'milestone.v028.title' },
    { version: '0.2.9', titleKey: 'milestone.v029.title' },
    { version: '0.2.9.5', titleKey: 'milestone.v0295.title' },
    { version: '0.2.9.6', titleKey: 'milestone.v0296.title' },
    { version: '0.2.9.7', titleKey: 'milestone.v0297.title' },
    { version: '0.2.9.8', titleKey: 'milestone.v0298.title' },
    { version: '0.2.9.9', titleKey: 'milestone.v0299.title' },
    { version: '0.3', titleKey: 'milestone.v03.title' },
    { version: '0.4', titleKey: 'milestone.v04.title' },
    { version: '0.5', titleKey: 'milestone.v05.title' },
    { version: '0.6', titleKey: 'milestone.v06.title' },
    { version: '0.7', titleKey: 'milestone.v07.title' },
    { version: '0.8', titleKey: 'milestone.v08.title' },
    { version: '0.9', titleKey: 'milestone.v09.title' },
    { version: '0.9.5', titleKey: 'milestone.v095.title' },
    { version: '1.0', titleKey: 'milestone.v10.title' },
    { version: '1.1', titleKey: 'milestone.v11.title' },
    { version: '1.2', titleKey: 'milestone.v12.title' },
    { version: '1.3', titleKey: 'milestone.v13.title' },
    { version: '1.4', titleKey: 'milestone.v14.title' }
  ];

  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
  let currentLanguage = 'ru';
  let releaseState = { version: RELEASE_TAG, publishedAt: '2026-10-06T23:08:40Z', assets: [] };
  let activeRoadmapFilter = 'all';

  function t(key, replacements = {}) {
    const dictionary = translations[currentLanguage] || translations.ru;
    const template = dictionary[key] ?? translations.ru[key] ?? key;
    return Object.entries(replacements).reduce(
      (value, [name, replacement]) => value.replaceAll(`{${name}}`, String(replacement)),
      template
    );
  }

  function normalizeVersion(value = '') {
    const match = String(value).trim().match(/v?(\d+(?:\.\d+){1,3})/i);
    return match ? match[1] : RELEASE_TAG.slice(1);
  }

  function compareVersions(a, b) {
    const aa = normalizeVersion(a).split('.').map(Number);
    const bb = normalizeVersion(b).split('.').map(Number);
    const length = Math.max(aa.length, bb.length, 4);
    for (let index = 0; index < length; index += 1) {
      const delta = (aa[index] || 0) - (bb[index] || 0);
      if (delta !== 0) return delta;
    }
    return 0;
  }

  function formatDate(value) {
    if (!value) return t('release.latest');
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t('release.latest');
    try {
      return new Intl.DateTimeFormat(localeByLanguage[currentLanguage] || localeByLanguage.ru, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC'
      }).format(date);
    } catch {
      return new Intl.DateTimeFormat(localeByLanguage.ru, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC'
      }).format(date);
    }
  }

  function readStoredLanguage() {
    try {
      return window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  function storeLanguage(language) {
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      // The selection still applies for the current page.
    }
  }

  function preferredLanguages() {
    if (Array.isArray(navigator.languages) && navigator.languages.length) return navigator.languages;
    return navigator.language ? [navigator.language] : [];
  }

  function updateMetadata() {
    document.title = t('meta.title');
    const description = qs('meta[name="description"]');
    const ogTitle = qs('meta[property="og:title"]');
    const ogDescription = qs('meta[property="og:description"]');
    if (description) description.content = t('meta.description');
    if (ogTitle) ogTitle.content = t('meta.ogTitle');
    if (ogDescription) ogDescription.content = t('meta.description');

    const schema = qs('#software-schema');
    if (!schema) return;
    try {
      const data = JSON.parse(schema.textContent || '{}');
      data.description = t('schema.description');
      schema.textContent = JSON.stringify(data, null, 2);
    } catch {
      // Keep the valid server-rendered schema if a browser extension changed it.
    }
  }

  function updateHistoryDates() {
    qsa('[data-history-date]').forEach((node) => {
      node.textContent = formatDate(node.dataset.historyDate);
    });
  }

  function updateMenuLabel() {
    const toggle = qs('[data-menu-toggle]');
    const label = qs('[data-menu-label]');
    if (!label) return;
    label.textContent = t(toggle?.getAttribute('aria-expanded') === 'true' ? 'menu.close' : 'menu.open');
  }

  function applyLanguage(language) {
    currentLanguage = translations[language] ? language : 'ru';
    document.documentElement.lang = localeByLanguage[currentLanguage] || localeByLanguage.ru;
    document.documentElement.dir = 'ltr';

    const select = qs('[data-language-select]');
    if (select) select.value = currentLanguage;

    qsa('[data-i18n]').forEach((node) => {
      node.textContent = t(node.dataset.i18n);
    });
    qsa('[data-i18n-html]').forEach((node) => {
      node.innerHTML = t(node.dataset.i18nHtml);
    });
    qsa('[data-i18n-title]').forEach((node) => {
      node.title = t(node.dataset.i18nTitle);
    });
    qsa('[data-i18n-aria]').forEach((node) => {
      node.setAttribute('aria-label', t(node.dataset.i18nAria));
    });

    updateMetadata();
    updateHistoryDates();
    updateMenuLabel();
    updateProgress(releaseState.version, releaseState.publishedAt);
    updateDownloads(releaseState.assets);
  }

  function setupLanguage() {
    const detected = resolveLanguage(readStoredLanguage(), preferredLanguages());
    try {
      applyLanguage(detected);
    } catch (error) {
      console.info('Kaigen locale unavailable; using Russian fallback.', error);
      applyLanguage('ru');
    }

    const select = qs('[data-language-select]');
    select?.addEventListener('change', () => {
      const selected = translations[select.value] ? select.value : 'ru';
      storeLanguage(selected);
      applyLanguage(selected);
    });
  }

  function setupHeader() {
    const header = qs('[data-header]');
    const onScroll = () => header?.classList.toggle('is-scrolled', window.scrollY > 16);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  function setupMenu() {
    const toggle = qs('[data-menu-toggle]');
    const nav = qs('[data-nav]');
    if (!toggle || !nav) return;

    const setOpen = (open) => {
      toggle.setAttribute('aria-expanded', String(open));
      nav.classList.toggle('is-open', open);
      document.body.classList.toggle('menu-open', open);
      updateMenuLabel();
    };

    toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
    qsa('a', nav).forEach((link) => link.addEventListener('click', () => setOpen(false)));
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setOpen(false);
    });
    window.addEventListener('resize', () => {
      if (window.innerWidth > 760) setOpen(false);
    });
  }

  function setupReveal() {
    const items = qsa('.reveal');
    if (!items.length) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || !('IntersectionObserver' in window)) {
      items.forEach((item) => item.classList.add('is-visible'));
      return;
    }

    items.forEach((item) => item.classList.add('pending'));
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.remove('pending');
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -35px' });

    items.forEach((item) => observer.observe(item));
  }

  function applyRoadmapFilter(filter = activeRoadmapFilter) {
    const buttons = qsa('[data-filter]');
    const cards = qsa('[data-version][data-category]');
    const completedCards = cards.filter((card) => card.classList.contains('is-complete'));
    const recentCompleted = new Set(completedCards.slice(-2));
    activeRoadmapFilter = filter;

    buttons.forEach((button) => {
      const active = button.dataset.filter === filter;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });

    cards.forEach((card) => {
      const categories = (card.dataset.category || '').split(/\s+/);
      const visible = filter === 'all'
        || (filter === 'upcoming'
          ? recentCompleted.has(card) || !card.classList.contains('is-complete')
          : filter === 'history'
            ? card.classList.contains('is-complete')
            : categories.includes(filter));
      card.hidden = !visible;
    });
  }

  function setupFilters() {
    const buttons = qsa('[data-filter]');
    const selected = buttons.find((button) => button.classList.contains('is-active'));
    activeRoadmapFilter = selected?.dataset.filter || 'all';
    buttons.forEach((button) => {
      button.addEventListener('click', () => {
        applyRoadmapFilter(button.dataset.filter || 'all');
      });
    });
    applyRoadmapFilter(activeRoadmapFilter);
  }

  function buildSegments() {
    const container = qs('[data-segments]');
    if (!container) return;
    container.innerHTML = milestones.map(() => '<i></i>').join('');
  }

  function updateProgress(currentVersion, publishedAt) {
    const normalized = normalizeVersion(currentVersion);
    const completedIndex = milestones.reduce((last, milestone, index) => (
      compareVersions(milestone.version, normalized) <= 0 ? index : last
    ), -1);
    const completedCount = Math.max(0, completedIndex + 1);
    const nextIndex = completedIndex + 1 < milestones.length ? completedIndex + 1 : -1;
    const currentCount = nextIndex >= 0 ? 1 : 0;
    const plannedCount = Math.max(0, milestones.length - completedCount - currentCount);
    const percent = Math.round((completedCount / milestones.length) * 100);

    qsa('[data-current-version]').forEach((node) => { node.textContent = `v${normalized}`; });
    qsa('[data-release-date]').forEach((node) => { node.textContent = formatDate(publishedAt); });
    qsa('[data-progress-percent]').forEach((node) => { node.textContent = `${percent}%`; });
    qsa('[data-completed-count]').forEach((node) => { node.textContent = String(completedCount); });
    qsa('[data-current-count]').forEach((node) => { node.textContent = String(currentCount); });
    qsa('[data-planned-count]').forEach((node) => { node.textContent = String(plannedCount); });

    const track = qs('[data-progress-track]');
    if (track) {
      track.setAttribute('aria-valuenow', String(percent));
      track.setAttribute('aria-valuetext', `${t('roadmap.progress')}: ${percent}%`);
      const fill = qs('span', track);
      if (fill) fill.style.width = `${percent}%`;
    }

    const nextMilestone = nextIndex >= 0 ? milestones[nextIndex] : null;
    qsa('[data-next-version]').forEach((node) => {
      node.textContent = nextMilestone ? `v${nextMilestone.label || nextMilestone.version}` : 'v1.4';
    });
    qsa('[data-next-title]').forEach((node) => {
      node.textContent = nextMilestone ? t(nextMilestone.titleKey) : t('roadmap.finished');
    });

    qsa('[data-segments] i').forEach((segment, index) => {
      segment.classList.toggle('is-complete', index < completedCount);
      segment.classList.toggle('is-current', index === nextIndex);
    });

    qsa('.milestone[data-version]').forEach((card) => {
      const version = card.dataset.version || '0.0.0';
      const isComplete = compareVersions(version, normalized) <= 0;
      const isLatestRelease = compareVersions(version, normalized) === 0;
      const isCurrent = nextMilestone?.version === version;
      const includedIn = card.dataset.includedIn;
      card.classList.toggle('is-complete', isComplete);
      card.classList.toggle('is-latest-release', isLatestRelease);
      card.classList.toggle('is-current', Boolean(isCurrent));
      const status = qs('.milestone-status', card);
      if (status) {
        status.textContent = isComplete
          ? (includedIn ? t('milestone.statusIncluded', { version: 'v' + includedIn }) : t('milestone.statusReleased'))
          : isCurrent
            ? t('milestone.statusNext')
            : t('milestone.statusPlanned');
      }
    });
    applyRoadmapFilter();
  }

  function findAsset(assets, platform) {
    const rules = {
      windowsMsi: /^Kaigen-installer-windows-x64\.msi$/i,
      windowsPortable: /^Kaigen-portable-windows-x64\.zip$/i,
      debian: /portable[-_ ]?debian.*\.zip$/i,
      macos: /portable[-_ ]?macos.*\.zip$/i,
      webInstaller: /^Kaigen-Web-Installer-0\.2\.9\.9\.sh$/i
    };
    return assets.find((asset) => rules[platform]?.test(asset.name || ''));
  }

  function updateDownloads(assets = []) {
    ['windowsMsi', 'windowsPortable', 'debian', 'macos', 'webInstaller'].forEach((platform) => {
      const link = qs(`[data-download="${platform}"]`);
      const asset = findAsset(assets, platform);
      if (!link) return;
      if (asset?.browser_download_url) {
        link.href = asset.browser_download_url;
        link.setAttribute('aria-label', t('downloads.assetAria', { name: asset.name }));
      } else if (!link.getAttribute('href')) {
        link.href = RELEASES_URL;
      }
    });
  }

  async function syncRelease() {
    updateProgress(releaseState.version, releaseState.publishedAt);
    updateDownloads(releaseState.assets);
    if (isOnionHost) return;
    try {
      const response = await fetch(API_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      });
      if (!response.ok) throw new Error(`GitHub API: ${response.status}`);
      const release = await response.json();
      releaseState = {
        version: release.tag_name || release.name || RELEASE_TAG,
        publishedAt: release.published_at || null,
        assets: Array.isArray(release.assets) ? release.assets : []
      };
      updateProgress(releaseState.version, releaseState.publishedAt);
      updateDownloads(releaseState.assets);
    } catch (error) {
      console.info('Kaigen release data unavailable; using bundled fallback.', error);
    }
  }

  function detectPlatform() {
    const ua = `${navigator.userAgent || ''} ${navigator.platform || ''}`.toLowerCase();
    let platform = '';
    if (ua.includes('win')) platform = 'windows';
    else if (ua.includes('mac')) platform = 'macos';
    else if (ua.includes('linux') || ua.includes('x11')) platform = 'debian';
    if (!platform) return;
    const card = qs(`[data-platform="${platform}"]`);
    if (!card) return;
    card.classList.add('is-recommended');
    const label = qs('.recommendation', card);
    if (label) label.hidden = false;
  }

  function showToast(message) {
    const toast = qs('[data-toast]');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('is-visible');
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove('is-visible'), 1800);
  }

  async function copyText(value) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }

  function setupCopyButtons() {
    qsa('[data-copy]').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          await copyText(button.dataset.copy || '');
          showToast(t('toast.copied'));
        } catch {
          showToast(t('toast.copyFailed'));
        }
      });
    });
  }

  function setupOnionLink() {
    const link = qs('[data-onion-link]');
    if (link && isOnionHost) link.hidden = true;
  }

  buildSegments();
  setupLanguage();
  setupHeader();
  setupMenu();
  setupReveal();
  setupFilters();
  setupCopyButtons();
  setupOnionLink();
  detectPlatform();
  syncRelease();
})();
