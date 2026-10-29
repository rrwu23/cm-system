/**
 * calc.js — the score, upload and submit logic behind addcompany.html.
 *
 * Input:  the #add-company-form element — the typed numbers plus the .html reports the
 *         user attaches to each analysis box.
 * Output: the ready/error state of every upload card, a console log of the full payload
 *         after each edit, and a POST to /addcompany when Submit is pressed.
 * Action: reads the form, checks each attached file is HTML, clamps the four /100 scores,
 *         prints the result, then posts every filled-in control to /addcompany as
 *         multipart/form-data, keyed by the sheet's own `name` attributes.
 * Role: keeps addcompany.html markup-only; this file is the single place where the
 *       numbers, the upload rules and the one network call live.
 *
 * Loaded with <script src="calc.js" defer> — no build step, no dependencies.
 */
(function () {
  'use strict';

  const FORM_ID = 'add-company-form';
  const HINT_ID = 'calc-hint';
  // Where Submit posts the sheet — relative to the page, so it follows whatever host
  // serves the app. Prefix it with API_BASE if the endpoint ever moves to the api host
  // the dashboard reads from.
  const SUBMIT_PATH = '/addcompany';

  // Every analysis box on the sheet is an uploaded .html report, not free text.
  const UPLOAD_FIELDS = [
    'company_profile',
    'industry_profile',
    'company_position',
    'financial_quality',
    'strategy_vision',
    'moat_analysis',
    'cyclical_analysis',
    'antifragile_analysis',
    'growth_momentum_analysis',
    'scenario_stress_analysis',
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
  let submitting = false;

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
   *         the thirteen file inputs alongside the typed fields.
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
      moatScore: toNumber(text('moat_score')),
      cyclicalScore: toNumber(text('cyclical_score')),
      antifragileScore: toNumber(text('antifragile_score')),
      growthScore: toNumber(text('growth_score')),
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
   * Output: { companyName, symbol, moatScore, cyclicalScore, antifragileScore,
   *           growthScore, currentPrice, targetPrice, badPrice, rank, uploads,
   *           uploadsValid }.
   * Action: clamps the four scores to 0..100, rounds the rank to a whole number, keeps
   *         the three prices as typed, and flags any upload that is not HTML.
   * Role: the payload the dashboard needs; this is the object that gets logged.
   */
  function calculateScores(values) {
    const uploads = Array.isArray(values.uploads) ? values.uploads : [];

    return {
      companyName: values.companyName,
      symbol: values.symbol,
      moatScore: clampScore(toNumber(values.moatScore)),
      cyclicalScore: clampScore(toNumber(values.cyclicalScore)),
      antifragileScore: clampScore(toNumber(values.antifragileScore)),
      growthScore: clampScore(toNumber(values.growthScore)),
      currentPrice: toNumber(values.currentPrice),
      targetPrice: toNumber(values.targetPrice),
      badPrice: toNumber(values.badPrice),
      rank: normalizeRank(values.rank),
      uploads: uploads,
      uploadsValid: uploads.every((upload) => upload.valid)
    };
  }

  /**
   * Input: the <form> element and the scores object from calculateScores().
   * Output: a FormData whose keys are the sheet's own `name` attributes, in sheet order.
   * Action: appends the identity, the four clamped scores, rank and the three prices, then
   *         every attached .html report; anything left blank is skipped. The files are read
   *         back from the form itself, so the browser keeps their real name and MIME type.
   * Role: the exact request body Submit posts to /addcompany — no renaming layer, so a
   *       backend field is found by reading the `name` attributes of addcompany.html.
   */
  function buildSubmission(form, scores) {
    const body = new FormData();

    const add = function (name, value) {
      if (value === null || value === undefined || value === '') return;
      body.append(name, String(value));
    };

    add('company_name', scores.companyName);
    add('symbol', scores.symbol);
    add('moat_score', scores.moatScore);
    add('cyclical_score', scores.cyclicalScore);
    add('antifragile_score', scores.antifragileScore);
    add('growth_score', scores.growthScore);
    add('rank', scores.rank);
    add('current_price', scores.currentPrice);
    add('target_price', scores.targetPrice);
    add('bad_price', scores.badPrice);

    const raw = new FormData(form);
    UPLOAD_FIELDS.forEach(function (field) {
      const file = raw.get(field);
      if (isFileLike(file) && file.name) body.append(field, file, file.name);
    });

    return body;
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
      moatScore: scores.moatScore,
      cyclicalScore: scores.cyclicalScore,
      antifragileScore: scores.antifragileScore,
      growthScore: scores.growthScore,
      currentPrice: scores.currentPrice,
      targetPrice: scores.targetPrice,
      badPrice: scores.badPrice,
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
   * Action: reads, calculates, and paints the upload cards.
   * Role: one call shared by load, typing, file pick, reset and submit.
   */
  function refresh(form) {
    const values = readForm(form);
    const scores = calculateScores(values);
    renderUploads(form, scores.uploads);
    return { values: values, scores: scores };
  }

  /**
   * Input: the text for the sticky-footer status line and its data-state ('', 'done',
   *        'warn' or 'error').
   * Output: nothing.
   * Action: writes #calc-hint, tolerating a page without it.
   * Role: the single writer for the status line, so form states and request states cannot
   *       drift apart in wording or colour.
   */
  function showHint(text, state) {
    const hint = document.getElementById(HINT_ID);
    if (!hint) return;
    hint.dataset.state = state || '';
    hint.textContent = text;
  }

  /**
   * Input: the <form> element and the latest scores.
   * Output: nothing.
   * Action: picks the status message — rejected uploads first, then whether any report
   *         is attached yet.
   * Role: gives on-page feedback that the calculation ran, next to the console output.
   */
  function updateHint(form, scores) {
    const uploads = scores.uploads || [];
    const rejected = uploads.filter((upload) => !upload.valid).length;

    if (rejected > 0) {
      showHint('Only .html reports are accepted — ' + rejected +
        (rejected === 1 ? ' upload needs' : ' uploads need') + ' replacing.', 'error');
      return;
    }

    if (uploads.length > 0) {
      showHint(uploads.length +
        (uploads.length === 1 ? ' .html report attached' : ' .html reports attached') +
        '; Submit posts the sheet to ' + SUBMIT_PATH + '.', 'done');
      return;
    }

    showHint('Fill in the scores and attach the .html reports — Submit posts the sheet to ' +
      SUBMIT_PATH + '.', '');
  }

  /**
   * Input: the <form> element and a flag.
   * Output: nothing.
   * Action: disables the amber Submit button while a request is in flight.
   * Role: stops a double click from posting the thirteen reports twice.
   */
  function setSubmitting(form, busy) {
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = busy;
  }

  /**
   * Input: the <form> element.
   * Output: a Promise that settles once the server answered, or null when nothing was sent.
   * Action: recalculates, refuses to post while a card is red, builds the body with
   *         buildSubmission(), POSTs it to /addcompany as multipart/form-data, then reports
   *         the outcome in the sticky footer.
   * Role: the only network call in the app — the page itself never navigates away, so a
   *       failed save leaves every typed value and every chosen report in place.
   */
  function submitForm(form) {
    if (submitting) return Promise.resolve(null);
    submitting = true;

    const scores = recalculate(form, 'submitted').scores;
    logScores(scores);

    if (!scores.uploadsValid) {
      submitting = false;
      return Promise.resolve(null); // updateHint() already flagged the rejected report
    }

    setSubmitting(form, true);
    showHint('Saving — posting to ' + SUBMIT_PATH + '.', 'warn');

    return fetch(SUBMIT_PATH, {
      method: 'POST',
      body: buildSubmission(form, scores),
      credentials: 'include'
    }).then(function (response) {
      if (response.ok) {
        showHint('Saved — ' + SUBMIT_PATH + ' answered HTTP ' + response.status + '.', 'done');
      } else if (response.status === 401 || response.status === 403) {
        showHint('Not saved — the session was refused (HTTP ' + response.status +
          '). Sign in again, then Submit once more.', 'error');
      } else {
        showHint('Not saved — ' + SUBMIT_PATH + ' answered HTTP ' + response.status + '.',
          'error');
      }
      return response;
    }).catch(function (error) {
      const reason = (error && error.message) ? error.message : 'network error';
      showHint('Not saved — could not reach ' + SUBMIT_PATH + ' (' + reason + ').', 'error');
      return null;
    }).then(function (response) {
      submitting = false;
      setSubmitting(form, false);
      return response;
    });
  }

  /**
   * Input: the submit event.
   * Output: the Promise from submitForm(), so a caller can wait for the server.
   * Action: stops the browser's own post, recalculates at once and sends the sheet.
   * Role: wires the amber Submit button to POST /addcompany.
   */
  function handleSubmit(event) {
    event.preventDefault();
    window.clearTimeout(pending);
    return submitForm(event.currentTarget);
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

    // Small console handle for ad-hoc checking, e.g. companyCalc.calculateScores({ ... }).
    window.companyCalc = {
      calculateScores: calculateScores,
      readForm: readForm,
      refresh: refresh,
      buildSubmission: buildSubmission,
      submitForm: submitForm,
      describeUpload: describeUpload,
      formatBytes: formatBytes
    };

    console.log(LOG_PREFIX + ' ready — helpers available on window.companyCalc');
  }

  init();
})();

