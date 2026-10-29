/**
 * calc.js — the score, ratio and upload maths behind addcompany.html.
 *
 * Input:  the #add-company-form element — the typed numbers plus the .html reports the
 *         user attaches to each analysis box.
 * Output: the two WL ratios rendered into their read-only boxes, the ready/error state of
 *         every upload card, and a console log of the full payload after each edit and
 *         on submit.
 * Action: reads the form, checks each attached file is HTML, clamps the three /100
 *         scores, derives WL-base and WL-optimistic from the three prices, then prints
 *         the result.
 * Role: keeps addcompany.html markup-only; this file is the single place where the
 *       numbers and the upload rules are worked out, so the page and any future API
 *       call share one source.
 *
 * Loaded with <script src="calc.js" defer> — no build step, no dependencies.
 */
(function () {
  'use strict';

  const FORM_ID = 'add-company-form';
  const HINT_ID = 'calc-hint';
  const RATIO_IDS = { base: 'wl-ratio-base', optimistic: 'wl-ratio-optimistic' };

  // Every analysis box on the sheet is an uploaded .html report, not free text.
  const UPLOAD_FIELDS = [
    'company_profile',
    'industry_profile',
    'company_position',
    'financial_quality',
    'strategy_vision',
    'alpha_analysis',
    'beta_analysis',
    'antifragile_analysis',
    'wl_l_analysis',
    'additional_analysis_1',
    'additional_analysis_2',
    'additional_analysis_3'
  ];
  const HTML_NAME = /\.html?$/i;
  const HTML_TYPES = ['text/html', 'application/xhtml+xml'];

  const MAX_SCORE = 100;
  const DEBOUNCE_MS = 200;
  const LOG_PREFIX = '[calc]';

  let pending = null;

  /**
   * Input: a raw form value — usually a string from FormData, sometimes a number.
   * Output: a finite number, or null for blank / non-numeric input.
   * Action: trims strings, rejects empty text, then converts with Number().
   * Role: the only string-to-number gate, so every later step can trust null.
   */
  function toNumber(raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== 'string') return null;

    const text = raw.trim();
    if (text === '') return null;

    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  }

  /**
   * Input: a number or null.
   * Output: the same number limited to 0..100, or null when there is no number.
   * Action: clamps both ends while keeping decimals.
   * Role: stops entered scores like 140 or -5 from reaching the dashboard.
   */
  function clampScore(value) {
    if (value === null) return null;
    return Math.min(MAX_SCORE, Math.max(0, value));
  }

  /**
   * Input: numerator and denominator, both possibly null.
   * Output: the quotient, or null when the division cannot be done.
   * Action: bails out on null input, non-finite values, and a zero denominator.
   * Role: shared safety net for both WL ratios.
   */
  function safeDivide(numerator, denominator) {
    if (numerator === null || denominator === null) return null;
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
    if (denominator === 0) return null;
    return numerator / denominator;
  }

  /**
   * Input: two numbers or nulls.
   * Output: their difference, or null when either side is missing.
   * Action: guards the subtraction so callers never do maths on null.
   * Role: keeps the ratio formulas below readable.
   */
  function difference(left, right) {
    if (left === null || right === null) return null;
    return left - right;
  }

  /**
   * Input: { currentPrice, targetPrice, badPrice } — numbers or null.
   * Output: { base, optimistic } — each a number, or null when it cannot be derived.
   * Action: applies the sheet's two formulas
   *           WL-base       = (target - current) / (current - bad)
   *           WL-optimistic = (target - bad)     / (current - bad)
   * Role: the core calculation of the page; addcompany.html only shows the result.
   */
  function wlRatios(prices) {
    const current = toNumber(prices.currentPrice);
    const target = toNumber(prices.targetPrice);
    const bad = toNumber(prices.badPrice);
    const denominator = difference(current, bad);

    return {
      base: safeDivide(difference(target, current), denominator),
      optimistic: safeDivide(difference(target, bad), denominator)
    };
  }

  /**
   * Input: any FormData entry.
   * Output: true when the value behaves like a File (a name plus a numeric size).
   * Action: duck-types instead of using `instanceof File`, so the same code also runs
   *         in the Node test harness.
   * Role: lets readForm() tell an attached .html report from an untouched file input.
   */
  function isFileLike(value) {
    return !!value && typeof value === 'object' &&
      typeof value.name === 'string' && typeof value.size === 'number';
  }

  /**
   * Input: a File-like object.
   * Output: true when it is an HTML document — decided by name first, then MIME type.
   * Action: matches .html/.htm case-insensitively, then accepts text/html and
   *         application/xhtml+xml (some browsers report an empty type for local files).
   * Role: the single rule that keeps non-HTML uploads out of the company record.
   */
  function isHtmlFile(file) {
    if (!isFileLike(file)) return false;
    if (HTML_NAME.test(file.name)) return true;
    return HTML_TYPES.indexOf((file.type || '').toLowerCase()) !== -1;
  }

  /**
   * Input: a byte count.
   * Output: a short human string such as "12.4 KB", or "0 B".
   * Action: scales through B/KB/MB/GB, keeps one decimal above bytes, drops a trailing .0.
   * Role: the size hint under a picked file and the value shown in the console table.
   */
  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
      value = value / 1024;
      unit += 1;
    }

    const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
    return (rounded.slice(-2) === '.0' ? rounded.slice(0, -2) : rounded) + ' ' + units[unit];
  }

  /**
   * Input: a form field name and the matching FormData value.
   * Output: { field, name, size, sizeLabel, type, valid }, or null when nothing is attached.
   * Action: ignores untouched file inputs (browsers report a nameless, zero-byte File).
   * Role: turns a file input into the metadata the console and a future POST will carry.
   */
  function describeUpload(field, value) {
    if (!isFileLike(value) || value.name === '') return null;

    return {
      field: field,
      name: value.name,
      size: value.size,
      sizeLabel: formatBytes(value.size),
      type: value.type || 'unknown',
      valid: isHtmlFile(value)
    };
  }

  /**
   * Input: the <form> element.
   * Output: a plain object with camelCase keys — numbers where numbers are expected, and
   *         an uploads array holding one metadata entry per attached .html report.
   * Action: reads through FormData (so it follows the markup), trims text, and describes
   *         the twelve file inputs alongside the typed fields.
   * Role: turns the DOM into the data that calculateScores() and the console use.
   */
  function readForm(form) {
    const data = new FormData(form);
    const text = (name) => {
      const value = data.get(name);
      return typeof value === 'string' ? value.trim() : '';
    };

    const uploads = UPLOAD_FIELDS
      .map((field) => describeUpload(field, data.get(field)))
      .filter(Boolean);

    return {
      companyName: text('company_name'),
      symbol: text('symbol'),
      alphaScore: toNumber(text('alpha_score')),
      betaScore: toNumber(text('beta_score')),
      antifragileScore: toNumber(text('antifragile_score')),
      rank: toNumber(text('rank')),
      currentPrice: toNumber(text('current_price')),
      targetPrice: toNumber(text('target_price')),
      badPrice: toNumber(text('bad_price')),
      uploads: uploads
    };
  }

  /**
   * Input: a rank value — number, numeric string, or null.
   * Output: a whole number of at least 1, or null when unavailable.
   * Action: converts, rounds and floors at 1.
   * Role: keeps the rank column of the dashboard a usable integer.
   */
  function normalizeRank(value) {
    const number = toNumber(value);
    return number === null ? null : Math.max(1, Math.round(number));
  }

  /**
   * Input: the values object from readForm().
   * Output: { companyName, symbol, alphaScore, betaScore, antifragileScore,
   *           wlRatioBase, wlRatioOptimistic, rank, uploads, uploadsValid }.
   * Action: clamps the three scores to 0..100, rounds the rank to a whole number, asks
   *         wlRatios() for the two ratios, and flags any upload that is not HTML.
   * Role: the payload the dashboard needs; this is the object that gets logged.
   */
  function calculateScores(values) {
    const ratios = wlRatios(values);
    const uploads = Array.isArray(values.uploads) ? values.uploads : [];

    return {
      companyName: values.companyName,
      symbol: values.symbol,
      alphaScore: clampScore(toNumber(values.alphaScore)),
      betaScore: clampScore(toNumber(values.betaScore)),
      antifragileScore: clampScore(toNumber(values.antifragileScore)),
      wlRatioBase: ratios.base,
      wlRatioOptimistic: ratios.optimistic,
      rank: normalizeRank(values.rank),
      uploads: uploads,
      uploadsValid: uploads.every((upload) => upload.valid)
    };
  }


  /**
   * Input: a ratio number or null.
   * Output: a two-decimal string, or '' for a ratio that does not exist.
   * Action: formats without trailing noise.
   * Role: keeps the read-only boxes empty instead of showing "null".
   */
  function formatRatio(value) {
    return value === null ? '' : value.toFixed(2);
  }

  /**
   * Input: the <form> element and a scores object.
   * Output: nothing.
   * Action: writes the two ratios into their read-only fields.
   * Role: the only place the calculated values touch the DOM.
   */
  function renderRatios(form, scores) {
    const base = form.querySelector('#' + RATIO_IDS.base);
    const optimistic = form.querySelector('#' + RATIO_IDS.optimistic);

    if (base) base.value = formatRatio(scores.wlRatioBase);
    if (optimistic) optimistic.value = formatRatio(scores.wlRatioOptimistic);
  }

  /**
   * Input: the <form> element and the uploads array from readForm().
   * Output: nothing.
   * Action: per file box — writes the file name, a size hint, and a ready/error data-state;
   *         clears the box back to "Choose a .html file" when no file is attached.
   * Role: shows on the page exactly which reports the console (and a future POST) carries.
   */
  function renderUploads(form, uploads) {
    const list = Array.isArray(uploads) ? uploads : [];

    UPLOAD_FIELDS.forEach(function (field) {
      const card = form.querySelector('[data-upload="' + field + '"]');
      const meta = form.querySelector('[data-upload-meta="' + field + '"]');
      if (!card || !meta) return;

      const nameEl = card.querySelector('[data-upload-name]');
      const upload = list.find((item) => item.field === field) || null;

      if (!upload) {
        card.dataset.state = '';
        meta.dataset.state = '';
        if (nameEl) nameEl.textContent = 'Choose a .html file';
        meta.textContent = 'No file selected';
        return;
      }

      card.dataset.state = upload.valid ? 'ready' : 'error';
      meta.dataset.state = upload.valid ? 'ready' : 'error';
      if (nameEl) nameEl.textContent = upload.name;
      meta.textContent = upload.valid
        ? 'HTML · ' + upload.sizeLabel + ' attached'
        : 'Not HTML — pick a .html file';
    });
  }

  /**
   * Input: a scores object.
   * Output: nothing.
   * Action: prints one labelled log line, a table of the numeric scores, a table of the
   *         attached uploads when there are any, and a warning per rejected file.
   * Role: the console output the page promises (and the quickest way to check a build).
   */
  function logScores(scores) {
    console.log(LOG_PREFIX + ' scores', scores);
    console.table({
      alphaScore: scores.alphaScore,
      betaScore: scores.betaScore,
      antifragileScore: scores.antifragileScore,
      wlRatioBase: scores.wlRatioBase,
      wlRatioOptimistic: scores.wlRatioOptimistic,
      rank: scores.rank
    });

    if (scores.uploads.length > 0) {
      console.table(scores.uploads);
    }

    scores.uploads
      .filter((upload) => !upload.valid)
      .forEach(function (upload) {
        console.warn(LOG_PREFIX + ' rejected ' + upload.field + ': ' +
          upload.name + ' is not .html');
      });
  }

  /**
   * Input: the <form> element.
   * Output: { values, scores } for the current form state.
   * Action: reads, calculates, paints the ratios and the upload cards.
   * Role: one call shared by load, typing, file pick, reset and submit.
   */
  function refresh(form) {
    const values = readForm(form);
    const scores = calculateScores(values);
    renderRatios(form, scores);
    renderUploads(form, scores.uploads);
    return { values: values, scores: scores };
  }

  /**
   * Input: the <form> element and the latest scores.
   * Output: nothing.
   * Action: picks the status message — rejected uploads first, then ratio readiness.
   * Role: gives on-page feedback that the calculation ran, next to the console output.
   */
  function updateHint(form, scores) {
    const hint = document.getElementById(HINT_ID);
    if (!hint) return;

    const uploads = scores.uploads || [];
    const rejected = uploads.filter((upload) => !upload.valid).length;
    const ready = scores.wlRatioBase !== null && scores.wlRatioOptimistic !== null;

    if (rejected > 0) {
      hint.dataset.state = 'error';
      hint.textContent = 'Only .html reports are accepted — ' + rejected +
        (rejected === 1 ? ' upload needs' : ' uploads need') + ' replacing.';
      return;
    }

    if (ready) {
      hint.dataset.state = 'done';
      hint.textContent = 'Ratios updated — ' + uploads.length +
        (uploads.length === 1 ? ' .html report attached' : ' .html reports attached') +
        '; scores are in the console.';
      return;
    }

    hint.dataset.state = '';
    hint.textContent = 'Fill in current, target and bad price to see both ratios.';
  }

  /**
   * Input: the <form> element and a reason tag ('initial' | 'edited' | 'changed' | …).
   * Output: { values, scores } of the recalculation.
   * Action: refreshes, updates the hint and logs the scores with the reason.
   * Role: single path for every recalculation, so no edit goes unlogged.
   */
  function recalculate(form, reason) {
    window.clearTimeout(pending);
    const result = refresh(form);
    updateHint(form, result.scores);
    console.log(LOG_PREFIX + ' ' + reason, result.scores);
    return result;
  }

  /**
   * Input: the <form> element.
   * Output: nothing.
   * Action: debounces recalculation while the user types or picks files.
   * Role: keeps number typing from logging on every keystroke.
   */
  function scheduleRecalculate(form) {
    window.clearTimeout(pending);
    pending = window.setTimeout(function () {
      recalculate(form, 'edited');
    }, DEBOUNCE_MS);
  }

  /**
   * Input: the submit event.
   * Output: nothing (the page never navigates yet).
   * Action: stops the default post, recalculates immediately, logs the payload.
   * Role: wires the amber Submit button to the calculation until an API exists.
   */
  function handleSubmit(event) {
    event.preventDefault();
    window.clearTimeout(pending);
    logScores(recalculate(event.currentTarget, 'submitted').scores);
  }

  /**
   * Input: none.
   * Output: nothing.
   * Action: finds the form, attaches input/change/reset/submit listeners, calculates
   *         once on load, exposes helpers on window.companyCalc.
   * Role: entry point of the file; runs after the DOM is parsed (defer).
   */
  function init() {
    const form = document.getElementById(FORM_ID);
    if (!form) {
      console.warn(LOG_PREFIX + ' form #' + FORM_ID + ' not found on this page');
      return;
    }

    form.addEventListener('input', function () {
      scheduleRecalculate(form);
    });

    form.addEventListener('change', function () {
      recalculate(form, 'changed');
    });

    form.addEventListener('reset', function () {
      window.setTimeout(function () {
        recalculate(form, 'reset');
      }, 0);
    });

    form.addEventListener('submit', handleSubmit);

    recalculate(form, 'initial');

    // Small console handle for ad-hoc checking, e.g. companyCalc.wlRatios({ ... }).
    window.companyCalc = {
      wlRatios: wlRatios,
      calculateScores: calculateScores,
      readForm: readForm,
      refresh: refresh,
      describeUpload: describeUpload,
      formatBytes: formatBytes
    };

    console.log(LOG_PREFIX + ' ready — helpers available on window.companyCalc');
  }

  init();
})();

