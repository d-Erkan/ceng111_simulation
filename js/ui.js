/* Von Neumann Machine Simulator: browser UI. Depends on VNCore (core.js) and VNExamples (examples.js). */
(function () {
  'use strict';

  const VN = window.VNCore;
  const EXAMPLES = window.VNExamples;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const HISTORY_LIMIT = 20000;
  const TRACE_LIMIT = 20000;
  const TRACE_VISIBLE = 300;
  const RUN_LIMIT = 1000; // instructions per Run, to stop endless loops
  const STORE_KEY = 'ceng111-simulation:v3';
  const THEME_KEY = 'ceng111-theme';

  const COMPONENTS = ['CU', 'PC', 'INC', 'IR', 'CC', 'MAR', 'MDR', 'R', 'ALU', 'IN', 'OUT'];
  const PARTS = { CU: 'ctrl', PC: 'ctrl', IR: 'ctrl', CC: 'ctrl', INC: 'ctrl', MAR: 'memif', MDR: 'memif', ALU: 'data', R: 'data', MEM: 'memory', IN: 'io', OUT: 'io' };
  const COMPONENT_NAMES = { CU: 'Control unit', MEM: 'Memory', CC: 'Condition codes', INC: '+1 circuit', IN: 'Input device', OUT: 'Output device' };
  const PREDICT_FIELDS = [
    { key: 'pc', label: 'PC', kind: 'addr', hint: 'address of the next instruction' },
    { key: 'ir', label: 'IR', kind: 'word', hint: 'the instruction' },
    { key: 'mar', label: 'MAR', kind: 'addr', hint: 'last address sent to memory' },
    { key: 'mdr', label: 'MDR', kind: 'word', hint: 'last value fetched or stored' },
    { key: 'r', label: 'R', kind: 'word', hint: 'the register' },
  ];

  const machine = new VN.Machine();
  const state = {
    format: 'bin',
    loadedWords: new Array(VN.MEM_SIZE).fill(0),
    // what each memory row holds in the loaded program: { kind: 'instruction' | 'data' | 'unused', label }
    rowInfo: new Array(VN.MEM_SIZE).fill(null).map(() => ({ kind: 'unused', label: '' })),
    history: [], // [{ snap, traceLen, traceOffset, lastRec }]
    trace: [],
    traceOffset: 0,
    lastRec: null,
    running: false,
    timer: null,
    practice: false,
    practiceView: null, // null | 'form' | 'result'
    practiceResult: null,
    practiceStats: { answered: 0, perfect: 0 },
    demo: null, // { choosing, kind, frames, i, restore } while a guided demo is open
  };

  // ------------------------------------------------------------------------------------------------ formatting

  const fmtWord = (v) => (state.format === 'dec' ? String(v) : VN.wordBin(v));
  const fmtAddr = (v) => (state.format === 'dec' ? String(v) : VN.toBin(v, VN.ADDR_BITS));
  function fmt(value, kind) {
    if (kind === 'word') return fmtWord(value);
    if (kind === 'addr') return fmtAddr(value);
    if (kind === 'opcode') return VN.toBin(value, VN.OPCODE_BITS);
    return String(value);
  }
  function allForms(v, kind) {
    if (kind === 'addr') return `binary ${VN.toBin(v, VN.ADDR_BITS)} · decimal ${v}`;
    return `binary ${VN.wordBin(v)} · decimal ${v} · as instruction: ${VN.disassemble(v)}`;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  const valSpan = (v, kind) => `<span class="v" title="${esc(allForms(v, kind))}">${esc(fmt(v, kind))}</span>`;
  const richText = (text) => esc(text).replace(/\{([wa]):(\d+)\}/g, (_, k, n) => valSpan(Number(n), k === 'w' ? 'word' : 'addr'));
  const partDot = (c) => (PARTS[c] ? `<span class="dot part-${PARTS[c]}"></span>` : '');

  /** Parses a value typed by a student: binary digits in binary mode, a whole number in decimal mode, or 0b…. */
  function parseUserValue(text, kind, format = state.format) {
    const t = text.trim().replace(/[\s_]/g, '');
    if (!t) return null;
    let v = null;
    if (/^0b[01]+$/i.test(t)) v = parseInt(t.slice(2), 2);
    else if (format === 'bin') v = /^[01]+$/.test(t) ? parseInt(t, 2) : null;
    else v = /^\d+$/.test(t) ? parseInt(t, 10) : null;
    if (v === null) return null;
    const max = kind === 'addr' ? VN.ADDR_MASK : VN.WORD_MASK;
    return v <= max ? v : null;
  }

  // ------------------------------------------------------------------------------------------------ persistence

  function loadStore() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    } catch {
      return {};
    }
  }
  function saveStore() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ asm: $('#asm-src').value, input: $('#input-values').value, format: state.format }));
    } catch {
      /* storage unavailable (private mode): ignore */
    }
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
  }
  function setMsg(el, text, kind) {
    el.textContent = text;
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  // ------------------------------------------------------------------------------------------------ theme

  function currentTheme() {
    const t = document.documentElement.dataset.theme;
    if (t) return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function showThemeButton() {
    $('#btn-theme').textContent = currentTheme() === 'dark' ? '☀️ Light' : '🌙 Dark';
  }
  function toggleTheme() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* ignore */
    }
    showThemeButton();
  }

  // ------------------------------------------------------------------------------------------------ program loading

  /** Translates the program into bits and puts it into memory (happens automatically while typing). */
  function loadProgram() {
    const asm = VN.assemble($('#asm-src').value);
    if (asm.errors.length) {
      setMsg($('#asm-msg'), `The program has a mistake, so the memory was not changed:\n${asm.errors.map((e) => `Line ${e.line}: ${e.message}`).join('\n')}`, 'error');
      return false;
    }
    state.loadedWords = asm.words.slice();
    state.rowInfo = rowInfoOf(asm);
    resetMachine();
    const last = asm.listing.length ? asm.listing[asm.listing.length - 1].addr : 0;
    setMsg($('#asm-msg'), `✓ The program is in memory (cells 0–${last}). Press "Next step" to start.`, 'ok');
    saveStore();
    return true;
  }

  /** Which rows hold instructions, which hold data (with their label, e.g. "data A") and which are not used. */
  function rowInfoOf(asm) {
    const labelAt = {};
    for (const [name, addr] of Object.entries(asm.symbols || {})) if (!(addr in labelAt)) labelAt[addr] = name;
    const info = new Array(VN.MEM_SIZE).fill(null).map(() => ({ kind: 'unused', label: '' }));
    for (const l of asm.listing) info[l.addr] = { kind: l.kind || 'instruction', label: labelAt[l.addr] || '' };
    // A data row without a label of its own continues the list above it: ARR, ARR+1, ARR+2, ...
    for (let i = 1; i < VN.MEM_SIZE; i++) {
      if (info[i].kind !== 'data' || info[i].label) continue;
      let k = i - 1;
      while (k >= 0 && info[k].kind === 'data' && !labelAt[k]) k--;
      if (k >= 0 && info[k].kind === 'data' && labelAt[k]) info[i].label = `${labelAt[k]}+${i - k}`;
    }
    return info;
  }

  /** "I" for an instruction row, "D" for a data row, "" for a row the program does not use. */
  function rowKindLetter(i, v, isPc) {
    const kind = state.rowInfo[i].kind;
    if (isPc || kind === 'instruction') return 'I';
    return kind === 'data' || v !== 0 ? 'D' : '';
  }

  /** The text of the "Instruction / data" column for a row. */
  function rowMeaning(i, v, isPc) {
    const info = state.rowInfo[i];
    if (isPc || info.kind === 'instruction') return VN.disassemble(v);
    if (info.kind === 'data') return info.label ? `data ${info.label}` : 'data';
    return v === 0 ? '' : 'data'; // an unused row that the program has written into
  }

  function applyInputField() {
    const r = VN.parseValueList($('#input-values').value);
    setMsg($('#input-msg'), r.errors.join('\n'), r.errors.length ? 'error' : '');
    machine.setInput(r.values);
  }

  // ------------------------------------------------------------------------------------------------ execution

  function resetMachine() {
    stopRun();
    machine.load(state.loadedWords);
    applyInputField();
    state.history = [];
    state.trace = [];
    state.traceOffset = 0;
    state.lastRec = null;
    state.practiceView = state.practice ? 'form' : null;
    render();
  }

  function doMicroStep() {
    if (machine.halted) return false;
    const snap = machine.snapshot();
    const instrNo = machine.instructionCount + 1;
    const rec = machine.microStep();
    if (!rec) return false;
    if (rec.blocked) {
      state.lastRec = rec;
      return false;
    }
    state.history.push({ snap, traceLen: state.trace.length, traceOffset: state.traceOffset, lastRec: state.lastRec });
    if (state.history.length > HISTORY_LIMIT) state.history.shift();
    state.trace.push({ rec, instrNo });
    if (state.trace.length > TRACE_LIMIT) {
      state.trace.shift();
      state.traceOffset += 1;
    }
    state.lastRec = rec;
    return true;
  }

  /** Runs the rest of the current instruction. Returns its records (empty if nothing ran). */
  function doInstruction() {
    const recs = [];
    while (doMicroStep()) {
      recs.push(state.lastRec);
      if (state.lastRec.instructionDone) break;
    }
    return recs;
  }

  function stepBack() {
    const h = state.history.pop();
    if (!h) return;
    machine.restore(h.snap);
    applyInputField();
    const drop = state.traceOffset - h.traceOffset;
    state.trace.length = Math.max(0, h.traceLen - drop);
    state.lastRec = h.lastRec;
  }

  function startRun() {
    if (machine.halted) return;
    state.running = true;
    const startCount = machine.instructionCount;
    const tick = () => {
      if (!state.running) return;
      const ms = Number($('#speed').value);
      const batch = ms === 0 ? 500 : 1;
      for (let i = 0; i < batch; i++) {
        if (machine.instructionCount - startCount >= RUN_LIMIT) {
          stopRun();
          toast(`Stopped after ${RUN_LIMIT} instructions. Is the program missing a HALT, or is it in an endless loop?`);
          break;
        }
        if (!doMicroStep()) {
          stopRun();
          break;
        }
      }
      render();
      if (state.running) state.timer = setTimeout(tick, ms);
    };
    tick();
  }
  function stopRun() {
    state.running = false;
    clearTimeout(state.timer);
  }

  // ------------------------------------------------------------------------------------------------ practice mode

  function setPractice(on) {
    stopRun();
    state.practice = on;
    state.practiceView = on ? 'form' : null;
    if (on && !machine.atInstructionBoundary) doInstruction(); // practice starts at the beginning of an instruction
    const b = $('#btn-practice');
    b.setAttribute('aria-pressed', String(on));
    b.innerHTML = `🎯 Practice mode: <b>${on ? 'ON' : 'OFF'}</b>`;
    b.classList.toggle('on', on);
    render();
  }

  function practiceFormHtml() {
    if (machine.halted) {
      return `<div class="practice"><h3>The program has finished (HALT).</h3>
        <p>${scoreText()}</p><p>Press <b>⟲ Reset</b> to practise the same program again, or choose another example.</p></div>`;
    }
    const cur = machine.registers();
    const ph = (kind) => (state.format === 'dec' ? 'e.g. 5' : kind === 'addr' ? 'e.g. 0101' : 'e.g. 0011 0101');
    const fields = PREDICT_FIELDS.map(
      (f) => `<label><span class="lbl">${f.label}</span><input type="text" data-key="${f.key}" autocomplete="off" spellcheck="false" placeholder="${ph(f.kind)}"><small>${f.hint}</small></label>`,
    ).join('');
    const ccSelect = (k) => `<label class="cc"><span class="lbl">${k.toUpperCase()}</span><select data-key="${k}"><option value="">?</option><option>0</option><option>1</option></select></label>`;
    return `<div class="practice">
      <h3>🎯 Predict the next instruction</h3>
      <ol class="practice-steps">
        <li>PC is ${valSpan(machine.pc, 'addr')}, so the next instruction is in <b>memory cell ${machine.pc}</b>. Find it in the memory.</li>
        <li>Decode it: the first 4 bits are the <b>op code</b> (see the instruction table at the bottom of the page), and the last 4 bits are the <b>address X</b>.</li>
        <li>On paper, go through <b>fetch, decode and execute</b>.</li>
        <li>Write what each register will hold <b>after the whole instruction is finished</b>.</li>
      </ol>
      <p class="now">Registers now: PC ${valSpan(cur.pc, 'addr')} · IR ${valSpan(cur.ir, 'word')} · MAR ${valSpan(cur.mar, 'addr')} · MDR ${valSpan(cur.mdr, 'word')} · R ${valSpan(cur.r, 'word')} · GT ${cur.gt} EQ ${cur.eq} LT ${cur.lt}</p>
      <div class="predict-grid">${fields}<div class="cc-group">${['gt', 'eq', 'lt'].map(ccSelect).join('')}<small>condition codes</small></div></div>
      <p class="hint">Type ${state.format === 'dec' ? 'decimal numbers (0 … 255)' : 'binary digits (4 for an address, 8 for a value; spaces are allowed)'}. You can change this with "Show numbers in" at the top.</p>
      <div class="btn-row">
        <button id="btn-check" class="primary">Check my answers</button>
        <button id="btn-reveal">Show me the answer</button>
        <span class="score">${scoreText()}</span>
      </div>
      <div id="predict-msg" class="msg"></div>
    </div>`;
  }

  function scoreText() {
    const s = state.practiceStats;
    return s.answered ? `Score: ${s.perfect} of ${s.answered} instructions fully correct.` : '';
  }

  function checkPredict(reveal) {
    const sim = machine.clone();
    const preview = sim.stepInstruction();
    if (preview.length && preview[preview.length - 1].blocked) {
      setMsg($('#predict-msg'), 'This instruction is IN, but the Input box has no values left. Type an input value first.', 'error');
      return;
    }
    const rows = PREDICT_FIELDS.map((f) => {
      const raw = $(`#explain input[data-key="${f.key}"]`).value;
      const guess = parseUserValue(raw, f.kind);
      return { label: f.label, kind: f.kind, raw, guess, correct: sim[f.key], ok: guess === sim[f.key] };
    });
    for (const k of ['gt', 'eq', 'lt']) {
      const raw = $(`#explain select[data-key="${k}"]`).value;
      rows.push({ label: k.toUpperCase(), kind: 'bit', raw, guess: raw === '' ? null : Number(raw), correct: sim[k], ok: raw !== '' && Number(raw) === sim[k] });
    }
    if (!reveal) {
      state.practiceStats.answered += 1;
      if (rows.every((r) => r.ok)) state.practiceStats.perfect += 1;
    }
    const startPc = machine.pc;
    const recs = doInstruction();
    state.practiceResult = { rows, recs, reveal, startPc };
    state.practiceView = 'result';
    render();
  }

  function practiceResultHtml() {
    const { rows, recs, reveal, startPc } = state.practiceResult;
    const all = rows.every((r) => r.ok);
    const show = (r) => (r.kind === 'bit' ? String(r.correct) : valSpan(r.correct, r.kind));
    const body = rows
      .map((r) => {
        const yours = reveal ? '' : `<td class="mono">${r.raw === '' ? '<i>empty</i>' : esc(r.raw)}${r.raw !== '' && r.guess === null ? ' <small>(not a valid value)</small>' : ''}</td>`;
        const mark = reveal ? '' : `<td class="${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓' : '✗'}</td>`;
        return `<tr><td><b>${r.label}</b></td>${yours}<td>${show(r)}</td>${mark}</tr>`;
      })
      .join('');
    const steps = recs.map((r) => `<li><span class="badge ${r.phase}">${r.phase}</span> <code>${esc(r.rtl)}</code></li>`).join('');
    const name = recs.some((r) => r.op === 'DECODE') ? VN.disassemble(machine.ir) : '';
    const title = reveal ? 'Here is the answer.' : all ? '✅ All correct, well done!' : '❌ Some answers are wrong. Compare them with the correct values below.';
    return `<div class="practice">
      <h3>${title}</h3>
      <p>The instruction in cell ${startPc} was <b>${esc(name)}</b>. The registers after it finished:</p>
      <table class="io-table predict-result"><thead><tr><th>Register</th>${reveal ? '' : '<th>Your answer</th>'}<th>Correct</th>${reveal ? '' : '<th></th>'}</tr></thead><tbody>${body}</tbody></table>
      <h4>What happened, step by step</h4>
      <ol class="step-list">${steps}</ol>
      <p class="hint">The execution trace below shows the register values after every step.</p>
      <div class="btn-row">
        ${machine.halted ? '' : '<button id="btn-next-predict" class="primary">Predict the next instruction ▶</button>'}
        <span class="score">${scoreText()}</span>
      </div>
      ${machine.halted ? '<p><b>The program has finished.</b> Press ⟲ Reset to practise again.</p>' : ''}
    </div>`;
  }

  // ------------------------------------------------------------------------------------------------ rendering

  function buildStatic() {
    // Memory rows inside the diagram: # | Address | Contents (8 bits, a space after the first 4) | Decimal | Instruction
    const g = $('#mem-rows');
    const ns = 'http://www.w3.org/2000/svg';
    for (let i = 0; i < VN.MEM_SIZE; i++) {
      const y = 68 + i * 21.9;
      const row = document.createElementNS(ns, 'g');
      row.setAttribute('class', 'mrow');
      row.id = `m-${i}`;
      row.innerHTML = `<rect x="650" y="${y}" width="420" height="20.5" rx="4"></rect>
        <text class="mnum" x="660" y="${y + 15}">${i}</text>
        <text class="maddr" x="680" y="${y + 15}">${VN.toBin(i, VN.ADDR_BITS)}</text>
        <text class="mword" x="820" y="${y + 15}"></text>
        <text class="mdec" x="915" y="${y + 15}"></text>
        <text class="mdis" x="972" y="${y + 15}"></text>
        <text class="pc-mark" x="1046" y="${y + 15}"></text>`;
      g.appendChild(row);
    }

    // Memory editor: # | Address | Contents | Decimal | Instruction
    const tbody = $('#mem-table tbody');
    for (let i = 0; i < VN.MEM_SIZE; i++) {
      const tr = document.createElement('tr');
      tr.id = `mt-${i}`;
      tr.innerHTML = `<td class="rownum">${i}</td><td class="addr">${VN.toBin(i, VN.ADDR_BITS)}</td>
        <td><input type="text" maxlength="9" aria-label="Contents of row ${i}, 8 binary digits" spellcheck="false"></td>
        <td class="num"></td><td class="dis"></td><td class="kind"></td>`;
      const inp = tr.querySelector('input');
      inp.addEventListener('change', () => {
        const v = parseUserValue(inp.value, 'word', 'bin');
        if (v === null || inp.value.replace(/\s/g, '').length !== VN.WORD_BITS) {
          inp.classList.add('invalid');
          toast(`Row ${i}: type exactly 8 binary digits, e.g. 0011 0101.`);
          return;
        }
        inp.classList.remove('invalid');
        machine.mem[i] = v;
        state.loadedWords[i] = v;
        render();
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') inp.blur();
      });
      tbody.appendChild(tr);
    }

    // Instruction set reference.
    $('#isa-table tbody').innerHTML = VN.INSTRUCTIONS.map(
      (ins) => `<tr><td>${VN.toBin(ins.opcode, VN.OPCODE_BITS)} <small>(${ins.opcode})</small></td><td>${ins.name}${ins.noOperand ? '' : ' X'}</td>
        <td><code>${esc(ins.meaning)}</code><br>${esc(ins.summary)}</td>
        <td>${VN.EXEC_PLANS[ins.name].map(([op, p]) => esc(VN.microText(op, p))).join('<br>')}</td></tr>`,
    ).join('');

    $('#examples').innerHTML += EXAMPLES.map((ex) => `<option value="${ex.id}">${esc(ex.title)}</option>`).join('');
  }

  function render() {
    const rec = state.lastRec && !state.lastRec.blocked ? state.lastRec : null;
    const waiting = !!(state.lastRec && state.lastRec.blocked);
    const changes = (rec && rec.changes) || {};

    // Registers.
    const regs = { PC: ['pc', 'addr'], IR: ['ir', 'word'], MAR: ['mar', 'addr'], MDR: ['mdr', 'word'], R: ['r', 'word'] };
    for (const [name, [key, kind]] of Object.entries(regs)) {
      const el = $(`#v-${name}`);
      el.textContent = fmt(machine[key], kind);
      el.classList.toggle('changed', key in changes);
      setTitle(el.parentNode, `${name} = ${allForms(machine[key], kind)}`);
    }
    for (const k of ['gt', 'eq', 'lt']) {
      const el = $(`#v-${k.toUpperCase()}`);
      el.textContent = String(machine[k]);
      el.classList.toggle('changed', k in changes);
    }
    $('#v-ALU').textContent = rec && rec.alu ? `operation: ${rec.alu}` : '';

    // Control unit.
    const phase = machine.halted ? 'HALTED' : rec ? rec.phase : 'READY';
    const cuPhase = $('#cu-phase');
    cuPhase.textContent = waiting ? 'Waiting for input' : phase === 'READY' ? 'Ready to start' : phase === 'HALTED' ? 'Halted' : `Phase: ${phase}`;
    cuPhase.setAttribute('class', `cu-line strong phase-${waiting ? 'HALTED' : phase}`);
    $('#cu-instr').textContent = machine.decoded ? `Instruction: ${VN.disassemble(machine.ir)}` : 'Instruction: (not decoded yet)';
    $('#cu-rtl').textContent = rec ? rec.rtl : '';
    $('#cu-clock').textContent = `step ${machine.stepCount} · instructions done ${machine.instructionCount}`;

    // Active components, wires, buses.
    const active = new Set((state.lastRec && state.lastRec.active) || (waiting ? ['CU', 'IN'] : []));
    for (const c of COMPONENTS) $(`#c-${c}`).classList.toggle('active', active.has(c));
    const wires = new Set((rec && rec.wires) || []);
    $$('[data-wire]').forEach((w) => w.classList.toggle('active', wires.has(w.dataset.wire)));
    const bus = (rec && rec.bus) || {};
    $('#t-bus-internal').textContent = bus.internal !== undefined ? fmt(bus.internal, bus.internalKind) : '';
    $('#t-bus-addr').textContent = bus.address !== undefined ? fmtAddr(bus.address) : '';
    $('#t-bus-data').textContent = bus.data !== undefined ? fmtWord(bus.data) : '';
    const ctrl = $('#t-bus-ctrl');
    ctrl.textContent = bus.control ? `control signal: ${bus.control}` : 'control signal: none';
    ctrl.classList.toggle('on', !!bus.control);

    // Memory (diagram + editor). Addresses and contents are always shown in binary, with the decimal value beside.
    const written = new Set(((rec && rec.memWrites) || []).map((w) => w.addr));
    for (let i = 0; i < VN.MEM_SIZE; i++) {
      const v = machine.mem[i];
      const isPc = i === machine.pc && !machine.halted;
      const isAccess = bus.address === i;
      const row = $(`#m-${i}`);
      row.querySelector('.mword').textContent = VN.wordBin(v);
      row.querySelector('.mdec').textContent = String(v);
      const unused = state.rowInfo[i].kind === 'unused' && v === 0 && !isPc;
      row.querySelector('.mdis').textContent = rowMeaning(i, v, isPc);
      row.querySelector('.pc-mark').textContent = isPc ? '◀ PC' : '';
      row.setAttribute('class', `mrow${isPc ? ' pc' : ''}${isAccess ? ' access' : ''}${written.has(i) ? ' written' : ''}${unused ? ' unused' : ''}`);
      setTitle(row, `cell ${i}: ${allForms(v, 'word')}`);

      const tr = $(`#mt-${i}`);
      tr.classList.toggle('pc', isPc);
      tr.classList.toggle('access', isAccess);
      tr.classList.toggle('unused', unused);
      const letter = rowKindLetter(i, v, isPc);
      const kindCell = tr.querySelector('.kind');
      kindCell.textContent = letter;
      kindCell.className = `kind${letter ? ` k-${letter}` : ''}`;
      kindCell.title = letter === 'I' ? 'instruction' : letter === 'D' ? 'data' : 'not used';
      const inp = tr.querySelector('input');
      if (document.activeElement !== inp) {
        inp.value = VN.wordBin(v);
        inp.classList.remove('invalid');
      }
      tr.querySelector('.num').textContent = String(v);
      tr.querySelector('.dis').innerHTML = `${esc(rowMeaning(i, v, isPc) || 'not used')}${isPc ? ' <span class="pc-tag">◀ PC</span>' : ''}`;
    }

    // I/O.
    const nextIn = machine.input[machine.inputPos];
    $('#v-IN').textContent = nextIn === undefined ? 'next value: (none)' : `next value: ${nextIn}`;
    const lastOut = machine.output[machine.output.length - 1];
    $('#v-OUT').textContent = lastOut === undefined ? 'printed: —' : `printed: ${machine.output.slice(-4).join(', ')}`;
    $('#input-chips').innerHTML = machine.input.length
      ? machine.input.map((v, i) => `<span class="chip${i < machine.inputPos ? ' used' : i === machine.inputPos ? ' next' : ''}">${v}</span>`).join('')
      : '<span class="empty">no input values</span>';
    $('#output-list').innerHTML = machine.output.length ? machine.output.map((v) => `<span class="chip">${v}</span>`).join('') : '<span class="empty">nothing printed yet</span>';
    $('#input-values').closest('.field').classList.toggle('attention', waiting);

    renderStatus(waiting);
    renderExplain(rec, waiting);
    renderTrace();

    const locked = state.practice;
    $('#btn-back').disabled = state.history.length === 0;
    $('#btn-micro').disabled = machine.halted || locked;
    $('#btn-instr').disabled = machine.halted || locked;
    $('#btn-run').disabled = (machine.halted && !state.running) || locked;
    $('#btn-run').textContent = state.running ? 'Pause ❚❚' : 'Run ▶▶▶';
  }

  function setTitle(el, text) {
    let t = el.querySelector(':scope > title');
    if (!t) {
      t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      el.prepend(t);
    }
    t.textContent = text;
  }

  function nextStepText() {
    const n = machine.nextMicro;
    return n ? `Next: ${n.phase} · ${VN.microText(n.op, n.param)}` : '';
  }

  function renderStatus(waiting) {
    let st = '<b>Ready</b>';
    if (state.running) st = '<span class="state-run">Running</span>';
    else if (machine.halted) st = '<span class="state-halted">Halted</span>';
    else if (waiting) st = '<span class="state-wait">Waiting for input</span>';
    else if (machine.stepCount) st = '<b>Paused</b>';
    $('#status').innerHTML = `<span>State: ${st}</span><span>Instructions done: <b>${machine.instructionCount}</b></span><span>Steps: <b>${machine.stepCount}</b></span><span>${esc(nextStepText())}</span>`;
  }

  function renderExplain(rec, waiting) {
    const box = $('#explain');
    if (state.demo) {
      renderDemo(box);
      return;
    }
    if (state.practice) {
      box.className = 'explain ph-PRACTICE';
      if (state.practiceView === 'result' && state.practiceResult) {
        box.innerHTML = practiceResultHtml();
        box.dataset.view = 'result';
        const nb = $('#btn-next-predict');
        if (nb)
          nb.onclick = () => {
            state.practiceView = 'form';
            render();
          };
        return;
      }
      if (box.dataset.view === 'form' && box.dataset.pc === String(machine.pc) && box.dataset.steps === String(machine.stepCount) && box.dataset.fmt === state.format) return; // keep typed answers
      box.innerHTML = practiceFormHtml();
      Object.assign(box.dataset, { view: 'form', pc: String(machine.pc), steps: String(machine.stepCount), fmt: state.format });
      const check = $('#btn-check');
      if (check) {
        check.onclick = () => checkPredict(false);
        $('#btn-reveal').onclick = () => checkPredict(true);
        box.querySelectorAll('input').forEach((inp) => inp.addEventListener('keydown', (e) => e.key === 'Enter' && checkPredict(false)));
      }
      return;
    }
    box.dataset.view = '';

    let html;
    if (waiting) {
      box.className = 'explain ph-WAIT';
      html = `<div class="head"><span class="badge WAIT">WAITING FOR INPUT</span><span class="rtl">${esc(state.lastRec.rtl)}</span></div>
        <p>${richText(state.lastRec.text)}</p>`;
    } else if (!rec) {
      box.className = 'explain';
      html = `<div class="head"><span class="badge READY">READY</span></div>
        <p>The program is in memory and all registers are 0. Because PC = 0, the first instruction will be taken from memory cell 0.</p>
        <p>Every instruction is done in three phases: <b style="color:var(--fetch)">fetch</b> (bring the instruction from memory),
        <b style="color:var(--decode)">decode</b> (find out what it means) and <b style="color:var(--execute)">execute</b> (do it).</p>
        <p>Press <b>Next step</b> to do one step and see which parts of the computer take part (they light up in yellow),
        or <b>Next instruction</b> to do all steps of one instruction.</p>
        <p class="next">${esc(nextStepText())}</p>`;
    } else {
      box.className = `explain ph-${rec.phase}`;
      const ports = (list) =>
        list.length
          ? list.map((p) => `<span class="port"><span>${esc(p.label)}:</span> ${p.kind === 'text' || p.kind === 'bit' ? `<b>${esc(p.value)}</b>` : valSpan(p.value, p.kind)}</span>`).join('')
          : '<span class="port"><span>—</span></span>';
      const ioRows = (rec.ioTable || [])
        .map((row) => `<tr><td>${partDot(row.component)}${esc(COMPONENT_NAMES[row.component] || row.component)}</td><td>${ports(row.inputs)}</td><td>${ports(row.outputs)}</td></tr>`)
        .join('');
      html = `<div class="head"><span class="badge ${rec.phase}">${rec.phase}</span><span class="rtl">${esc(rec.rtl)}</span>
          <span class="next">step ${rec.step}${rec.instructionDone ? ' · instruction finished' : ''}</span></div>
        <p>${richText(rec.text)}</p>
        <table class="io-table"><thead><tr><th>Part</th><th>Gets (input)</th><th>Gives (output)</th></tr></thead><tbody>${ioRows}</tbody></table>
        <p class="next">${esc(nextStepText())}</p>`;
    }
    box.innerHTML = html;
  }

  function traceCells(t) {
    const r = t.rec;
    const g = r.registers;
    const chg = r.changes;
    const cell = (key, kind) => ({ text: fmt(g[key], kind), chg: key in chg });
    let extra = r.memWrites.map((w) => `cell ${fmtAddr(w.addr)} = ${fmtWord(w.to)}`).join(', ');
    if (r.io === 'IN') extra = `input ${r.registers.mdr}`;
    if (r.io === 'OUT') extra = `output ${r.registers.mdr}`;
    return [
      { text: String(r.step) },
      { text: String(t.instrNo) },
      { text: r.phase, cls: `ph-${r.phase}` },
      { text: r.rtl },
      cell('pc', 'addr'),
      cell('mar', 'addr'),
      cell('mdr', 'word'),
      cell('ir', 'word'),
      cell('r', 'word'),
      { text: String(g.gt), chg: 'gt' in chg },
      { text: String(g.eq), chg: 'eq' in chg },
      { text: String(g.lt), chg: 'lt' in chg },
      { text: extra },
    ];
  }

  const visibleTrace = () => ($('#trace-instr-only').checked ? state.trace.filter((t) => t.rec.instructionDone) : state.trace);

  function renderTrace() {
    const rows = visibleTrace();
    const shown = rows.slice(-TRACE_VISIBLE);
    $('#trace-table tbody').innerHTML = shown
      .map((t) => `<tr class="${t.rec.instructionDone ? 'instr-end' : ''}">${traceCells(t).map((c) => `<td class="${c.cls || ''}${c.chg ? ' chg' : ''}">${esc(c.text)}</td>`).join('')}</tr>`)
      .join('');
    const wrap = $('.trace-wrap');
    wrap.scrollTop = wrap.scrollHeight;
    const hidden = rows.length - shown.length + state.traceOffset;
    $('#trace-note').textContent =
      (rows.length ? 'Values are after each step. Red = changed by that step. ' : 'The steps you run appear here. ') +
      (hidden > 0 ? `Showing the last ${shown.length} rows; Export CSV has all of them.` : '');
  }

  function exportCsv() {
    const head = ['step', 'instruction', 'phase', 'micro-operation', 'PC', 'MAR', 'MDR', 'IR', 'R', 'GT', 'EQ', 'LT', 'memory / I/O'];
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = [head.map(q).join(',')].concat(visibleTrace().map((t) => traceCells(t).map((c) => q(c.text)).join(',')));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' }));
    a.download = 'trace.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function loadExample(id) {
    const ex = EXAMPLES.find((e) => e.id === id);
    if (!ex) return;
    $('#asm-src').value = ex.source;
    $('#input-values').value = ex.input;
    loadProgram();
  }

  // ------------------------------------------------------------------------------------------------ guided demo
  // Short walkthroughs on the real diagram; students move through them with Next / Previous. They choose one of two demos:
  //   - "add":  the "a = b + c" example, the first instruction step by step, then the others one at a time;
  //   - "loop": 1 + 2 + 3 + 4 + 5 with a loop (5 iterations), the first iteration instruction by instruction,
  //             then one whole iteration at a time, then the exit from the loop.
  // The choice appears by itself on the first visit; "Watch demo" brings it back.
  const DEMO_SEEN_KEY = 'ceng111-demo-seen';
  const PHASE_WORD = { FETCH: 'Fetch', DECODE: 'Decode', EXECUTE: 'Execute' };

  function demoFrames(kind) {
    if (kind === 'loop') return loopDemoFrames();
    const frames = [
      {
        title: 'Welcome! This is a tiny computer.',
        text: 'On the left is the <b>CPU</b> (processor), on the right the <b>memory</b>. They are connected by <b>buses</b>, the thick lines that carry addresses and data. In this demo the computer runs a very small program while you watch.',
      },
      {
        title: 'The program is already in memory',
        text: 'The program computes <b>a = b + c</b> and prints a. Cells 0–4 hold the <b>instructions</b> (LOAD, ADD, STORE, OUT, HALT) and cells 5–7 hold the <b>numbers</b> a = 0, b = 5, c = 7. Instructions and numbers are stored in the same memory: this is the Von Neumann idea. Each instruction is done in three phases: <b>fetch</b>, <b>decode</b>, <b>execute</b>.',
      },
    ];
    for (let k = 1; k <= 8; k++) frames.push({ action: 'micro', firstInstr: true, k });
    for (let n = 2; n <= 5; n++) frames.push({ action: 'instr', n });
    frames.push({
      tag: 'Finished',
      title: 'Your turn!',
      text: 'The machine printed <b>12</b> (5 + 7) and stopped at HALT. Now try it yourself: press <b>⟲ Reset</b>, then <b>Next step</b>, and read the explanation under the picture at every step. Parts that take part in a step light up in yellow. When you are ready, turn on <b>Practice mode</b> to test yourself.',
    });
    return frames;
  }

  // The loop demo: SUM (cell 9) = 1 + 2 + 3 + 4 + 5, I (cell 10) counts 1 … 6, LIMIT (cell 11) = 6.
  const LOOP_DEMO = { sum: 9, i: 10, limit: 11, loopStart: 0, exitAt: 7, bodyLength: 7, iterations: 5 };
  const LOOP_NOTES = [
    'This is the start of the loop body (address 0000). R gets the running total SUM.',
    'R becomes SUM + I.',
    'The new total goes back into SUM: <b>the memory changes</b>.',
    'I goes up by one: the next number to add.',
    'R gets I, so that it can be compared with LIMIT.',
    'COMPARE sets the condition codes: GT = 1 means LIMIT &gt; I, so there are more numbers to add.',
    'GT is 1, so JUMPGT puts 0000 into PC: the next instruction is the first one of the loop again. <b>This jump backwards is what makes a loop.</b>',
  ];

  function loopDemoFrames() {
    const frames = [
      {
        title: 'A loop: 1 + 2 + 3 + 4 + 5',
        text: 'This program adds the numbers 1 to 5 and prints the sum. Cells 0–8 hold the <b>instructions</b>; cell 9 is <b>SUM</b> (the running total, starts at 0), cell 10 is <b>I</b> (the number to add, starts at 1) and cell 11 is <b>LIMIT</b> (6).',
      },
      {
        title: 'The same instructions, again and again',
        text: 'Instructions 0–6 are the <b>loop body</b>. At the end of the body, <b>JUMPGT</b> sends the machine back to address 0000 as long as LIMIT &gt; I. So the body runs <b>5 times</b> (I = 1, 2, 3, 4, 5). Watch PC: it goes 0, 1, 2, … 6, and then back to 0.',
      },
    ];
    for (let n = 1; n <= LOOP_DEMO.bodyLength; n++) frames.push({ action: 'instr', loop: true, n });
    for (let k = 2; k <= LOOP_DEMO.iterations; k++) frames.push({ action: 'iter', k });
    frames.push({ action: 'instr', loop: true, n: 8 });
    frames.push({ action: 'instr', loop: true, n: 9 });
    frames.push({
      tag: 'Finished',
      title: 'Your turn!',
      text: 'The loop body ran 5 times (5 × 7 = 35 instructions), then OUT and HALT: <b>37 instructions</b> in total, and the machine printed <b>15</b>. Try it yourself: choose example 8 in <b>Examples</b>, press <b>⟲ Reset</b> and step through it. A good exercise: what are SUM and I after 3 iterations? Turn on <b>Practice mode</b> to check your predictions.',
    });
    return frames;
  }

  /** Runs one whole iteration of the loop demo: until PC is back at the loop start, or leaves the loop. */
  function runIteration() {
    const recs = [];
    for (let guard = 0; guard < 50; guard++) {
      const r = doInstruction();
      if (!r.length) break;
      recs.push(...r);
      if (machine.halted || machine.pc === LOOP_DEMO.loopStart || machine.pc === LOOP_DEMO.exitAt) break;
    }
    return recs;
  }

  // First the choice between the two demos, then the chosen one.
  function startDemo(auto) {
    stopRun();
    if (state.practice) setPractice(false);
    const restore = auto ? null : { src: $('#asm-src').value, input: $('#input-values').value };
    state.demo = { choosing: true, frames: [], i: -1, restore };
    document.body.classList.add('demo');
    $('.machine').scrollIntoView({ behavior: 'smooth', block: 'start' });
    render();
  }

  function runDemo(kind) {
    const d = state.demo;
    if (!d) return;
    Object.assign(d, { choosing: false, kind, frames: demoFrames(kind), i: -1 });
    loadExample(kind === 'loop' ? 'loop' : 'add');
    nextDemoFrame();
  }

  /** Does what a frame shows on the machine (one step, one instruction or one loop iteration). */
  function applyDemoFrame(f) {
    if (f.action === 'micro') {
      doMicroStep();
      f.rec = state.lastRec;
    } else if (f.action === 'instr') {
      f.recs = doInstruction();
    } else if (f.action === 'iter') {
      f.recs = runIteration();
    }
  }

  /** Goes back one frame: reloads the program and replays the frames before it. */
  function prevDemoFrame() {
    const d = state.demo;
    if (!d || d.choosing || d.i <= 0) return;
    const target = d.i - 1;
    loadExample(d.kind === 'loop' ? 'loop' : 'add');
    for (let k = 0; k <= target; k++) applyDemoFrame(d.frames[k]);
    d.i = target;
    render();
  }

  function nextDemoFrame() {
    const d = state.demo;
    if (!d || d.choosing || d.i >= d.frames.length - 1) return;
    d.i += 1;
    applyDemoFrame(d.frames[d.i]);
    render();
  }

  function endDemo() {
    const d = state.demo;
    if (!d) return;
    state.demo = null;
    document.body.classList.remove('demo');
    try {
      localStorage.setItem(DEMO_SEEN_KEY, '1');
    } catch {
      /* ignore */
    }
    if (d.restore && d.restore.src) {
      $('#asm-src').value = d.restore.src;
      $('#input-values').value = d.restore.input;
      loadProgram();
    } else resetMachine();
  }

  function demoCaption(f) {
    if (f.action === 'micro') {
      const r = f.rec;
      return {
        tag: `First instruction · step ${f.k} of 8 · ${PHASE_WORD[r.phase]}`,
        title: `<span class="demo-rtl">${esc(r.rtl.replace(/\s+\(.*\)$/, ''))}</span>`,
        text: richText(r.text),
      };
    }
    if (f.action === 'instr' && f.loop) {
      const last = f.recs[f.recs.length - 1];
      const name = VN.disassemble(machine.ir);
      const note = f.n <= LOOP_DEMO.bodyLength ? LOOP_NOTES[f.n - 1] : f.n === 8 ? 'The loop is over, so the program continues after it: the sum is printed.' : 'The machine stops.';
      const ins = VN.INSTRUCTIONS[VN.opcodeOf(machine.ir)];
      const x = VN.addressOf(machine.ir);
      const label = { 0: 'LOOP', 9: 'SUM', 10: 'I', 11: 'LIMIT' }[x];
      return {
        tag: f.n <= LOOP_DEMO.bodyLength ? `Iteration 1 · instruction ${f.n} of ${LOOP_DEMO.bodyLength}` : 'After the loop',
        title: ins.noOperand || !label ? esc(name) : `${esc(ins.name)} ${label} <small>(cell ${x})</small>`,
        text: `${note} <span class="demo-rtl">${esc(last.rtl.replace(/\s+\(.*\)$/, ''))}</span><br>${richText(last.text)}`,
      };
    }
    if (f.action === 'iter') {
      const m = machine.mem;
      const left = machine.pc === LOOP_DEMO.exitAt;
      return {
        tag: `Iteration ${f.k} of ${LOOP_DEMO.iterations} · ${LOOP_DEMO.bodyLength} instructions at once`,
        title: `Iteration ${f.k}: SUM = ${m[LOOP_DEMO.sum]}, I = ${m[LOOP_DEMO.i]}`,
        text: left
          ? `The same 7 instructions ran again: SUM became <b>${m[LOOP_DEMO.sum]}</b> and I became <b>${m[LOOP_DEMO.i]}</b>. But now I = LIMIT = ${m[LOOP_DEMO.limit]}, so COMPARE gives GT = 0 and EQ = 1. <b>JUMPGT does not jump</b>: PC simply goes on to 0111, and the loop ends.`
          : `The same 7 instructions ran again (addresses 0000–0110): SUM became <b>${m[LOOP_DEMO.sum]}</b> and I became <b>${m[LOOP_DEMO.i]}</b>. LIMIT (${m[LOOP_DEMO.limit]}) is still greater than I, so GT = 1 and JUMPGT sent PC back to <b>0000</b> for another iteration.`,
      };
    }
    if (f.action === 'instr') {
      const last = f.recs[f.recs.length - 1];
      const name = VN.disassemble(machine.ir);
      return {
        tag: `Instruction ${f.n} of 5 · all its steps at once`,
        title: `${esc(name)}`,
        text: `Fetch brings <b>${esc(name)}</b> from memory into IR, decode finds out what it means, and execute does it. The last step: <span class="demo-rtl">${esc(last.rtl.replace(/\s+\(.*\)$/, ''))}</span><br>${richText(last.text)}`,
      };
    }
    return { tag: f.tag || 'Introduction', title: f.title, text: f.text };
  }

  function renderDemo(box) {
    const d = state.demo;
    if (d.choosing) {
      box.className = 'explain ph-DEMO';
      box.dataset.view = 'demo';
      box.innerHTML = `<div class="demo-card">
      <div class="demo-top"><span class="demo-tag">▶ DEMO · Choose a demo</span></div>
      <h3>Watch the machine run a program</h3>
      <p>Pick a demo. Move through it at your own pace with <b>Next ▶</b> and <b>◀ Previous</b> (or the ← → arrow keys); every step has an explanation.</p>
      <div class="demo-choices">
        <button id="demo-add" class="demo-choice"><b>1. a = b + c</b><span>One instruction step by step (fetch, decode, execute), then the rest of a 5-instruction program. 15 steps.</span></button>
        <button id="demo-loop" class="demo-choice"><b>2. A loop: 1 + 2 + 3 + 4 + 5</b><span>The same instructions run 5 times; JUMPGT jumps back until the loop ends. 16 steps.</span></button>
      </div>
      <div class="btn-row"><button id="demo-close">✕ Skip demo</button></div>
    </div>`;
      box.querySelector('#demo-add').onclick = () => runDemo('add');
      box.querySelector('#demo-loop').onclick = () => runDemo('loop');
      box.querySelector('#demo-close').onclick = endDemo;
      return;
    }
    const f = d.frames[Math.max(0, d.i)];
    const c = demoCaption(f);
    const last = d.i >= d.frames.length - 1;
    box.className = 'explain ph-DEMO';
    box.dataset.view = 'demo';
    box.innerHTML = `<div class="demo-card">
      <div class="demo-top"><span class="demo-tag">▶ DEMO · ${esc(c.tag)}</span><span class="next">${d.i + 1} / ${d.frames.length}</span></div>
      <h3>${c.title}</h3>
      <p>${c.text}</p>
      <div class="demo-progress"><span style="width:${Math.round(((d.i + 1) / d.frames.length) * 100)}%"></span></div>
      <div class="btn-row">
        ${last ? `<button id="demo-prev">◀ Previous</button><button id="demo-close" class="primary">Start working ▶</button><button id="demo-other">▶ Watch the ${d.kind === 'loop' ? 'a = b + c' : 'loop'} demo</button>` : `<button id="demo-prev"${d.i <= 0 ? ' disabled' : ''}>◀ Previous</button><button id="demo-next" class="primary">Next ▶</button><button id="demo-close">✕ Skip demo</button>`}
      </div>
    </div>`;
    const on = (id, fn) => {
      const b = box.querySelector(id);
      if (b) b.onclick = fn;
    };
    on('#demo-close', endDemo);
    on('#demo-other', () => runDemo(d.kind === 'loop' ? 'add' : 'loop'));
    on('#demo-next', nextDemoFrame);
    on('#demo-prev', prevDemoFrame);
  }

  // ------------------------------------------------------------------------------------------------ events

  function wire() {
    const act = (fn) => () => {
      stopRun();
      fn();
      render();
    };
    $('#btn-micro').onclick = act(doMicroStep);
    $('#btn-instr').onclick = act(doInstruction);
    $('#btn-back').onclick = act(() => {
      stepBack();
      if (state.practice) {
        while (!machine.atInstructionBoundary && state.history.length) stepBack(); // back to an instruction start
        state.practiceView = 'form';
      }
    });
    $('#btn-reset').onclick = act(resetMachine);
    $('#btn-run').onclick = () => {
      if (state.running) {
        stopRun();
        render();
      } else startRun();
    };
    $('#btn-practice').onclick = () => setPractice(!state.practice);
    $('#btn-theme').onclick = toggleTheme;
    $('#btn-demo').onclick = () => startDemo(false);

    $$('input[name="format"]').forEach(
      (r) =>
        (r.onchange = () => {
          state.format = r.value;
          saveStore();
          render();
        }),
    );
    $('#examples').onchange = (e) => {
      loadExample(e.target.value);
      e.target.value = '';
    };
    $('#btn-csv').onclick = exportCsv;
    $('#trace-instr-only').onchange = renderTrace;

    // The program is put into memory automatically, shortly after the user stops typing.
    let loadTimer;
    $('#asm-src').addEventListener('input', () => {
      clearTimeout(loadTimer);
      setMsg($('#asm-msg'), 'Typing…', '');
      loadTimer = setTimeout(loadProgram, 600);
    });
    $('#asm-src').addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        document.execCommand('insertText', false, '\t');
      }
    });
    let saveTimer;
    $('#input-values').addEventListener('input', () => {
      applyInputField();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveStore, 400);
      render();
    });
    $('#input-values').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && state.lastRec && state.lastRec.blocked && !state.practice) {
        doMicroStep();
        render();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (state.demo) {
        if (e.key === 'Escape') endDemo();
        else if (e.key === 'ArrowRight') nextDemoFrame();
        else if (e.key === 'ArrowLeft') prevDemoFrame();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target.closest('input, textarea, select, [contenteditable]')) return;
      if (e.target.closest('button') && (e.key === ' ' || e.key === 'Enter')) return; // native button activation
      const k = e.key.toLowerCase();
      if (k === 's') $('#btn-micro').click();
      else if (k === 'i') $('#btn-instr').click();
      else if (k === 'b') $('#btn-back').click();
      else if (k === 'r') $('#btn-reset').click();
      else if (k === ' ') {
        e.preventDefault();
        $('#btn-run').click();
      }
    });
  }

  // ------------------------------------------------------------------------------------------------ start

  function init() {
    buildStatic();
    wire();
    showThemeButton();
    const saved = loadStore();
    if (saved.format === 'dec' || saved.format === 'bin') {
      state.format = saved.format;
      $(`input[name="format"][value="${saved.format}"]`).checked = true;
    }
    let seen = false;
    try {
      seen = localStorage.getItem(DEMO_SEEN_KEY) === '1';
    } catch {
      /* ignore */
    }
    if (!seen) {
      startDemo(true); // first visit: show the guided demo before the student starts
      return;
    }
    if (saved.asm) {
      $('#asm-src').value = saved.asm;
      $('#input-values').value = saved.input || '';
      if (loadProgram()) return;
      render();
      return;
    }
    loadExample(EXAMPLES[0].id);
  }

  init();
})();
