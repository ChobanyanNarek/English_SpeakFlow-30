(() => {
  'use strict';

  // =========================================================================
  // Storage Keys & Helpers
  // =========================================================================
  const KEYS = {
    THEME: 'speakflow30_theme',
    CUSTOM_LESSONS: 'speakflow30_custom_lessons',
    VAULT: 'speakflow30_vault',
    HISTORY: 'speakflow30_history',
    ACTIVE_LESSON_ID: 'speakflow30_active_lesson'
  };

  const $ = (id) => document.getElementById(id);

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn('localStorage write failed:', e);
    }
  }

  function formatTime(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const mins = String(Math.floor(s / 60)).padStart(2, '0');
    const secs = String(s % 60).padStart(2, '0');
    return `${mins}:${secs}`;
  }

  function todayISO() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function escapeHTML(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // =========================================================================
  // Application State
  // =========================================================================
  const builtInLessons = window.SPEAKFLOW_LESSONS || [];
  let customLessons = loadJSON(KEYS.CUSTOM_LESSONS, []);
  let vault = loadJSON(KEYS.VAULT, []);
  let historyDates = loadJSON(KEYS.HISTORY, []);

  function getAllLessons() {
    return [...builtInLessons, ...customLessons];
  }

  const state = {
    lesson: null,
    currentStage: 1,
    unlockedStage: 1,
    masterSecondsLeft: 30 * 60,
    stageSecondsLeft: { 1: 10 * 60, 2: 10 * 60, 3: 10 * 60 },
    timerRunning: false,
    timerInterval: null,

    // Stage 1
    selectedPhraseIndex: 0,
    shadowedChecked: [],
    quickCheckAnswers: [],

    // Stage 2
    anchors: [], // [{ feynmanCheck, personalAnchor, difficulty: 'easy'|'hard' }]

    // Stage 3
    roleplayText: '',

    // Flashcards
    flashcardIndex: 0,
    flashcardMode: false,

    // TTS
    ttsRate: 1.0,
    ttsPlaying: false,
    ttsPaused: false,

    // Ambient Audio
    ambientMode: 'off', // 'off' | 'brown' | 'rain'
    audioCtx: null,
    ambientSource: null,
    ambientGain: null,

    // Speech Recognition
    activeRecognition: null,
    activeMicBtn: null,

    // Blitz Recall
    blitzItems: [],
    blitzIndex: 0,
    blitzScore: 0,
    blitzSecondsLeft: 60,
    blitzTimer: null
  };

  // =========================================================================
  // Theme & Fullscreen
  // =========================================================================
  function initTheme() {
    const saved = localStorage.getItem(KEYS.THEME) || 'light';
    applyTheme(saved);
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(KEYS.THEME, theme);
    $('icon-sun').classList.toggle('hidden', theme === 'light');
    $('icon-moon').classList.toggle('hidden', theme === 'dark');
  }

  $('btn-theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });

  $('btn-fullscreen').addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  });

  // =========================================================================
  // Ambient Focus Sound (Web Audio API Synthesizer — Brown Noise / Soft Rain)
  // =========================================================================
  function stopAmbient() {
    if (state.ambientSource) {
      try { state.ambientSource.stop(); } catch {}
      state.ambientSource.disconnect();
      state.ambientSource = null;
    }
    if (state.ambientGain) {
      state.ambientGain.disconnect();
      state.ambientGain = null;
    }
  }

  function startAmbient(mode) {
    stopAmbient();
    if (mode === 'off') return;

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;

    if (!state.audioCtx) {
      state.audioCtx = new AudioContext();
    }
    if (state.audioCtx.state === 'suspended') {
      state.audioCtx.resume();
    }

    const ctx = state.audioCtx;
    const bufferSize = ctx.sampleRate * 3;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    if (mode === 'brown') {
      let lastOut = 0.0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        data[i] = (lastOut + 0.02 * white) / 1.02;
        lastOut = data[i];
        data[i] *= 3.2;
      }
    } else {
      // Soft Rain (pink-ish filtered noise)
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + white * 0.0990460;
        b1 = 0.96300 * b1 + white * 0.2965164;
        b2 = 0.57000 * b2 + white * 1.0526913;
        data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.08;
      }
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = mode === 'brown' ? 380 : 1400;

    const gain = ctx.createGain();
    gain.gain.value = mode === 'brown' ? 0.22 : 0.18;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    source.start(0);

    state.ambientSource = source;
    state.ambientGain = gain;
  }

  $('btn-ambient-toggle').addEventListener('click', () => {
    const order = ['off', 'brown', 'rain'];
    const next = order[(order.indexOf(state.ambientMode) + 1) % order.length];
    state.ambientMode = next;
    const labels = { off: 'Sound: Off', brown: 'Brown Noise', rain: 'Soft Rain' };
    $('ambient-label').textContent = labels[next];
    $('btn-ambient-toggle').classList.toggle('active', next !== 'off');
    startAmbient(next);
  });

  // =========================================================================
  // Master 30-Min & Stage 10-Min Timers
  // =========================================================================
  function updateTimerUI() {
    $('master-timer-display').textContent = formatTime(state.masterSecondsLeft);
    const pct = ((30 * 60 - state.masterSecondsLeft) / (30 * 60)) * 100;
    $('master-progress-bar').style.width = `${Math.min(100, Math.max(0, pct))}%`;

    $('stage1-timer').textContent = formatTime(state.stageSecondsLeft[1]);
    $('stage2-timer').textContent = formatTime(state.stageSecondsLeft[2]);
    $('stage3-timer').textContent = formatTime(state.stageSecondsLeft[3]);

    $('icon-master-play').classList.toggle('hidden', state.timerRunning);
    $('icon-master-pause').classList.toggle('hidden', !state.timerRunning);
  }

  function startTimer() {
    if (state.timerRunning) return;
    state.timerRunning = true;
    updateTimerUI();
    state.timerInterval = setInterval(() => {
      if (state.masterSecondsLeft > 0) {
        state.masterSecondsLeft -= 1;
      }
      if (state.currentStage >= 1 && state.currentStage <= 3) {
        if (state.stageSecondsLeft[state.currentStage] > 0) {
          state.stageSecondsLeft[state.currentStage] -= 1;
        }
      }
      updateTimerUI();
    }, 1000);
  }

  function pauseTimer() {
    state.timerRunning = false;
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
    updateTimerUI();
  }

  function ensureTimerStarted() {
    if (!state.timerRunning && state.currentStage <= 3) {
      startTimer();
    }
  }

  $('btn-master-toggle').addEventListener('click', () => {
    if (state.timerRunning) pauseTimer();
    else startTimer();
  });

  $('btn-master-reset').addEventListener('click', () => {
    if (confirm('Reset the current 30-minute session and timers?')) {
      loadLesson(state.lesson.id);
    }
  });

  // =========================================================================
  // Stage Navigation & Gating
  // =========================================================================
  function goToStage(stageNum) {
    if (stageNum > state.unlockedStage && stageNum <= 3) return;
    state.currentStage = stageNum;

    [1, 2, 3].forEach((n) => {
      const panel = $(`stage-${n}`);
      panel.classList.toggle('hidden', n !== stageNum);
      const btn = $(`step-btn-${n}`);
      btn.classList.toggle('active', n === stageNum);
      btn.classList.toggle('locked', n > state.unlockedStage);
      btn.classList.toggle('completed', n < state.unlockedStage || stageNum === 4);
      btn.disabled = n > state.unlockedStage;
      const lockIcon = btn.querySelector('.step-lock');
      if (lockIcon) {
        lockIcon.classList.toggle('hidden', n <= state.unlockedStage);
      }
    });

    $('stage-complete').classList.toggle('hidden', stageNum !== 4);

    if (stageNum === 1) stopTTS();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  [1, 2, 3].forEach((n) => {
    $(`step-btn-${n}`).addEventListener('click', () => goToStage(n));
  });

  // =========================================================================
  // Lesson Loading & Stage 1 Rendering
  // =========================================================================
  function loadLesson(lessonId) {
    const all = getAllLessons();
    const found = all.find((l) => l.id === lessonId) || all[0];
    if (!found) return;

    pauseTimer();
    stopTTS();

    state.lesson = found;
    localStorage.setItem(KEYS.ACTIVE_LESSON_ID, found.id);

    state.currentStage = 1;
    state.unlockedStage = 1;
    state.masterSecondsLeft = 30 * 60;
    state.stageSecondsLeft = { 1: 10 * 60, 2: 10 * 60, 3: 10 * 60 };
    state.selectedPhraseIndex = 0;
    state.shadowedChecked = found.expressions.map(() => false);
    state.quickCheckAnswers = (found.quickCheck || []).map(() => null);
    state.anchors = found.expressions.map(() => ({
      feynmanCheck: '',
      personalAnchor: '',
      difficulty: 'easy'
    }));
    state.roleplayText = '';
    state.flashcardIndex = 0;
    state.flashcardMode = false;

    $('header-lesson-title').textContent = found.title;
    $('stage1-lesson-title').textContent = found.title;
    $('lesson-level-tag').textContent = found.level || 'B1 → C1';
    $('lesson-category-tag').textContent = found.category || 'Daily Fluency';
    $('roleplay-prompt').textContent = found.roleplayPrompt;
    $('roleplay-textarea').value = '';
    $('roleplay-word-count').textContent = '0 words';
    if ($('roleplay-feedback-panel')) $('roleplay-feedback-panel').classList.add('hidden');
    if ($('shadow-mic-feedback')) $('shadow-mic-feedback').classList.add('hidden');

    renderStage1();
    renderGrammarAndQuickCheck();
    renderStage2();
    renderStage3Tracker();
    updateTimerUI();
    goToStage(1);
  }

  function renderGrammarAndQuickCheck() {
    const tipCard = $('grammar-tip-card');
    const tip = state.lesson.grammarTip;
    if (tipCard) {
      if (tip && tip.title) {
        tipCard.classList.remove('hidden');
        $('grammar-tip-title').textContent = tip.title;
        $('grammar-tip-explanation').textContent = tip.explanation || '';
        $('grammar-tip-example').textContent = tip.example ? `Example: ${tip.example}` : '';
        $('grammar-tip-example').classList.toggle('hidden', !tip.example);
      } else {
        tipCard.classList.add('hidden');
      }
    }

    const qcCard = $('quick-check-card');
    const qcList = $('quick-check-list');
    const questions = Array.isArray(state.lesson.quickCheck) ? state.lesson.quickCheck : [];
    if (!qcCard || !qcList) return;

    if (questions.length === 0) {
      qcCard.classList.add('hidden');
      return;
    }

    qcCard.classList.remove('hidden');
    qcList.innerHTML = '';

    questions.forEach((q, qIdx) => {
      const answered = state.quickCheckAnswers[qIdx];
      const item = document.createElement('div');
      item.className = 'qc-item';

      const optionsHtml = q.options.map((opt, oIdx) => {
        let cls = 'qc-option-btn';
        if (answered !== null) {
          if (oIdx === q.correctIndex) cls += ' correct';
          else if (oIdx === answered) cls += ' wrong';
        }
        return `<button type="button" class="${cls}" data-q="${qIdx}" data-o="${oIdx}" ${answered !== null ? 'disabled' : ''}>${escapeHTML(opt)}</button>`;
      }).join('');

      const expHtml = answered !== null
        ? `<p class="qc-explanation"><strong>${answered === q.correctIndex ? '✓ Correct!' : '✎ Note:'}</strong> ${escapeHTML(q.explanation || '')}</p>`
        : '';

      item.innerHTML = `
        <p class="qc-question">${qIdx + 1}. ${escapeHTML(q.question)}</p>
        <div class="qc-options">${optionsHtml}</div>
        ${expHtml}
      `;

      item.querySelectorAll('.qc-option-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          ensureTimerStarted();
          state.quickCheckAnswers[qIdx] = Number(btn.dataset.o);
          renderGrammarAndQuickCheck();
        });
      });

      qcList.appendChild(item);
    });

    const answeredCount = state.quickCheckAnswers.filter((a) => a !== null).length;
    const correctCount = state.quickCheckAnswers.filter((a, i) => a === questions[i]?.correctIndex).length;
    $('quick-check-score').textContent = answeredCount === 0
      ? `0 / ${questions.length} Checked`
      : `${correctCount} / ${questions.length} Correct`;
  }

  function renderStage1() {
    const { contextText, expressions } = state.lesson;
    let html = escapeHTML(contextText);

    expressions.forEach((expr, idx) => {
      const pattern = new RegExp(`(${escapeRegex(escapeHTML(expr.phrase))})`, 'gi');
      const isSelected = idx === state.selectedPhraseIndex ? ' selected' : '';
      const isChecked = state.shadowedChecked[idx] ? ' checked' : '';
      html = html.replace(
        pattern,
        `<button type="button" class="phrase-highlight${isSelected}${isChecked}" data-idx="${idx}">$1</button>`
      );
    });

    const passageEl = $('reading-passage');
    passageEl.innerHTML = html;

    passageEl.querySelectorAll('.phrase-highlight').forEach((btn) => {
      btn.addEventListener('click', () => {
        ensureTimerStarted();
        selectPhrase(Number(btn.dataset.idx));
      });
    });

    // Checklist
    const checklistEl = $('stage1-checklist');
    checklistEl.innerHTML = '';
    expressions.forEach((expr, idx) => {
      const li = document.createElement('li');
      li.className = `checklist-item${state.shadowedChecked[idx] ? ' done' : ''}`;
      li.innerHTML = `
        <input type="checkbox" id="chk-expr-${idx}" ${state.shadowedChecked[idx] ? 'checked' : ''} />
        <span>${escapeHTML(expr.phrase)}</span>
      `;
      const cb = li.querySelector('input');
      cb.addEventListener('change', () => {
        ensureTimerStarted();
        state.shadowedChecked[idx] = cb.checked;
        renderStage1();
      });
      li.addEventListener('click', (e) => {
        if (e.target !== cb) {
          selectPhrase(idx);
        }
      });
      checklistEl.appendChild(li);
    });

    const doneCount = state.shadowedChecked.filter(Boolean).length;
    const total = expressions.length;
    $('stage1-check-count').textContent = `${doneCount} / ${total} Shadowed`;

    const unlockBtn = $('btn-unlock-stage2');
    const allDone = doneCount === total;
    unlockBtn.disabled = !allDone;
    unlockBtn.textContent = allDone
      ? 'Continue to Stage 2: Deep Encoding'
      : `Complete ${total - doneCount} More to Unlock Stage 2`;

    updateInspector();
  }

  function selectPhrase(idx) {
    state.selectedPhraseIndex = idx;
    $('reading-passage').querySelectorAll('.phrase-highlight').forEach((el) => {
      el.classList.toggle('selected', Number(el.dataset.idx) === idx);
    });
    updateInspector();
  }

  function updateInspector() {
    const expr = state.lesson.expressions[state.selectedPhraseIndex];
    if (!expr) return;
    $('inspector-phrase').textContent = expr.phrase;
    $('inspector-feynman').textContent = expr.feynmanExplanation;
    $('inspector-basic').textContent = expr.basicAlternative;
    $('inspector-pro').textContent = expr.proExample;
    $('inspector-examples').classList.remove('hidden');
  }

  $('btn-unlock-stage2').addEventListener('click', () => {
    if (state.unlockedStage < 2) state.unlockedStage = 2;
    goToStage(2);
  });

  // =========================================================================
  // Text-to-Speech (Web Speech API)
  // =========================================================================
  function stopTTS() {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    state.ttsPlaying = false;
    state.ttsPaused = false;
    $('tts-play-label').textContent = 'Read Aloud';
    $('btn-tts-stop').classList.add('hidden');
  }

  function speakText(text, isPassage = false) {
    if (!('speechSynthesis' in window)) {
      alert('Your browser does not support Web Speech API Text-to-Speech.');
      return;
    }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'en-US';
    utter.rate = state.ttsRate;

    const voices = window.speechSynthesis.getVoices();
    const preferred =
      voices.find((v) => v.lang.startsWith('en-US') && v.localService) ||
      voices.find((v) => v.lang.startsWith('en'));
    if (preferred) utter.voice = preferred;

    if (isPassage) {
      state.ttsPlaying = true;
      state.ttsPaused = false;
      $('tts-play-label').textContent = 'Pause';
      $('btn-tts-stop').classList.remove('hidden');
      utter.onend = () => stopTTS();
      utter.onerror = () => stopTTS();
    }

    window.speechSynthesis.speak(utter);
  }

  $('btn-tts-play').addEventListener('click', () => {
    ensureTimerStarted();
    if (!('speechSynthesis' in window)) return;

    if (state.ttsPlaying && !state.ttsPaused) {
      window.speechSynthesis.pause();
      state.ttsPaused = true;
      $('tts-play-label').textContent = 'Resume';
    } else if (state.ttsPlaying && state.ttsPaused) {
      window.speechSynthesis.resume();
      state.ttsPaused = false;
      $('tts-play-label').textContent = 'Pause';
    } else {
      speakText(state.lesson.contextText, true);
    }
  });

  $('btn-tts-stop').addEventListener('click', stopTTS);

  $('btn-speak-phrase').addEventListener('click', () => {
    ensureTimerStarted();
    const expr = state.lesson.expressions[state.selectedPhraseIndex];
    if (expr) speakText(`${expr.phrase}. ${expr.proExample}`, false);
  });

  document.querySelectorAll('.speed-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.speed-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.ttsRate = parseFloat(btn.dataset.speed);
      if (state.ttsPlaying) {
        speakText(state.lesson.contextText, true);
      }
    });
  });

  // =========================================================================
  // Voice-to-Text (Web Speech API SpeechRecognition)
  // =========================================================================
  function toggleVoiceInput(targetEl, btnEl, onUpdate) {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      alert('Voice-to-text (SpeechRecognition) is not supported in this browser. Please type your response.');
      return;
    }

    if (state.activeRecognition) {
      state.activeRecognition.stop();
      return;
    }

    const rec = new SpeechRec();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    state.activeRecognition = rec;
    state.activeMicBtn = btnEl;
    btnEl.classList.add('recording');

    rec.onresult = (event) => {
      const transcript = event.results[0][0].transcript.trim();
      const existing = targetEl.value.trim();
      targetEl.value = existing ? `${existing} ${transcript}` : transcript;
      onUpdate(targetEl.value);
    };

    rec.onend = () => {
      btnEl.classList.remove('recording');
      state.activeRecognition = null;
      state.activeMicBtn = null;
    };

    rec.onerror = () => {
      btnEl.classList.remove('recording');
      state.activeRecognition = null;
      state.activeMicBtn = null;
    };

    rec.start();
  }

  // =========================================================================
  // Stage 1 Pronunciation Check (Speak & Check)
  // =========================================================================
  if ($('btn-shadow-mic')) {
    $('btn-shadow-mic').addEventListener('click', () => {
      ensureTimerStarted();
      const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
      const fb = $('shadow-mic-feedback');
      if (!SpeechRec) {
        fb.className = 'feedback-box warn';
        fb.textContent = 'Speech recognition is not supported in this browser (try Chrome/Edge/Safari).';
        fb.classList.remove('hidden');
        return;
      }

      const targetPhrase = state.lesson.expressions[state.selectedPhraseIndex]?.phrase || '';
      const btn = $('btn-shadow-mic');
      const rec = new SpeechRec();
      rec.lang = 'en-US';
      rec.interimResults = false;
      btn.classList.add('recording');
      btn.textContent = 'Listening...';

      rec.onresult = (event) => {
        const heard = event.results[0][0].transcript.trim();
        const match = heard.toLowerCase().includes(targetPhrase.toLowerCase());
        fb.classList.remove('hidden', 'ok', 'warn', 'error');
        if (match) {
          fb.classList.add('ok');
          fb.innerHTML = `<strong>✓ Clear pronunciation!</strong> Heard: "${escapeHTML(heard)}"`;
        } else {
          fb.classList.add('warn');
          fb.innerHTML = `<strong>Try again:</strong> Heard "${escapeHTML(heard)}" — aim for "<em>${escapeHTML(targetPhrase)}</em>".`;
        }
      };

      rec.onend = rec.onerror = () => {
        btn.classList.remove('recording');
        btn.textContent = 'Speak & Check';
      };

      rec.start();
    });
  }

  // =========================================================================
  // Comprehensive Checking Engine (Local A2->C1 Rules + Optional Gemini AI Coach)
  // =========================================================================
  function evaluateLocalText(text, requiredPhrases = [], minWords = 5) {
    const trimmed = text.trim();
    const issues = [];
    const words = trimmed ? trimmed.split(/\s+/) : [];
    const sentences = trimmed
      ? trimmed.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean)
      : [];

    if (words.length < minWords) {
      issues.push(`Too short (${words.length} words). Aim for at least ${minWords} words for a complete thought.`);
    }

    if (trimmed && /^[a-z]/.test(trimmed)) {
      issues.push('Start your sentence with a capital letter.');
    }

    if (trimmed && !/[.!?]$/.test(trimmed)) {
      issues.push('End your sentence with punctuation (. ! ?).');
    }

    if (/\bi\b/.test(trimmed)) {
      issues.push('Always capitalize the pronoun "I".');
    }

    // Common A2 -> C1 grammar, preposition & collocation traps
    const traps = [
      { re: /\b(i am|i'm|am)\s+agree\b/i, msg: 'Use "I agree" (never "I am agree").' },
      { re: /\bdiscuss\s+about\b/i, msg: 'Use "discuss [topic]" without "about".' },
      { re: /\bexplain\s+me\b/i, msg: 'Use "explain to me" (not "explain me").' },
      { re: /\bdepend\s+of\b/i, msg: 'Use "depend on" (not "depend of").' },
      { re: /\bmore\s+(better|easier|faster|harder|cheaper|bigger|smaller)\b/i, msg: 'Avoid double comparatives (use "much better" / "easier").' },
      { re: /\b(informations|advices|equipments|knowledges|researches)\b/i, msg: '"Information", "advice", "equipment", "knowledge", and "research" are uncountable (no "-s").' },
      { re: /\b(return back|repeat again|revert back)\b/i, msg: 'Avoid redundancy ("return" or "repeat" is enough).' },
      { re: /\b(did|didn't|did not)\s+(went|saw|came|made|took|told|gave|knew|wrote|spoke|felt|bought)\b/i, msg: 'After "did / didn\'t", always use the base verb (e.g., "didn\'t go", not "didn\'t went").' },
      { re: /\b(can|could|should|must|might)\s+to\s+[a-z]+\b/i, msg: 'Modal verbs (can, should, must, might) take a bare verb with no "to" (e.g., "should go").' },
      { re: /\bwould\s+rather\s+to\b/i, msg: 'Use "would rather + base verb" without "to" (e.g., "would rather stay").' },
      { re: /\b(do|did|doing)\s+a\s+mistake\b/i, msg: 'Use "make a mistake" (not "do a mistake").' },
      { re: /\bpeople\s+is\b/i, msg: '"People" is plural — use "people are" (not "people is").' },
      { re: /\b(everyone|everybody|someone|somebody)\s+are\b/i, msg: '"Everyone / somebody" takes a singular verb (e.g., "everyone is").' },
      { re: /\bsince\s+\d+\s+(years|months|weeks|days|hours)\b/i, msg: 'Use "for" with durations ("for 3 years") and "since" with a start date ("since 2023").' },
      { re: /\beven\s+though\b[^.!?]*\bbut\b/i, msg: 'Do not use both "even though" and "but" in the same sentence.' },
      { re: /\bworth\s+to\s+[a-z]+\b/i, msg: 'Use "worth + -ing" (e.g., "worth visiting", not "worth to visit").' },
      { re: /\blooking\s+forward\s+to\s+(meet|see|work|hear|go|visit|talk|join)\b/i, msg: 'Use "looking forward to + -ing" (e.g., "looking forward to meeting").' },
      { re: /\b(get|got|am|is|are)\s+used\s+to\s+(wake|drive|speak|work|live|go|study|read)\b/i, msg: 'Use "be/get used to + -ing" (e.g., "got used to speaking").' },
      { re: /\b(\w+)\s+\1\b/i, msg: 'Repeated word detected — check for typos.' }
    ];

    traps.forEach((t) => {
      if (t.re.test(trimmed)) issues.push(t.msg);
    });

    const missing = requiredPhrases.filter(
      (p) => !trimmed.toLowerCase().includes(p.toLowerCase())
    );

    const sentenceCount = sentences.length || (words.length > 0 ? 1 : 0);
    const estimatedSpeakSec = Math.max(1, Math.round((words.length / 130) * 60));

    return {
      issues,
      missing,
      wordCount: words.length,
      sentenceCount,
      estimatedSpeakSec
    };
  }

  async function listAvailableGeminiModels(apiKey) {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
      );
      if (!resp.ok) return [];
      const data = await resp.json();
      const models = (data.models || [])
        .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
        .map((m) => m.name.replace(/^models\//, ''))
        .filter((name) => !/embedding|imagen|veo|tts|audio|robotics/i.test(name));

      models.sort((a, b) => {
        const aFlash = /flash/i.test(a) ? 0 : 1;
        const bFlash = /flash/i.test(b) ? 0 : 1;
        return aFlash - bFlash;
      });
      return models;
    } catch {
      return [];
    }
  }

  function parseGeminiJSON(rawText) {
    if (!rawText) return null;
    const cleaned = rawText
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    return JSON.parse(cleaned);
  }

  async function callGeminiJSON(apiKey, prompt, temperature = 0.7) {
    const cached = localStorage.getItem('speakflow30_gemini_model');
    const candidates = [...new Set([
      cached,
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-1.5-flash',
      'gemini-1.5-flash-latest'
    ].filter(Boolean))];

    const tryModel = async (model) => {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature }
          })
        }
      );
      return resp;
    };

    let lastStatus = 0;
    let lastMessage = '';

    for (const model of candidates) {
      const resp = await tryModel(model);
      if (resp.ok) {
        try { localStorage.setItem('speakflow30_gemini_model', model); } catch {}
        const data = await resp.json();
        const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        return parseGeminiJSON(raw);
      }
      lastStatus = resp.status;
      if (resp.status !== 404) {
        try {
          const errBody = await resp.json();
          lastMessage = errBody?.error?.message || '';
        } catch {}
        throw new Error(`Gemini API error (${resp.status}${lastMessage ? `: ${lastMessage}` : ''}).`);
      }
    }

    // All hardcoded candidates returned 404 — discover available models for this key
    const discovered = await listAvailableGeminiModels(apiKey);
    for (const model of discovered.slice(0, 3)) {
      const resp = await tryModel(model);
      if (resp.ok) {
        try { localStorage.setItem('speakflow30_gemini_model', model); } catch {}
        const data = await resp.json();
        const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        return parseGeminiJSON(raw);
      }
      lastStatus = resp.status;
    }

    throw new Error(`Gemini API error (${lastStatus || 404}: no compatible model found for this API key).`);
  }

  async function evaluateWithGemini(mode, payload) {
    const apiKey = localStorage.getItem('speakflow30_gemini_key') || '';
    if (!apiKey) return null;

    const { level } = getAdaptiveProfile();
    const prompt = mode === 'anchor'
      ? `You are an encouraging English coach for a ${level} learner working on overall fluency and speaking confidence.
Target phrase: "${payload.phrase}" (Meaning: ${payload.feynmanExplanation})
Learner's Feynman explanation: "${payload.feynmanCheck || '(empty)'}"
Learner's Personal sentence: "${payload.personalAnchor}"

Check grammar, word choice, and whether the target phrase is used naturally.
Return ONLY valid JSON:
{
  "isCorrect": true or false,
  "feedback": "1-2 short, clear sentences explaining what is good or what to fix.",
  "upgradedVersion": "A natural, polished ${level}→C1 version of their Personal sentence."
}`
      : `You are an encouraging English coach for a ${level} learner developing free speaking, general English fluency, and interview confidence.
Scenario: ${payload.prompt}
Target expressions: ${payload.phrases.join(', ')}
Learner's response (written or spoken): "${payload.text}"

Check grammar, clarity, natural flow, tone, and usage of the target expressions.
Return ONLY valid JSON:
{
  "score": "e.g. 8/10",
  "isCorrect": true or false,
  "feedback": "2-3 concise sentences of specific grammar & phrasing corrections.",
  "upgradedVersion": "A polished, natural B2/C1 version of their full response keeping their ideas."
}`;

    try {
      return await callGeminiJSON(apiKey, prompt, 0.3);
    } catch {
      return null;
    }
  }

  async function checkStage2Anchor(idx, fbEl, btnEl) {
    const expr = state.lesson.expressions[idx];
    const anchor = state.anchors[idx];
    const text = anchor.personalAnchor.trim();

    fbEl.classList.remove('hidden', 'ok', 'warn', 'error');
    if (!text) {
      fbEl.classList.add('error');
      fbEl.textContent = 'Write or speak your Personal Anchor sentence first so I can check it.';
      return;
    }

    const local = evaluateLocalText(text, [expr.phrase], 5);
    const allIssues = [...local.issues];
    if (local.missing.length > 0) {
      allIssues.unshift(`Include the target phrase "${expr.phrase}" in your sentence.`);
    }

    if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'Checking...'; }
    const ai = await evaluateWithGemini('anchor', {
      phrase: expr.phrase,
      feynmanExplanation: expr.feynmanExplanation,
      feynmanCheck: anchor.feynmanCheck,
      personalAnchor: text
    });
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = 'Check Sentence'; }

    if (ai) {
      fbEl.classList.add(ai.isCorrect && allIssues.length === 0 ? 'ok' : 'warn');
      fbEl.innerHTML = `
        <strong>${ai.isCorrect ? '✓ AI Coach:' : '✎ AI Coach Suggestion:'}</strong> ${escapeHTML(ai.feedback)}
        ${allIssues.length ? `<div style="margin-top:4px;">• ${allIssues.map(escapeHTML).join('<br>• ')}</div>` : ''}
        ${ai.upgradedVersion ? `<div class="feedback-upgrade"><span class="contrast-label c1">Polished Version</span><div style="margin-top:4px;">${escapeHTML(ai.upgradedVersion)}</div></div>` : ''}
      `;
    } else if (allIssues.length === 0) {
      fbEl.classList.add('ok');
      fbEl.innerHTML = `<strong>✓ Solid sentence!</strong> Target phrase used correctly with clean structure.`;
    } else {
      fbEl.classList.add('warn');
      fbEl.innerHTML = `<strong>✎ Quick Fixes:</strong><br>• ${allIssues.map(escapeHTML).join('<br>• ')}`;
    }
  }

  async function checkStage3Roleplay() {
    const fb = $('roleplay-feedback-panel');
    const btn = $('btn-roleplay-check');
    const text = state.roleplayText.trim();
    const phrases = state.lesson.expressions.map((e) => e.phrase);

    fb.classList.remove('hidden', 'ok', 'warn', 'error');
    if (!text) {
      fb.classList.add('error');
      fb.textContent = 'Type or speak your response first so I can check it.';
      return;
    }

    const local = evaluateLocalText(text, phrases, 20);
    const usedCount = phrases.length - local.missing.length;
    const allIssues = [...local.issues];
    if (usedCount < 3) {
      allIssues.unshift(`You used ${usedCount}/${phrases.length} target expressions (goal: at least 3). Try adding: ${local.missing.slice(0, 2).join(', ')}.`);
    }
    if (local.sentenceCount < 3) {
      allIssues.push(`Only ${local.sentenceCount} sentence${local.sentenceCount === 1 ? '' : 's'} detected — try expanding into 4–5 connected sentences.`);
    }

    const metricsHtml = `
      <div class="fluency-metrics">
        <span class="metric-pill">${local.wordCount} words</span>
        <span class="metric-pill">${local.sentenceCount} sentences</span>
        <span class="metric-pill">${usedCount}/${phrases.length} phrases</span>
        <span class="metric-pill">~${local.estimatedSpeakSec}s spoken</span>
      </div>
    `;

    btn.disabled = true;
    btn.textContent = 'Checking...';
    const ai = await evaluateWithGemini('roleplay', {
      prompt: state.lesson.roleplayPrompt,
      phrases,
      text
    });
    btn.disabled = false;
    btn.textContent = 'Check My Response';

    if (ai) {
      fb.classList.add(ai.isCorrect && usedCount >= 3 ? 'ok' : 'warn');
      fb.innerHTML = `
        <strong>AI Coach (${escapeHTML(ai.score || 'Reviewed')}):</strong> ${escapeHTML(ai.feedback)}
        ${metricsHtml}
        ${allIssues.length ? `<div style="margin-top:6px;">• ${allIssues.map(escapeHTML).join('<br>• ')}</div>` : ''}
        ${ai.upgradedVersion ? `<div class="feedback-upgrade"><span class="contrast-label c1">Polished B2/C1 Version</span><div style="margin-top:4px;">${escapeHTML(ai.upgradedVersion)}</div></div>` : ''}
      `;
    } else if (allIssues.length === 0) {
      fb.classList.add('ok');
      fb.innerHTML = `<strong>✓ Great response!</strong> Clean structure and strong use of today's expressions.${metricsHtml}<div class="muted-text" style="margin-top:4px;">Tip: Add an optional Gemini API key in Auto-Plan for line-by-line AI grammar upgrades.</div>`;
    } else {
      fb.classList.add('warn');
      fb.innerHTML = `<strong>✎ Review Feedback:</strong>${metricsHtml}<div>• ${allIssues.map(escapeHTML).join('<br>• ')}</div>`;
    }
  }

  // =========================================================================
  // Stage 2: Deep Encoding & Active Anchor Builder
  // =========================================================================
  function renderStage2() {
    const container = $('anchor-builder-list');
    container.innerHTML = '';

    state.lesson.expressions.forEach((expr, idx) => {
      const anchorState = state.anchors[idx];
      const card = document.createElement('div');
      card.className = 'card anchor-card';
      card.innerHTML = `
        <div class="anchor-card-header">
          <div class="anchor-title-group">
            <span class="anchor-num">${idx + 1}</span>
            <span class="anchor-phrase">${escapeHTML(expr.phrase)}</span>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <button type="button" class="btn btn-secondary btn-xs btn-check-anchor">Check Sentence</button>
            <div class="difficulty-toggle" role="group" aria-label="Difficulty rating">
              <button type="button" class="diff-btn ${anchorState.difficulty === 'easy' ? 'active' : ''}" data-diff="easy">Easy</button>
              <button type="button" class="diff-btn ${anchorState.difficulty === 'hard' ? 'active' : ''}" data-diff="hard">Hard Mode</button>
            </div>
          </div>
        </div>
        <div class="anchor-fields">
          <div class="field-group">
            <div class="field-label-row">
              <label class="field-label" for="feynman-input-${idx}">1. Feynman Check (Simple English)</label>
              <button type="button" class="btn btn-ghost btn-xs mic-btn" data-target="feynman" aria-label="Voice input for Feynman check">Mic</button>
            </div>
            <input id="feynman-input-${idx}" class="text-input" type="text" placeholder="Explain in 1 simple sentence..." value="${escapeHTML(anchorState.feynmanCheck)}" />
          </div>
          <div class="field-group">
            <div class="field-label-row">
              <label class="field-label" for="anchor-input-${idx}">2. Personal Anchor (Your Work / Life)</label>
              <button type="button" class="btn btn-ghost btn-xs mic-btn" data-target="anchor" aria-label="Voice input for Personal Anchor">Mic</button>
            </div>
            <input id="anchor-input-${idx}" class="text-input" type="text" placeholder="Use '${escapeHTML(expr.phrase)}' in a real sentence..." value="${escapeHTML(anchorState.personalAnchor)}" />
          </div>
        </div>
        <div id="anchor-feedback-${idx}" class="feedback-box hidden"></div>
      `;

      // Difficulty buttons
      card.querySelectorAll('.diff-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          anchorState.difficulty = btn.dataset.diff;
          card.querySelectorAll('.diff-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
        });
      });

      const feynmanInput = card.querySelector(`#feynman-input-${idx}`);
      const anchorInput = card.querySelector(`#anchor-input-${idx}`);
      const checkBtn = card.querySelector('.btn-check-anchor');
      const fbEl = card.querySelector(`#anchor-feedback-${idx}`);

      feynmanInput.addEventListener('input', (e) => {
        ensureTimerStarted();
        anchorState.feynmanCheck = e.target.value;
      });

      anchorInput.addEventListener('input', (e) => {
        ensureTimerStarted();
        anchorState.personalAnchor = e.target.value;
        updateStage2Gate();
      });

      checkBtn.addEventListener('click', () => checkStage2Anchor(idx, fbEl, checkBtn));

      card.querySelectorAll('.mic-btn').forEach((micBtn) => {
        micBtn.addEventListener('click', () => {
          ensureTimerStarted();
          const isFeynman = micBtn.dataset.target === 'feynman';
          const inputEl = isFeynman ? feynmanInput : anchorInput;
          toggleVoiceInput(inputEl, micBtn, (val) => {
            if (isFeynman) anchorState.feynmanCheck = val;
            else {
              anchorState.personalAnchor = val;
              updateStage2Gate();
              checkStage2Anchor(idx, fbEl, checkBtn);
            }
          });
        });
      });

      container.appendChild(card);
    });

    updateStage2Gate();
  }

  function updateStage2Gate() {
    const completed = state.anchors.filter((a) => a.personalAnchor.trim().length >= 5).length;
    const total = state.lesson.expressions.length;
    $('stage2-anchor-count').textContent = `${completed} / ${total} Personal Anchors Completed`;
    $('btn-unlock-stage3').disabled = completed < total;
  }

  $('btn-unlock-stage3').addEventListener('click', () => {
    if (state.unlockedStage < 3) state.unlockedStage = 3;
    goToStage(3);
  });

  // =========================================================================
  // Stage 3: High-Stakes Roleplay & Live Phrase Tracker
  // =========================================================================
  function renderStage3Tracker() {
    const text = state.roleplayText.toLowerCase();
    const container = $('roleplay-phrase-badges');
    container.innerHTML = '';

    let matchedCount = 0;
    state.lesson.expressions.forEach((expr) => {
      const matched = text.includes(expr.phrase.toLowerCase());
      if (matched) matchedCount += 1;
      const badge = document.createElement('span');
      badge.className = `phrase-badge${matched ? ' matched' : ''}`;
      badge.innerHTML = `${matched ? '✓ ' : ''}${escapeHTML(expr.phrase)}`;
      container.appendChild(badge);
    });

    $('roleplay-tracker-count').textContent = `${matchedCount} / ${state.lesson.expressions.length} Used (Goal: 3+)`;
  }

  $('roleplay-textarea').addEventListener('input', (e) => {
    ensureTimerStarted();
    state.roleplayText = e.target.value;
    const words = state.roleplayText.trim() ? state.roleplayText.trim().split(/\s+/).length : 0;
    $('roleplay-word-count').textContent = `${words} words`;
    renderStage3Tracker();
  });

  $('btn-roleplay-mic').addEventListener('click', () => {
    ensureTimerStarted();
    toggleVoiceInput($('roleplay-textarea'), $('btn-roleplay-mic'), (val) => {
      state.roleplayText = val;
      const words = val.trim() ? val.trim().split(/\s+/).length : 0;
      $('roleplay-word-count').textContent = `${words} words`;
      renderStage3Tracker();
      checkStage3Roleplay();
    });
  });

  $('btn-roleplay-check').addEventListener('click', checkStage3Roleplay);

  // =========================================================================
  // Session Completion, Spaced Repetition Vault & 2-Min Night Recall
  // =========================================================================
  $('btn-complete-session').addEventListener('click', () => {
    pauseTimer();

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    state.lesson.expressions.forEach((expr, idx) => {
      const anchor = state.anchors[idx];
      const intervalDays = anchor.difficulty === 'hard' ? 1 : 3;
      const itemId = `${state.lesson.id}::${expr.phrase.toLowerCase()}`;

      const existingIdx = vault.findIndex((v) => v.id === itemId);
      const record = {
        id: itemId,
        phrase: expr.phrase,
        feynmanExplanation: expr.feynmanExplanation,
        proExample: expr.proExample,
        feynmanCheck: anchor.feynmanCheck.trim(),
        personalAnchor: anchor.personalAnchor.trim(),
        difficulty: anchor.difficulty,
        intervalDays,
        lastReviewedAt: now,
        nextReviewAt: now + intervalDays * dayMs,
        lessonTitle: state.lesson.title
      };

      if (existingIdx >= 0) vault[existingIdx] = record;
      else vault.unshift(record);
    });

    saveJSON(KEYS.VAULT, vault);

    const today = todayISO();
    if (!historyDates.includes(today)) {
      historyDates.push(today);
      saveJSON(KEYS.HISTORY, historyDates);
    }

    renderNightRecall();
    updateVaultBadge();
    goToStage(4);
  });

  function renderNightRecall() {
    const listEl = $('night-recall-list');
    listEl.innerHTML = '';

    state.lesson.expressions.forEach((expr, idx) => {
      const anchor = state.anchors[idx];
      const card = document.createElement('div');
      card.className = 'card recall-card';
      card.innerHTML = `
        <div class="card-header-row">
          <h3>${escapeHTML(expr.phrase)}</h3>
          <span class="tag">${anchor.difficulty === 'hard' ? 'Hard (1d)' : 'Easy (3d)'}</span>
        </div>
        <p class="muted-text">${escapeHTML(expr.feynmanExplanation)}</p>
        <div class="recall-anchor">
          <strong>Your Anchor:</strong> ${escapeHTML(anchor.personalAnchor)}
        </div>
      `;
      listEl.appendChild(card);
    });

    renderFlashcard();
  }

  $('btn-copy-recall').addEventListener('click', async () => {
    const lines = [
      `# SpeakFlow 30 — Night Recall (${state.lesson.title})`,
      ''
    ];
    state.lesson.expressions.forEach((expr, idx) => {
      const anchor = state.anchors[idx];
      lines.push(`**${idx + 1}. ${expr.phrase}**`);
      lines.push(`- Meaning: ${expr.feynmanExplanation}`);
      lines.push(`- My Anchor: ${anchor.personalAnchor}`);
      lines.push('');
    });

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      $('copy-recall-label').textContent = 'Copied!';
      setTimeout(() => {
        $('copy-recall-label').textContent = 'Copy for Night Recall';
      }, 2000);
    } catch {
      alert('Copy failed. Please select and copy manually.');
    }
  });

  // Flashcards
  function renderFlashcard() {
    const idx = state.flashcardIndex;
    const expr = state.lesson.expressions[idx];
    const anchor = state.anchors[idx];
    if (!expr) return;

    $('flashcard-counter').textContent = `Card ${idx + 1} of ${state.lesson.expressions.length}`;
    $('fc-front-phrase').textContent = expr.phrase;
    $('fc-front-hint').textContent = `Basic B1: "${expr.basicAlternative}"`;
    $('fc-back-feynman').textContent = expr.feynmanExplanation;
    $('fc-back-anchor').textContent = anchor.personalAnchor;
    $('flashcard-box').classList.remove('flipped');
  }

  $('btn-toggle-flashcards').addEventListener('click', () => {
    state.flashcardMode = !state.flashcardMode;
    $('night-recall-list').classList.toggle('hidden', state.flashcardMode);
    $('night-recall-flashcards').classList.toggle('hidden', !state.flashcardMode);
    $('btn-toggle-flashcards').textContent = state.flashcardMode ? 'Summary List View' : 'Flashcard Flip Mode';
  });

  $('flashcard-box').addEventListener('click', () => {
    $('flashcard-box').classList.toggle('flipped');
  });

  $('btn-fc-prev').addEventListener('click', () => {
    const len = state.lesson.expressions.length;
    state.flashcardIndex = (state.flashcardIndex - 1 + len) % len;
    renderFlashcard();
  });

  $('btn-fc-next').addEventListener('click', () => {
    const len = state.lesson.expressions.length;
    state.flashcardIndex = (state.flashcardIndex + 1) % len;
    renderFlashcard();
  });

  // =========================================================================
  // Automatic Adaptive Curriculum Engine (A2 -> B1 -> B2 -> C1)
  // Balances Everyday Life, Free Speaking, Culture, Grammar, Career & Interviews
  // =========================================================================
  const PILLARS = ['everyday', 'speaking', 'culture', 'grammar', 'career', 'interview'];
  const PILLAR_LABELS = {
    everyday: 'Everyday Life',
    speaking: 'Free Speaking',
    culture: 'Culture & World',
    grammar: 'Grammar in Action',
    career: 'Career & Work',
    interview: 'Job Interviews'
  };

  function loadProfile() {
    const raw = loadJSON('speakflow30_profile', {});
    const enabled = Array.isArray(raw.enabledPillars)
      ? raw.enabledPillars.filter((p) => PILLARS.includes(p))
      : [];
    return {
      profession: raw.profession || '',
      selectedLevel: raw.selectedLevel || 'auto',
      enabledPillars: enabled.length > 0 ? enabled : [...PILLARS],
      lastPillarIndex: typeof raw.lastPillarIndex === 'number' ? raw.lastPillarIndex : -1,
      completedLessonIds: Array.isArray(raw.completedLessonIds) ? raw.completedLessonIds : []
    };
  }

  function getAdaptiveProfile() {
    const profile = loadProfile();
    const sessions = historyDates.length;

    let level = profile.selectedLevel;
    if (!level || level === 'auto') {
      level = 'B1';
      if (sessions >= 25) level = 'C1';
      else if (sessions >= 16) level = 'B2+';
      else if (sessions >= 9) level = 'B2';
      else if (sessions >= 4) level = 'B1+';
    }

    const activePillars = profile.enabledPillars.length > 0 ? profile.enabledPillars : PILLARS;
    const nextIdx = (profile.lastPillarIndex + 1) % activePillars.length;
    const nextPillar = activePillars[nextIdx];
    const weakCount = vault.filter((v) => v.difficulty === 'hard').length;

    return { profile, level, activePillars, nextPillar, nextIdx, weakCount };
  }

  function updateProfileUI() {
    const { profile, level, nextPillar, weakCount } = getAdaptiveProfile();
    if ($('profile-level-badge')) $('profile-level-badge').textContent = level;
    if ($('profile-next-pillar')) $('profile-next-pillar').textContent = PILLAR_LABELS[nextPillar] || 'Everyday';
    if ($('profile-weak-count')) $('profile-weak-count').textContent = String(weakCount);
    if ($('profile-level-select')) $('profile-level-select').value = profile.selectedLevel || 'auto';

    document.querySelectorAll('.pillar-chip').forEach((chip) => {
      chip.classList.toggle('active', profile.enabledPillars.includes(chip.dataset.pillar));
    });

    if ($('endless-role-input') && profile.profession && !$('endless-role-input').value) {
      $('endless-role-input').value = profile.profession;
    }
    const savedKey = localStorage.getItem('speakflow30_gemini_key') || '';
    if ($('gemini-api-key') && savedKey && !$('gemini-api-key').value) {
      $('gemini-api-key').value = savedKey;
    }
  }

  if ($('profile-level-select')) {
    $('profile-level-select').addEventListener('change', (e) => {
      const profile = loadProfile();
      profile.selectedLevel = e.target.value;
      saveJSON('speakflow30_profile', profile);
      updateProfileUI();
    });
  }

  document.querySelectorAll('.pillar-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const profile = loadProfile();
      const pillar = chip.dataset.pillar;
      const exists = profile.enabledPillars.includes(pillar);
      if (exists && profile.enabledPillars.length <= 1) {
        return; // Always keep at least one active topic
      }
      profile.enabledPillars = exists
        ? profile.enabledPillars.filter((p) => p !== pillar)
        : PILLARS.filter((p) => p === pillar || profile.enabledPillars.includes(p));
      profile.lastPillarIndex = -1;
      saveJSON('speakflow30_profile', profile);
      updateProfileUI();
    });
  });

  function buildOfflineAutoLesson(pillar, level, profession, customTopic = '') {
    // 1. If no custom topic, check for an uncompleted built-in lesson in this pillar
    if (!customTopic) {
      const completedSet = new Set(vault.map((v) => v.id.split('::')[0]));
      const uncompletedBuiltIn = builtInLessons.filter(
        (l) => l.track === pillar && !completedSet.has(l.id)
      );
      if (uncompletedBuiltIn.length > 0) {
        const levelMatch = uncompletedBuiltIn.find((l) =>
          String(l.level || '').toUpperCase().includes(level.replace('+', '').toUpperCase())
        );
        return { lesson: levelMatch || uncompletedBuiltIn[0], isNew: false };
      }
    }

    // 2. Otherwise, synthesize a brand-new adaptive lesson from the Expression Bank
    const bank = window.SPEAKFLOW_ENDLESS_BANK || [];
    const fromBuiltIn = builtInLessons.map((l) =>
      l.expressions.map((e) => ({ ...e, pillar: l.track }))
    ).flat();
    const pool = [...bank, ...fromBuiltIn];

    const baseLevel = level.replace('+', '');
    const topicWords = customTopic.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const vaultedMap = new Map(vault.map((v) => [v.phrase.toLowerCase(), v]));
    const scored = pool.map((expr) => {
      const v = vaultedMap.get(expr.phrase.toLowerCase());
      let priority = 0;
      if (!v) priority += 4; // Never learned
      else if (v.difficulty === 'hard') priority += 3; // Needs reinforcement
      if (expr.pillar === pillar) priority += 2.5; // Matches today's pillar
      if (expr.minLevel === baseLevel) priority += 1.2; // Matches learner's level
      if (topicWords.length > 0) {
        const hay = `${expr.phrase} ${expr.feynmanExplanation} ${expr.proExample}`.toLowerCase();
        if (topicWords.some((w) => hay.includes(w))) priority += 3.5;
      }
      return { expr, score: priority + Math.random() * 0.9 };
    });

    scored.sort((a, b) => b.score - a.score);
    const picked = [];
    const seen = new Set();
    for (const item of scored) {
      const key = item.expr.phrase.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        picked.push(item.expr);
      }
      if (picked.length === 5) break;
    }

    const roleHint = profession && (pillar === 'career' || pillar === 'interview') ? ` (${profession})` : '';
    const topicLabel = customTopic || PILLAR_LABELS[pillar] || 'General Fluency';

    const introByPillar = {
      everyday: `In everyday conversations with friends, neighbors, or while traveling, natural phrasing helps you relax and speak freely. `,
      speaking: `Speaking English freely means connecting ideas smoothly and sharing stories without pausing to translate word by word. `,
      culture: `Talking about travel, modern life, habits, and culture gives you rich real-world English you can use anywhere. `,
      grammar: `Real grammar mastery happens when natural structures flow automatically inside spoken sentences instead of staying on paper. `,
      career: `In daily workplace communication${roleHint}, expressing your ideas clearly helps you collaborate smoothly and earn trust. `,
      interview: `During English job interviews${roleHint}, speaking naturally and structuring your thoughts clearly sets you apart. `
    };
    const outroByPillar = {
      everyday: ` Practicing these five everyday expressions will help you sound natural beyond textbook English.`,
      speaking: ` Rehearsing these five expressions aloud will make your spontaneous English much smoother.`,
      culture: ` Using these five expressions helps you share opinions and stories about the world around you.`,
      grammar: ` Anchoring these five patterns into your own examples builds lasting ${level} accuracy.`,
      career: ` Using these five phrases in meetings and updates will steadily elevate your English from ${level} toward fluency.`,
      interview: ` Mastering these five expressions will help you present your experience with calm confidence.`
    };
    const roleplayByPillar = {
      everyday: `Everyday Scenario: A friend invites you to join a weekend plan and asks how your week has been. Reply naturally in 4–5 sentences using at least 3 of today's expressions.`,
      speaking: `Free Speaking Challenge: Share a real story or opinion on "${topicLabel}" as if talking on a podcast or to a friend. Speak or write 4–5 connected sentences using at least 3 of today's expressions.`,
      culture: `Culture & Lifestyle Discussion: Someone asks for your thoughts or experience related to "${topicLabel}". Give an engaging 4–5 sentence response using at least 3 of today's expressions.`,
      grammar: `Grammar in Action: Talk about how your habits, decisions, or goals have changed recently in 4–5 natural sentences using at least 3 of today's expressions.`,
      career: `Career Scenario${roleHint}: A teammate asks for an update on a tricky task with a tight deadline. Write or speak a clear 4–5 sentence update using at least 3 of today's expressions.`,
      interview: `Interview Scenario${roleHint}: The interviewer asks how you handle pressure, ambiguity, or collaboration. Give a confident 4–5 sentence answer using at least 3 of today's expressions.`
    };

    // Build 2 automatic quick-check questions from the picked phrases
    const quickCheck = picked.slice(0, 2).map((target, qIdx) => {
      const distractors = picked.filter((_, i) => i !== qIdx).slice(0, 2);
      const options = [target.phrase, ...distractors.map((d) => d.phrase)];
      const correctIdx = qIdx % options.length;
      if (correctIdx !== 0) {
        [options[0], options[correctIdx]] = [options[correctIdx], options[0]];
      }
      return {
        question: `Which expression best matches: "${target.feynmanExplanation}"`,
        options,
        correctIndex: correctIdx,
        explanation: `"${target.phrase}" means: ${target.feynmanExplanation}`
      };
    });

    const sessionNum = historyDates.length + customLessons.length + 1;
    const newLesson = {
      id: `endless-auto-${Date.now()}`,
      title: customTopic ? `${customTopic} (${level} Fluency)` : `Day ${sessionNum}: ${PILLAR_LABELS[pillar]}${roleHint}`,
      category: customTopic ? `Custom Topic · ${PILLAR_LABELS[pillar]}` : `Auto-Plan · ${PILLAR_LABELS[pillar]}`,
      track: 'custom',
      level: `${level} Adaptive`,
      contextText: `${customTopic ? `Let's practice speaking naturally about ${customTopic}. ` : introByPillar[pillar]}${picked.map((e) => e.proExample).join(' ')}${outroByPillar[pillar]}`,
      expressions: picked,
      grammarTip: {
        title: `${level} Fluency Focus: Natural Chunks Over Single Words`,
        explanation: `Focus on saying each highlighted phrase as one smooth rhythmic unit instead of pausing between words. Connect your sentences with bridges like "actually", "on the other hand", or "looking back".`,
        example: picked[0]?.proExample || ''
      },
      quickCheck,
      roleplayPrompt: customTopic
        ? `Free Speaking & Roleplay (${customTopic}): Give a natural 4–5 sentence spoken or written response about "${customTopic}" using at least 3 of today's expressions.`
        : roleplayByPillar[pillar]
    };

    return { lesson: newLesson, isNew: true };
  }

  async function generateNextAutoLesson(btnEl, labelEl, errEl) {
    const { profile, level, nextPillar, nextIdx } = getAdaptiveProfile();

    const profInput = $('endless-role-input') ? $('endless-role-input').value.trim() : '';
    if (profInput) profile.profession = profInput;
    const profession = profile.profession || '';

    const customTopic = $('custom-topic-input') ? $('custom-topic-input').value.trim() : '';

    const keyInput = $('gemini-api-key') ? $('gemini-api-key').value.trim() : '';
    const apiKey = keyInput || localStorage.getItem('speakflow30_gemini_key') || '';
    if (keyInput) {
      try { localStorage.setItem('speakflow30_gemini_key', keyInput); } catch {}
    }

    if (!customTopic) {
      profile.lastPillarIndex = nextIdx;
    }
    saveJSON('speakflow30_profile', profile);

    if (errEl) errEl.classList.add('hidden');

    // If user provided a Gemini API key, auto-generate an original AI lesson tailored to their level, topic & weak phrases
    if (apiKey) {
      if (btnEl) btnEl.disabled = true;
      if (labelEl) labelEl.textContent = `Creating ${level} ${customTopic || PILLAR_LABELS[nextPillar]} Lesson...`;

      const weakPhrases = vault.filter((v) => v.difficulty === 'hard').map((v) => v.phrase).slice(0, 5);
      const recentPhrases = vault.map((v) => v.phrase).slice(0, 20);

      const pillarInstructions = {
        everyday: 'Everyday life, social small talk, daily situations, friendships, or solving everyday problems naturally.',
        speaking: 'Free speaking fluency, storytelling, sharing opinions, buying time naturally, or balanced debates.',
        culture: 'Travel, culture, movies/books, health/habits, technology, or modern society discussions.',
        grammar: 'Spoken grammar in real context (tenses, conditionals, phrasal verbs, modals, or natural connectors).',
        career: `Workplace communication, meetings, teamwork, and clear professional expression${profession ? ` (context: ${profession})` : ''}.`,
        interview: `English job interview preparation, self-presentation, STAR behavioral answers, or confidence${profession ? ` (target role: ${profession})` : ''}.`
      };

      const focusDescription = customTopic
        ? `Custom Topic requested by learner: "${customTopic}" (focus on natural spoken fluency and level growth).`
        : `${PILLAR_LABELS[nextPillar]} — ${pillarInstructions[nextPillar]}`;

      const prompt = `You are an adaptive English fluency coach. The learner's current level is ${level} (developing overall general English fluency, free speaking, and interview readiness).
Today's focus: ${focusDescription}
Weak phrases they struggled with recently (reinforce 1 if natural, otherwise pick fresh ones): ${weakPhrases.join(', ') || 'none'}.
Avoid repeating these already-learned phrases: ${recentPhrases.join(', ') || 'none'}.

CRITICAL RULES:
1. "contextText" must be 110-145 words, natural, engaging for a ${level} learner stretching upward, and MUST contain all 5 "phrase" values EXACTLY verbatim.
2. Include a helpful "grammarTip" explaining one practical spoken grammar or fluency pattern used in the passage.
3. Include 2 multiple-choice "quickCheck" questions testing grammar or natural usage from the lesson.
4. Return ONLY valid JSON:
{
  "title": "Short engaging title",
  "category": "${customTopic ? `Custom · ${customTopic}` : `Auto · ${PILLAR_LABELS[nextPillar]}`}",
  "level": "${level} Adaptive",
  "contextText": "...",
  "expressions": [
    {
      "phrase": "exact phrase from contextText",
      "feynmanExplanation": "Very clear, simple English explanation in 1 sentence",
      "basicAlternative": "simple way to say it",
      "proExample": "Natural example sentence"
    }
  ],
  "grammarTip": {
    "title": "Short grammar/fluency rule title",
    "explanation": "1-2 clear sentences on how to use this pattern in real speech.",
    "example": "A clear contrasting example sentence."
  },
  "quickCheck": [
    {
      "question": "Short grammar or usage question",
      "options": ["Option A", "Option B", "Option C"],
      "correctIndex": 0,
      "explanation": "1 short sentence explaining why."
    }
  ],
  "roleplayPrompt": "A realistic speaking or roleplay challenge asking for a 4-5 sentence response using at least 3 of today's expressions."
}`;

      try {
        const parsed = await callGeminiJSON(apiKey, prompt, 0.9);
        if (!parsed || !parsed.title || !parsed.contextText || !Array.isArray(parsed.expressions)) {
          throw new Error('Incomplete AI JSON.');
        }
        parsed.id = `lesson-custom-ai-${Date.now()}`;
        parsed.track = 'custom';
        customLessons.unshift(parsed);
        saveJSON(KEYS.CUSTOM_LESSONS, customLessons);
        if ($('custom-topic-input')) $('custom-topic-input').value = '';
        loadLesson(parsed.id);
        $('modal-lessons').classList.add('hidden');
        return;
      } catch (err) {
        if (errEl) {
          errEl.textContent = `${err.message} Loaded offline adaptive lesson instead.`;
          errEl.classList.remove('hidden');
        }
      } finally {
        if (btnEl) btnEl.disabled = false;
        if (labelEl) labelEl.textContent = 'Generate Next Auto-Lesson Now';
      }
    }

    // Offline Adaptive Engine (works 100% automatically with zero API key)
    const { lesson, isNew } = buildOfflineAutoLesson(nextPillar, level, profession, customTopic);
    if (isNew) {
      customLessons.unshift(lesson);
      saveJSON(KEYS.CUSTOM_LESSONS, customLessons);
    }
    if ($('custom-topic-input')) $('custom-topic-input').value = '';
    loadLesson(lesson.id);
    $('modal-lessons').classList.add('hidden');
  }

  $('btn-next-auto-lesson').addEventListener('click', () => {
    generateNextAutoLesson($('btn-next-auto-lesson'), null, null);
  });

  $('btn-auto-generate-now').addEventListener('click', () => {
    generateNextAutoLesson($('btn-auto-generate-now'), $('ai-gen-label'), $('ai-gen-error'));
  });

  // =========================================================================
  // Lesson Modal Tabs & Library
  // =========================================================================
  let currentTrackFilter = 'all';

  function switchLessonTab(tabName) {
    ['endless', 'browse', 'import'].forEach((t) => {
      $(`tab-lessons-${t}`).classList.toggle('active', t === tabName);
      $(`panel-lessons-${t}`).classList.toggle('hidden', t !== tabName);
    });
  }

  function openLessonModal(defaultTab = 'endless') {
    switchLessonTab(defaultTab);
    updateProfileUI();
    renderLessonList(currentTrackFilter);
    $('modal-lessons').classList.remove('hidden');
  }

  function renderLessonList(trackFilter = 'all') {
    currentTrackFilter = trackFilter;
    const list = $('lesson-list');
    list.innerHTML = '';

    const filtered = getAllLessons().filter((lesson) => {
      if (trackFilter === 'all') return true;
      if (trackFilter === 'custom') return lesson.track === 'custom' || String(lesson.id).startsWith('lesson-custom') || String(lesson.id).startsWith('endless-');
      return lesson.track === trackFilter;
    });

    if (filtered.length === 0) {
      list.innerHTML = `<p class="muted-text">No lessons in this category yet. Click "Generate Next Auto-Lesson Now" in the Auto-Plan tab!</p>`;
      return;
    }

    filtered.forEach((lesson) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `lesson-option${state.lesson && lesson.id === state.lesson.id ? ' active' : ''}`;
      btn.innerHTML = `
        <div>
          <strong>${escapeHTML(lesson.title)}</strong>
          <div class="muted-text">${escapeHTML(lesson.category || 'Custom')} · ${escapeHTML(lesson.level || 'A2→C1')}</div>
        </div>
        <span class="tag">${lesson.expressions.length} phrases</span>
      `;
      btn.addEventListener('click', () => {
        loadLesson(lesson.id);
        $('modal-lessons').classList.add('hidden');
      });
      list.appendChild(btn);
    });
  }

  document.querySelectorAll('.track-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.track-filter-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderLessonList(btn.dataset.track);
    });
  });

  $('btn-open-lessons').addEventListener('click', () => openLessonModal('endless'));
  $('tab-lessons-endless').addEventListener('click', () => switchLessonTab('endless'));
  $('tab-lessons-browse').addEventListener('click', () => switchLessonTab('browse'));
  $('tab-lessons-import').addEventListener('click', () => switchLessonTab('import'));

  $('btn-copy-ai-prompt').addEventListener('click', async () => {
    const promptText = `Generate an English fluency lesson JSON for SpeakFlow 30 (Topic: [YOUR TOPIC], Level: [A2/B1/B2/C1]) with this exact structure:
{
  "id": "lesson-custom-${Date.now()}",
  "title": "Lesson Title",
  "category": "Free Speaking / Everyday / Grammar / Interview",
  "level": "B1 → B2",
  "contextText": "A 120-150 word realistic passage containing all 5 exact target phrases verbatim.",
  "expressions": [
    {
      "phrase": "exact phrase from contextText",
      "feynmanExplanation": "Plain English explanation in 1 sentence.",
      "basicAlternative": "simple version",
      "proExample": "Natural example sentence."
    }
  ],
  "grammarTip": {
    "title": "Key Grammar or Fluency Pattern",
    "explanation": "1-2 clear sentences explaining how to use it naturally.",
    "example": "Clear example sentence."
  },
  "quickCheck": [
    {
      "question": "Short grammar or usage question",
      "options": ["Option A", "Option B", "Option C"],
      "correctIndex": 0,
      "explanation": "Short explanation."
    }
  ],
  "roleplayPrompt": "A realistic speaking or roleplay challenge asking the user to respond in 4-5 sentences using at least 3 expressions."
}
Return ONLY valid JSON.`;
    try {
      await navigator.clipboard.writeText(promptText);
      $('btn-copy-ai-prompt').textContent = 'Prompt Copied!';
      setTimeout(() => {
        $('btn-copy-ai-prompt').textContent = 'Copy AI Lesson Generator Prompt';
      }, 2000);
    } catch {
      alert(promptText);
    }
  });

  $('btn-import-lesson').addEventListener('click', () => {
    const errEl = $('import-error');
    errEl.classList.add('hidden');
    try {
      const parsed = JSON.parse($('custom-lesson-json').value.trim());
      if (!parsed.title || !parsed.contextText || !Array.isArray(parsed.expressions) || parsed.expressions.length === 0 || !parsed.roleplayPrompt) {
        throw new Error('JSON must include title, contextText, expressions (array), and roleplayPrompt.');
      }
      if (!parsed.id) parsed.id = `lesson-custom-${Date.now()}`;
      parsed.track = 'custom';
      customLessons.unshift(parsed);
      saveJSON(KEYS.CUSTOM_LESSONS, customLessons);
      $('custom-lesson-json').value = '';
      loadLesson(parsed.id);
      $('modal-lessons').classList.add('hidden');
    } catch (err) {
      errEl.textContent = `Invalid lesson JSON: ${err.message}`;
      errEl.classList.remove('hidden');
    }
  });

  // =========================================================================
  // Memory Vault, Streak Heatmap & 60-Second Blitz Recall
  // =========================================================================
  function getDueItems() {
    const now = Date.now();
    return vault.filter((item) => item.difficulty === 'hard' || now >= (item.nextReviewAt || 0));
  }

  function updateVaultBadge() {
    const due = getDueItems();
    const badge = $('vault-due-badge');
    badge.textContent = String(due.length);
    badge.classList.toggle('hidden', due.length === 0);

    if (due.length > 0 && state.currentStage === 1) {
      $('blitz-banner').classList.remove('hidden');
      $('blitz-banner-title').textContent = `${due.length} expression${due.length > 1 ? 's' : ''} due for review`;
    } else {
      $('blitz-banner').classList.add('hidden');
    }
  }

  function calculateStreak() {
    if (historyDates.length === 0) return 0;
    const set = new Set(historyDates);
    let streak = 0;
    const d = new Date();
    if (!set.has(todayISO())) {
      d.setDate(d.getDate() - 1);
    }
    while (true) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const iso = `${y}-${m}-${day}`;
      if (set.has(iso)) {
        streak += 1;
        d.setDate(d.getDate() - 1);
      } else {
        break;
      }
    }
    return streak;
  }

  function renderVaultModal(filter = 'all') {
    $('stat-streak').textContent = String(calculateStreak());
    $('stat-total-sessions').textContent = String(historyDates.length);
    $('stat-mastered-count').textContent = String(vault.length);

    // 28-day heatmap
    const heatmap = $('streak-heatmap');
    heatmap.innerHTML = '';
    const dateSet = new Set(historyDates);
    const today = todayISO();
    for (let i = 27; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const cell = document.createElement('div');
      cell.className = `heat-cell${dateSet.has(iso) ? ' done' : ''}${iso === today ? ' today' : ''}`;
      cell.title = iso + (dateSet.has(iso) ? ' — Completed' : '');
      heatmap.appendChild(cell);
    }

    // Items list
    const now = Date.now();
    const filtered = vault.filter((item) => {
      if (filter === 'hard') return item.difficulty === 'hard';
      if (filter === 'due') return item.difficulty === 'hard' || now >= (item.nextReviewAt || 0);
      return true;
    });

    const listEl = $('vault-items-list');
    listEl.innerHTML = '';
    if (filtered.length === 0) {
      listEl.innerHTML = `<p class="muted-text">No expressions in this view yet. Complete a session to build your Memory Vault.</p>`;
    } else {
      filtered.forEach((item) => {
        const div = document.createElement('div');
        div.className = 'vault-item';
        div.innerHTML = `
          <div class="vault-item-top">
            <strong>${escapeHTML(item.phrase)}</strong>
            <span class="tag">${item.difficulty === 'hard' ? 'Hard Mode' : `Interval: ${item.intervalDays || 3}d`}</span>
          </div>
          <p class="muted-text">${escapeHTML(item.personalAnchor || item.proExample || '')}</p>
        `;
        listEl.appendChild(div);
      });
    }

    $('btn-vault-blitz').disabled = vault.length === 0;
  }

  $('btn-open-vault').addEventListener('click', () => {
    renderVaultModal('all');
    $('modal-vault').classList.remove('hidden');
  });

  document.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderVaultModal(btn.dataset.filter);
    });
  });

  // 60-Second Blitz Recall
  function startBlitzRecall() {
    const due = getDueItems();
    const pool = due.length > 0 ? due : vault;
    if (pool.length === 0) return;

    state.blitzItems = pool.slice(0, 5);
    state.blitzIndex = 0;
    state.blitzScore = 0;
    state.blitzSecondsLeft = 60;

    $('modal-vault').classList.add('hidden');
    $('blitz-active-view').classList.remove('hidden');
    $('blitz-done-view').classList.add('hidden');
    $('modal-blitz').classList.remove('hidden');

    renderBlitzItem();

    if (state.blitzTimer) clearInterval(state.blitzTimer);
    $('blitz-timer').textContent = formatTime(state.blitzSecondsLeft);
    state.blitzTimer = setInterval(() => {
      state.blitzSecondsLeft -= 1;
      $('blitz-timer').textContent = formatTime(state.blitzSecondsLeft);
      if (state.blitzSecondsLeft <= 0) {
        finishBlitzRecall();
      }
    }, 1000);
  }

  function renderBlitzItem() {
    const item = state.blitzItems[state.blitzIndex];
    if (!item) {
      finishBlitzRecall();
      return;
    }

    $('blitz-progress-label').textContent = `Item ${state.blitzIndex + 1} of ${state.blitzItems.length}`;
    $('blitz-feynman-clue').textContent = `Clue: ${item.feynmanExplanation}`;

    const sourceSentence = item.personalAnchor || item.proExample || '';
    const regex = new RegExp(escapeRegex(item.phrase), 'i');
    const blanked = regex.test(sourceSentence)
      ? sourceSentence.replace(regex, '__________')
      : `${sourceSentence} (Missing phrase: __________)`;

    $('blitz-blank-sentence').textContent = blanked;
    $('blitz-answer-input').value = '';
    $('blitz-feedback').classList.add('hidden');
    $('blitz-answer-input').focus();
  }

  function checkBlitzAnswer() {
    const item = state.blitzItems[state.blitzIndex];
    if (!item) return;

    const guess = $('blitz-answer-input').value.trim().toLowerCase();
    const target = item.phrase.toLowerCase();
    const fb = $('blitz-feedback');
    fb.classList.remove('hidden', 'ok', 'bad');

    if (guess === target) {
      state.blitzScore += 1;
      fb.textContent = 'Correct! Moving spaced-repetition interval forward.';
      fb.classList.add('ok');

      // Advance interval: 1d -> 3d -> 7d
      const nextDays = item.intervalDays <= 1 ? 3 : 7;
      item.intervalDays = nextDays;
      item.difficulty = 'easy';
      item.lastReviewedAt = Date.now();
      item.nextReviewAt = Date.now() + nextDays * 24 * 60 * 60 * 1000;
      saveJSON(KEYS.VAULT, vault);

      setTimeout(() => {
        state.blitzIndex += 1;
        renderBlitzItem();
      }, 650);
    } else {
      fb.textContent = `Not quite — keep trying or click Reveal Answer.`;
      fb.classList.add('bad');
    }
  }

  function finishBlitzRecall() {
    if (state.blitzTimer) {
      clearInterval(state.blitzTimer);
      state.blitzTimer = null;
    }
    $('blitz-active-view').classList.add('hidden');
    $('blitz-done-view').classList.remove('hidden');
    $('blitz-score-heading').textContent = `Blitz Complete: ${state.blitzScore} / ${state.blitzItems.length}`;
    $('blitz-score-sub').textContent = `Your Memory Vault intervals have been updated. Ready for today's 30-minute session!`;
    updateVaultBadge();
  }

  $('btn-start-blitz').addEventListener('click', startBlitzRecall);
  $('btn-vault-blitz').addEventListener('click', startBlitzRecall);
  $('btn-dismiss-blitz').addEventListener('click', () => $('blitz-banner').classList.add('hidden'));
  $('btn-blitz-check').addEventListener('click', checkBlitzAnswer);
  $('blitz-answer-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') checkBlitzAnswer();
  });

  $('btn-blitz-reveal').addEventListener('click', () => {
    const item = state.blitzItems[state.blitzIndex];
    if (!item) return;
    const fb = $('blitz-feedback');
    fb.classList.remove('hidden', 'ok');
    fb.classList.add('bad');
    fb.textContent = `Answer: "${item.phrase}"`;
  });

  $('btn-blitz-close').addEventListener('click', () => {
    if (state.blitzTimer) clearInterval(state.blitzTimer);
    $('modal-blitz').classList.add('hidden');
  });

  $('btn-blitz-finish').addEventListener('click', () => {
    $('modal-blitz').classList.add('hidden');
  });

  // Modal Close Buttons
  document.querySelectorAll('.modal-close').forEach((btn) => {
    btn.addEventListener('click', () => {
      $(btn.dataset.close).classList.add('hidden');
    });
  });

  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop && backdrop.id !== 'modal-blitz') {
        backdrop.classList.add('hidden');
      }
    });
  });

  // =========================================================================
  // Service Worker & Init
  // =========================================================================
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  initTheme();
  const initialLessonId = localStorage.getItem(KEYS.ACTIVE_LESSON_ID) || (builtInLessons[0] && builtInLessons[0].id);
  loadLesson(initialLessonId);
  updateVaultBadge();
})();
