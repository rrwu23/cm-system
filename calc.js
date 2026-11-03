/**
 * calc.js — the score, upload and submit logic behind addcompany.html.
 *
 * Input:  the #add-company-form element — the typed numbers plus the .html reports the
 *         user attaches to each analysis box.
 * Output: the ready/error state of every upload card, a console log of the full payload
 *         after each edit, and a POST to /addcompany when Submit is pressed.
 * Action: reads the form, checks each attached file is HTML, keeps the four /100 scores as
 *         whole marks (0..100, nudged one point at a time by the ▲/▼ buttons), keeps the
 *         winning probability as a percentage (0..100 with up to one decimal), checks the
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
  // Where Submit posts the sheet: the API host — the same one login.html / home.html /
  // index.html read from. Absolute, never relative: this page is served by static hosting,
  // which answers 405 to any POST on a static route, so a relative "/addcompany" never
  // reaches the API at all (that 405 is the static host, not the backend).
  const API_BASE = 'https://api.kidsfunbank.ca';
  const SUBMIT_PATH = API_BASE + '/addcompany';
  const INVENTORY_PATH = API_ABSE + '/inventory_step'
  // The footer names the endpoint "/addcompany" — short enough for the sticky bar, and the
  // same words the static markup uses before this script runs. SUBMIT_PATH stays absolute
  // because the page host only serves GETs.
  const SUBMIT_LABEL = '/addcompany';

  // Every analysis box on the sheet is an uploaded .html report, not free text.
  const UPLOAD_FIELDS = [
    'company_profile',
    'industry_map',
    'company_position',
    'financial_quality',
    'strategy_vision',
    'moat_analysis',
    'cyclical_analysis',
    'anti_fragile_analysis',
    'growth_momentum_analysis',
    'scenario_stress_analysis',
    'additional_analysis_1',
    'additional_analysis_2',
    'additional_analysis_3'
  ];
  const HTML_NAME = /\.html?$/i;
  const HTML_TYPES = ['text/html', 'application/xhtml+xml'];

  // The four /100 marks: whole numbers, each with a ▲ / ▼ button that moves it by one point.
  // `label` is the name the sheet prints, used whenever the app has to say which box it
  // corrected — the page should never rewrite a score without naming it.
  const SCORE_FIELDS = [
    { field: 'moat_score', key: 'moatScore', label: 'Moat score' },
    { field: 'cyclical_score', key: 'cyclicalScore', label: 'Cyclical score' },
    { field: 'anti_fragile_score', key: 'antifragileScore', label: 'Anti-fragile score' },
    { field: 'growth_score', key: 'growthScore', label: 'Growth score' }
  ];
  // Rank is a letter grade the user picks from the Rank list, never a number.
  const GRADES = ['A', 'B', 'C', 'D', 'E', 'F'];

  // The odd one out in the Scores card: a percentage, not a mark out of 100. It keeps up to
  // one decimal (62.5 %) and has no ▲ / ▼ buttons — a measured probability is typed, not
  // nudged — so it is normalised by normalizePercent() and its own limits.
  const PERCENT_FIELDS = [
    { field: 'winning_probability', key: 'winningProbability', label: 'Winning probability' }
  ];
  const MIN_PERCENT = 0;
  const MAX_PERCENT = 100;
  // One decimal is as fine as a probability needs; a third decimal is rounded away rather
  // than left in the box, where step="0.1" would block Submit.
  const PERCENT_DECIMALS = 1;

  const MAX_SCORE = 100;
  const MIN_SCORE = 0;
  const SCORE_STEP = 1;
  // The clause the footer adds after naming a box it corrected, one per family of boxes.
  const SCORE_TAIL = 'scores are whole marks from 0 to 100';
  const PERCENT_TAIL = 'a probability runs from 0 to 100 percent';
  // The API's own limits: CompanyIn declares symbol as 1–32 characters and company_name
  // as up to 300. A longer value cannot be "fixed later" on the server — it answers 422 —
  // so the payload is cut to the length the model accepts before it is appended.
  const MAX_SYMBOL = 32;
  const MAX_NAME = 300;
  const DEBOUNCE_MS = 200;
  const LOG_PREFIX = '[calc]';

  let pending = null;
  let submitting = false;
  // Set when the app itself rewrote a score box while the analyst was leaving it. The Submit
  // click that caused that blur would otherwise post the corrected value unseen.
  let correctedFresh = false;

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
   * Input: a raw percentage — a number, a numeric string, or null.
   * Output: a number inside 0..100 with at most one decimal, or null when there is no number.
   * Action: converts with toNumber(), rounds to one decimal place, then clamps both ends.
   * Role: the winning probability's rule — 62.5 stays 62.5, 62.55 becomes 62.6, 140 becomes
   *       100 and -5 becomes 0, so the box never holds a value step="0.1" would reject.
   */
  function normalizePercent(value) {
    const number = toNumber(value);
    if (number === null) return null;

    const factor = Math.pow(10, PERCENT_DECIMALS);
    const rounded = Math.round(number * factor) / factor;
    return Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, rounded));
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
      antifragileScore: toNumber(text('anti_fragile_score')),
      growthScore: toNumber(text('growth_score')),
      winningProbability: toNumber(text('winning_probability')),
      rank: text('rank'),
      goodPrice: toNumber(text('good_price')),
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
   *           growthScore, winningProbability, goodPrice, targetPrice, badPrice, rank,
   *           uploads, uploadsValid }.
   * Action: rounds and clamps the four scores to whole 0..100 marks, keeps the winning
   *         probability as a 0..100 percentage (one decimal), keeps the rank only when it is
   *         a real A–F grade, keeps the three prices as typed, and flags any upload that is
   *         not HTML.
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
      winningProbability: normalizePercent(values.winningProbability),
      goodPrice: toNumber(values.goodPrice),
      targetPrice: toNumber(values.targetPrice),
      badPrice: toNumber(values.badPrice),
      rank: normalizeGrade(values.rank),
      uploads: uploads,
      uploadsValid: uploads.every((upload) => upload.valid)
    };
  }

  /**
   * Input: a form value and the longest text the API accepts for it.
   * Output: the value as a string cut to that many characters (null/undefined pass through).
   * Action: coerces to text, then slices from the front — the part a company name or a
   *         ticker keeps when it is too long.
   * Role: keeps the POST /addcompany body inside the length limits of the API's
   *       CompanyIn model (symbol 1–32, company_name ≤ 300), so a paste cannot 422.
   */
  function clip(value, max) {
    if (value === null || value === undefined) return value;
    return String(value).slice(0, max);
  }

  /**
   * Input: the <form> element and the scores object from calculateScores().
   * Output: a FormData whose keys are the sheet's own `name` attributes, in sheet order.
   * Action: appends the identity, the four clamped scores, the winning probability in
   *         percent, rank and the three prices the sheet has, then every attached .html
   *         report; anything left blank is skipped. The files are read back from the form
   *         itself, so the browser keeps their real name and MIME type.
   * Role: the exact request body Submit posts to /addcompany — no renaming layer, so a
   *       backend field is found by reading the `name` attributes of addcompany.html.
   *       Every key here except `winning_probability` is a field of the API's CompanyUploadIn
   *       model, and nothing else is added:
   *       anti_fragile_score, anti_fragile_analysis and industry_map are spelled the way the
   *       model spells them, so a section is never dropped. There is no `date` part (the
   *       model types `date` as None and the row is dated server-side), and no
   *       `current_price` part either — CompanyUploadIn has no such field. The model's prices
   *       are good_price, target_price and bad_price, and the sheet now enters all three.
   *       `winning_probability` is the one part the live model does not declare yet: the
   *       sheet sends it under the name the column should take, so the day the API grows
   *       that field the value is already in the body (see PENDING_FIELDS in the harness).
   */
  function buildSubmission(form, scores) {
    const body = new FormData();

    const add = function (name, value) {
      if (value === null || value === undefined || value === '') return;
      body.append(name, String(value));
    };

    add('company_name', clip(scores.companyName, MAX_NAME));
    add('symbol', clip(scores.symbol, MAX_SYMBOL));
    add('moat_score', scores.moatScore);
    add('cyclical_score', scores.cyclicalScore);
    add('anti_fragile_score', scores.antifragileScore);
    add('growth_score', scores.growthScore);
    add('winning_probability', scores.winningProbability/100);
    add('rank', scores.rank);
    // The model's three prices, each part posted only when its box was filled (add() skips
    // blanks): good_price / target_price / bad_price. There is no current_price part —
    // CompanyUploadIn has no such field, and an unknown part is dropped (or a 422 under
    // extra="forbid").
    add('good_price', scores.goodPrice);
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
   * Input: a score entry from SCORE_FIELDS.
   * Output: the spec rewriteBox() needs — the whole-mark normaliser, 0..100, and the clause
   *         the footer adds when it had to correct a score.
   * Action: pairs a field with its rule; nothing is read or written here.
   * Role: keeps the two families of number boxes on one rewriting path without repeating the
   *       same four keys at every call site.
   */
  function scoreSpec(entry) {
    return {
      field: entry.field,
      label: entry.label,
      normalize: normalizeScore,
      min: MIN_SCORE,
      max: MAX_SCORE,
      tail: SCORE_TAIL
    };
  }

  /**
   * Input: a percentage entry from PERCENT_FIELDS.
   * Output: the spec rewriteBox() needs — the one-decimal normaliser, 0..100, and the
   *         percentage clause.
   * Action: pairs the winning-probability box with its rule; nothing is read or written here.
   * Role: the percentage rides the same correction path as the scores, so a clamp is named in
   *       the footer and held for one submit exactly like a rounded mark.
   */
  function percentSpec(entry) {
    return {
      field: entry.field,
      label: entry.label,
      normalize: normalizePercent,
      min: MIN_PERCENT,
      max: MAX_PERCENT,
      tail: PERCENT_TAIL
    };
  }

  /**
   * Input: the <form> element and one spec ({ field, label, normalize, min, max, tail }).
   * Output: a correction { input, field, label, from, to, kind, tail }, or null when the box
   *         was empty or already held a value the sheet can store.
   * Action: applies spec.normalize to the typed text, writes the result back when it differs
   *         (an empty string when the text is not a number), and classifies the change.
   * Role: the one place a typed number is rewritten on screen — shared by the four scores and
   *       the percentage, so no box is corrected silently or by a second code path.
   */
  function rewriteBox(form, spec) {
    const input = findControl(form, spec.field);
    if (!input || input.value === '') return null;

    const from = String(input.value).trim();
    const value = spec.normalize(from);
    const next = value === null ? '' : String(value);
    if (next === from) return null;

    input.value = next;
    const number = toNumber(from);
    return {
      input: input,
      field: spec.field,
      label: spec.label,
      from: from,
      to: value,
      tail: spec.tail,
      kind: value === null
        ? 'cleared'
        : (number < spec.min || number > spec.max ? 'clamped' : 'rounded')
    };
  }

  /**
   * Input: the <form> element.
   * Output: an array of corrections — the four score boxes first, then the winning
   *         probability, one { input, field, label, from, to, kind, tail } per box this call
   *         had to rewrite. `kind` is 'clamped' (outside the box's range), 'rounded' (a value
   *         with more precision than the sheet keeps, such as 55.5 or 62.55) or 'cleared' (no
   *         number at all); `to` is null when cleared. Boxes that were already storable are
   *         left alone and not listed.
   * Action: rewrites each number box as a whole mark (55.5 → 56, 844 → 100) or as a one-decimal
   *         percentage (62.55 → 62.6, 140 → 100) and empties a box that holds no number at all,
   *         then reports what it changed.
   * Role: keeps the number boxes inside what the sheet can store, so the browser's step check
   *       never blocks Submit over a stray decimal — and since this function edits what the
   *       analyst typed, it also names every box it touched so the page can point at it instead
   *       of editing silently.
   */
  function normalizeScoreInputs(form) {
    const specs = SCORE_FIELDS.map(scoreSpec).concat(PERCENT_FIELDS.map(percentSpec));
    return specs.map((spec) => rewriteBox(form, spec)).filter(Boolean);
  }

  /**
   * Input: the corrections array from normalizeScoreInputs().
   * Output: one sentence naming the box (or boxes) and what each one became.
   * Action: phrases 'clamped', 'rounded' and 'cleared' corrections in the sheet's own words,
   *         then adds each family's rule clause once (scores / percentage).
   * Role: gives the sticky footer something to say whenever a number box was rewritten, so an
   *       auto-corrected 844 or 140 is never a silent edit.
   */
  function correctionMessage(corrections) {
    const what = function (correction) {
      if (correction.kind === 'cleared') return 'was not a number, so the box was emptied';
      if (correction.kind === 'rounded') return 'was rounded to ' + correction.to;
      return 'was out of range, so it is now ' + correction.to;
    };

    const said = corrections.map(function (correction) {
      return correction.label + ' ' + what(correction);
    });

    const tails = [];
    corrections.forEach(function (correction) {
      if (tails.indexOf(correction.tail) === -1) tails.push(correction.tail);
    });

    return said.join('; ') + ' — ' + tails.join('; ') + '.';
  }

  /**
   * Input: the score input that was rewritten.
   * Output: nothing.
   * Action: focuses the box and selects its text, tolerating a harness or an old browser
   *         without focus() / select().
   * Role: one place that moves the caret, used both straight away and once more after the click
   *       gesture that caused the blur has finished.
   */
  function takeCaret(input) {
    input.focus();
    if (typeof input.select === 'function') input.select();
  }

  /**
   * Input: one correction ({ input, … }) from normalizeScoreInputs().
   * Output: nothing.
   * Action: puts the caret in the corrected box now, then re-asserts it on the next tick if the
   *         browser handed focus to the button that was clicked — but leaves focus alone when the
   *         analyst has clicked into another field in the meantime.
   * Role: this is the answer to "why did my number change?" — the caret lands in the box that
   *       was rewritten, with the new value selected so typing replaces it, even when the blur
   *       came from clicking Submit.
   */
  function focusCorrection(correction) {
    const input = correction && correction.input;
    if (!input || typeof input.focus !== 'function') return;

    takeCaret(input);

    // Clicking Submit focuses the button during the same gesture, after this handler has run,
    // so the first focus() would be undone. Re-assert once the gesture is over — but only over
    // the Submit button or the page body, never over a stepper the analyst just clicked.
    window.setTimeout(function () {
      const active = document.activeElement;
      if (!active || active === input) return;
      const tag = String(active.tagName || '').toUpperCase();
      const submit = tag === 'BUTTON' && String(active.type || '').toLowerCase() === 'submit';
      if (submit || tag === 'BODY' || tag === 'HTML') takeCaret(input);
    }, 0);
  }

  /**
   * Input: the corrections array from normalizeScoreInputs().
   * Output: nothing.
   * Action: shows the correction in the sticky footer, marks it as fresh so the Submit gesture
   *         that caused the blur cannot post the rewritten value, and puts the caret back in
   *         the first corrected box. An empty list means this pass rewrote nothing, so any
   *         earlier hold is released — its message has just been overwritten anyway.
   * Role: makes an auto-correction visible and holds the send for one click — the analyst sees
   *       844 become 100 in the Moat score box before anything is posted.
   */
  function announceCorrections(corrections) {
    if (!corrections || corrections.length === 0) {
      correctedFresh = false;
      return;
    }
    correctedFresh = true;
    showHint(correctionMessage(corrections), 'warn');
    focusCorrection(corrections[0]);
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
      winningProbability: scores.winningProbability,
      goodPrice: scores.goodPrice,
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
        '; Submit posts the sheet to ' + SUBMIT_LABEL + '.', 'done');
      return;
    }

    showHint('Fill in the scores and attach the .html reports — Submit posts the sheet to ' +
      SUBMIT_LABEL + '.', '');
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
    showHint('Saving — posting to ' + SUBMIT_LABEL + '.', 'warn');
    // Log the resolved URL, not the short label: a 405 in the console is nearly always the
    // page host refusing a POST on a static route, and the host is what tells them apart.
    console.log(LOG_PREFIX + ' submit → ' + SUBMIT_PATH);

    // multipart/form-data on purpose, and no Content-Type header: a FormData body makes
    // fetch write `multipart/form-data; boundary=<random>` itself. Hand-setting the header
    // would drop the boundary, so the server could take the scores but never parse a report.
    const submission = buildSubmission(form, scores);
    console.log(LOG_PREFIX + ' submission', submission);
    return fetch(SUBMIT_PATH, {
      method: 'POST',
      body: submission,
      credentials: 'include'
    }).then(function (response) {
      if (response.ok) {
        showHint('Saved — ' + SUBMIT_LABEL + ' answered HTTP ' + response.status + '.', 'done');
      } else if (response.status === 401 || response.status === 403) {
        showHint('Not saved — the session was refused (HTTP ' + response.status +
          '). Sign in again, then Submit once more.', 'error');
      } else if (response.status === 405) {
        // A 405 is the page host answering, not the API: static hosting serves GET only, so
        // a POST here means this page is a stale copy that still posts to its own host.
        // Naming the URL is the whole diagnosis, so it goes in the hint.
        showHint('Not saved — HTTP 405 from ' + SUBMIT_PATH + ': that host serves pages ' +
          'only. Reload this page (Cmd+Shift+R) and Submit again.', 'error');
      } else {
        showHint('Not saved — ' + SUBMIT_LABEL + ' answered HTTP ' + response.status + '.',
          'error');
      }
      fetch()
      return response;
    }).catch(function (error) {
      const reason = (error && error.message) ? error.message : 'network error';
      showHint('Not saved — could not reach ' + SUBMIT_LABEL + ' (' + reason + ').', 'error');
      return null;
    }).then(function (response) {
      submitting = false;
      setSubmitting(form, false);
      return response;
    });
  }

  /**
   * Input: the submit event.
   * Output: the Promise from submitForm(), or a resolved null when this click only surfaces a
   *         correction the app just made to a score box.
   * Action: stops the browser's own post, recalculates at once and sends the sheet — unless a
   *         score was rewritten a moment ago, in which case it clears that flag and sends
   *         nothing so the analyst can look at the corrected box first.
   * Role: wires the amber Submit button to POST /addcompany, and keeps the sheet from posting a
   *       value the app changed on its way out of a box (844 → 100 would otherwise be saved
   *       without ever being seen).
   */
  function handleSubmit(event) {
    event.preventDefault();
    window.clearTimeout(pending);

    if (correctedFresh) {
      correctedFresh = false;
      return Promise.resolve(null);
    }

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
    // A correction belongs to the 'changed' pass that produced it. Typing again, a stepper,
    // a reset or a send means the analyst has moved on from it, so the hold is lifted.
    if (reason !== 'changed') correctedFresh = false;
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
      // Text is the analyst's again as soon as they type, so a pending hold is released here
      // and not 200 ms later when the debounced recalculation lands.
      correctedFresh = false;
      scheduleRecalculate(form);
    });

    // Rounding on change keeps a typed 55.5 from tripping the browser's step="1" check, and the
    // corrections it returns are announced so the box that was rewritten gets the caret back.
    form.addEventListener('change', function () {
      const corrections = normalizeScoreInputs(form);
      recalculate(form, 'changed');
      announceCorrections(corrections);
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
      normalizePercent: normalizePercent,
      normalizeGrade: normalizeGrade,
      normalizeScoreInputs: normalizeScoreInputs,
      describeUpload: describeUpload,
      formatBytes: formatBytes
    };

    console.log(LOG_PREFIX + ' ready — helpers available on window.companyCalc');
  }

  init();
})();

