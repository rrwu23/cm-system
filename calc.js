/**
 * calc.js — the score, upload and submit logic behind addcompany.html.
 *
 * Input:  the #add-company-form element — the typed numbers plus the .html reports the
 *         user attaches to each analysis box.
 * Output: the ready/error state of every upload card, a console log of the full payload
 *         after each edit, and a POST to /addcompany when Submit is pressed.
 * Action: reads the form, checks each attached file is HTML, keeps the four /100 scores as
 *         whole marks (0..100, nudged one point at a time by the ▲/▼ buttons), checks the
 *         rank is a letter from A to F, prints the result, then posts every filled-in
 *         control to /addcompany as multipart/form-data, keyed by the sheet's own `name`
 *         attributes.
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

  // The four /100 marks: whole numbers, each with a ▲ / ▼ button that moves it by one point.
  const SCORE_FIELDS = [
    { field: 'moat_score', key: 'moatScore' },
    { field: 'cyclical_score', key: 'cyclicalScore' },
    { field: 'antifragile_score', key: 'antifragileScore' },
    { field: 'growth_score', key: 'growthScore' }
  ];
  // Rank is a letter grade the user picks from the Rank list, never a number.
  const GRADES = ['A', 'B', 'C', 'D', 'E', 'F'];

  const MAX_SCORE = 100;
  const MIN_SCORE = 0;
  const SCORE_STEP = 1;
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
   * Input: a raw score — a number, a numeric string, or null.
   * Output: a whole number inside 0..100, or null when there is no number.
   * Action: converts with toNumber(), rounds to the nearest whole mark, then clamps both ends.
   * Role: the sheet records integers only, so 55.5 becomes 56, 140 becomes 100 and any
   *       decimal typed by hand can never reach the dashboard.
   */
  function normalizeScore(value) {
    const number = toNumber(value);
    if (number === null) return null;
    return Math.min(MAX_SCORE, Math.max(MIN_SCORE, Math.round(number)));
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
   *         the thirteen file inputs alongside the typed fields. The rank stays a string,
   *         because it is the letter picked from the Rank list.
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
      rank: text('rank'),
      currentPrice: toNumber(text('current_price')),
      targetPrice: toNumber(text('target_price')),
      badPrice: toNumber(text('bad_price')),
      uploads: uploads
    };
  }

  /**
   * Input: a rank value — normally the letter from the Rank select.
   * Output: an upper-case grade 'A'..'F', or null when the value is not one of them.
   * Action: keeps only strings, trims and upper-cases them, then checks them against GRADES.
   * Role: the one rank rule on the sheet; the letter travels unchanged to the dashboard.
   */
  function normalizeGrade(value) {
    if (typeof value !== 'string') return null;

    const grade = value.trim().toUpperCase();
    return GRADES.indexOf(grade) === -1 ? null : grade;
  }

  /**
   * Input: the values object from readForm().
   * Output: { companyName, symbol, moatScore, cyclicalScore, antifragileScore,
   *           growthScore, currentPrice, targetPrice, badPrice, rank, uploads,
   *           uploadsValid }.
   * Action: rounds and clamps the four scores to whole 0..100 marks, keeps the rank only
   *         when it is a real A–F grade, keeps the three prices as typed, and flags any
   *         upload that is not HTML.
   * Role: the payload the dashboard needs; this is the object that gets logged.
   */
  function calculateScores(values) {
    const uploads = Array.isArray(values.uploads) ? values.uploads : [];

    return {
      companyName: values.companyName,
      symbol: values.symbol,
      moatScore: normalizeScore(values.moatScore),
      cyclicalScore: normalizeScore(values.cyclicalScore),
      antifragileScore: normalizeScore(values.antifragileScore),
      growthScore: normalizeScore(values.growthScore),
      currentPrice: toNumber(values.currentPrice),
      targetPrice: toNumber(values.targetPrice),
      badPrice: toNumber(values.badPrice),
      rank: normalizeGrade(values.rank),
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
   * Input: the <form> element and the `name` of a field.
   * Output: the matching control, or null when the page has no such field.
   * Action: asks the form's own element collection first, then falls back to a name selector.
   * Role: one lookup shared by the ▲ / ▼ stepper and the integer normaliser.
   */
  function findControl(form, field) {
    const collection = form.elements;
    if (collection && typeof collection.namedItem === 'function') {
      const control = collection.namedItem(field);
      if (control) return control;
    }
    return form.querySelector('[name="' + field + '"]');
  }

  /**
   * Input: the <form> element, a score field name ('moat_score' …) and a step (+1 or -1).
   * Output: the new whole score, or null when nothing changed.
   * Action: reads the field, moves it exactly one point, clamps it to 0..100 and writes the
   *         integer back; an empty field starts at 1 when stepping up and stays empty when
   *         stepping down. Then recalculates, so the hint and console follow the click.
   * Role: the ▲ / ▼ buttons — one click is always one whole mark.
   */
  function stepScore(form, field, delta) {
    const input = findControl(form, field);
    if (!input) return null;

    const step = delta < 0 ? -SCORE_STEP : SCORE_STEP;
    const current = normalizeScore(input.value);
    const next = current === null
      ? (step > 0 ? MIN_SCORE + SCORE_STEP : null)
      : normalizeScore(current + step);

    if (next === null || next === current) return null;

    input.value = String(next);
    recalculate(form, 'stepped');
    return next;
  }

  /**
   * Input: the <form> element and the latest scores object.
   * Output: nothing.
   * Action: disables ▲ once a score reads 100 and ▼ at 0 (or while the box is still empty),
   *         tolerating a page without the buttons.
   * Role: shows where the 0..100 range ends instead of ignoring the click in silence.
   */
  function syncSteppers(form, scores) {
    SCORE_FIELDS.forEach(function (entry) {
      const value = scores[entry.key];
      const up = form.querySelector('[data-step-for="' + entry.field + '"][data-step="1"]');
      const down = form.querySelector('[data-step-for="' + entry.field + '"][data-step="-1"]');

      if (up) up.disabled = value !== null && value >= MAX_SCORE;
      if (down) down.disabled = value === null || value <= MIN_SCORE;
    });
  }

  /**
   * Input: the <form> element.
   * Output: nothing.
   * Action: rewrites every score box that holds a value as a whole mark inside 0..100
   *         (55.5 → 56) and empties a box that holds no number at all.
   * Role: keeps the number boxes integral, so the browser's step="1" check never blocks
   *       Submit over a stray decimal the user typed.
   */
  function normalizeScoreInputs(form) {
    SCORE_FIELDS.forEach(function (entry) {
      const input = findControl(form, entry.field);
      if (!input || input.value === '') return;

      const value = normalizeScore(input.value);
      input.value = value === null ? '' : String(value);
    });
  }

  /**
   * Input: the <form> element and a click event.
   * Output: nothing.
   * Action: finds the nearest ▲ / ▼ button and applies its data-step to its
   *         data-step-for field; clicks anywhere else are ignored.
   * Role: lets one listener serve all four steppers, so the markup stays declarative.
   */
  function handleStepClick(form, event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;

    const button = target.closest('[data-step-for]');
    if (!button) return;

    const field = button.getAttribute('data-step-for');
    const delta = toNumber(button.getAttribute('data-step'));
    if (!field || delta === null || delta === 0) return;

    stepScore(form, field, delta);
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
   * Action: reads, calculates, paints the upload cards, and marks the ▲ / ▼ buttons that
   *         have reached the end of the 0..100 range.
   * Role: one call shared by load, typing, file pick, stepper click, reset and submit.
   */
  function refresh(form) {
    const values = readForm(form);
    const scores = calculateScores(values);
    renderUploads(form, scores.uploads);
    syncSteppers(form, scores);
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

    // multipart/form-data on purpose, and no Content-Type header: a FormData body makes
    // fetch write `multipart/form-data; boundary=<random>` itself. Hand-setting the header
    // would drop the boundary, so the server could take the scores but never parse a report.
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
   * Action: finds the form, attaches input/change/click/reset/submit listeners, calculates
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

    // Rounding on change keeps a typed 55.5 from tripping the browser's step="1" check.
    form.addEventListener('change', function () {
      normalizeScoreInputs(form);
      recalculate(form, 'changed');
    });

    // One delegated listener serves all eight ▲ / ▼ buttons.
    form.addEventListener('click', function (event) {
      handleStepClick(form, event);
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
      stepScore: stepScore,
      normalizeScore: normalizeScore,
      normalizeGrade: normalizeGrade,
      describeUpload: describeUpload,
      formatBytes: formatBytes
    };

    console.log(LOG_PREFIX + ' ready — helpers available on window.companyCalc');
  }

  init();
})();

