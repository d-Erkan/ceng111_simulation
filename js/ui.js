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
    resetMachine();
    const last = asm.listing.length ? asm.listing[asm.listing.length - 1].addr : 0;
    setMsg($('#asm-msg'), `✓ The program is in memory (cells 0–${last}). Press "Next step" to start.`, 'ok');
    saveStore();
    return true;
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
    // Memory rows inside the diagram: # | Address | Contents | Decimal | As instruction
    const g = $('#mem-rows');
    const ns = 'http://www.w3.org/2000/svg';
    for (let i = 0; i < VN.MEM_SIZE; i++) {
      const y = 57 + i * 22.6;
      const row = document.createElementNS(ns, 'g');
      row.setAttribute('class', 'mrow');
      row.id = `m-${i}`;
      row.innerHTML = `<rect x="650" y="${y}" width="330" height="21" rx="4"></rect>
        <text class="mnum" x="660" y="${y + 15}">${i}</text>
        <text class="maddr" x="684" y="${y + 15}">${VN.toBin(i, VN.ADDR_BITS)}</text>
        <text class="mval" x="752" y="${y + 15}"></text>
        <text class="mdec" x="836" y="${y + 15}"></text>
        <text class="mdis" x="896" y="${y + 15}"></text>
        <text class="pc-mark" x="958" y="${y + 15}"></text>`;
      g.appendChild(row);
    }

    // Memory editor: # | Address | Contents | Decimal | As instruction
    const tbody = $('#mem-table tbody');
    for (let i = 0; i < VN.MEM_SIZE; i++) {
      const tr = document.createElement('tr');
      tr.id = `mt-${i}`;
      tr.innerHTML = `<td class="rownum">${i}</td><td class="addr">${VN.toBin(i, VN.ADDR_BITS)}</td>
        <td><input type="text" maxlength="9" aria-label="Contents of cell ${i}, 8 binary digits" spellcheck="false"></td>
        <td class="num"></td><td class="dis"></td>`;
      const inp = tr.querySelector('input');
      inp.addEventListener('change', () => {
        const v = parseUserValue(inp.value, 'word', 'bin');
        if (v === null || inp.value.replace(/\s/g, '').length !== VN.WORD_BITS) {
          inp.classList.add('invalid');
          toast(`Cell ${i}: type exactly 8 binary digits, e.g. 0011 0101.`);
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
    $('#t-bus-ctrl').textContent = bus.control || '';

    // Memory (diagram + editor). Addresses and contents are always shown in binary, with the decimal value beside.
    const written = new Set(((rec && rec.memWrites) || []).map((w) => w.addr));
    for (let i = 0; i < VN.MEM_SIZE; i++) {
      const v = machine.mem[i];
      const isPc = i === machine.pc && !machine.halted;
      const isAccess = bus.address === i;
      const row = $(`#m-${i}`);
      row.querySelector('.mval').textContent = VN.wordBin(v);
      row.querySelector('.mdec').textContent = String(v);
      row.querySelector('.mdis').textContent = VN.disassemble(v);
      row.querySelector('.pc-mark').textContent = isPc ? '◀ PC' : '';
      row.setAttribute('class', `mrow${isPc ? ' pc' : ''}${isAccess ? ' access' : ''}${written.has(i) ? ' written' : ''}`);
      setTitle(row, `cell ${i}: ${allForms(v, 'word')}`);

      const tr = $(`#mt-${i}`);
      tr.classList.toggle('pc', isPc);
      tr.classList.toggle('access', isAccess);
      const inp = tr.querySelector('input');
      if (document.activeElement !== inp) {
        inp.value = VN.wordBin(v);
        inp.classList.remove('invalid');
      }
      tr.querySelector('.num').textContent = String(v);
      tr.querySelector('.dis').innerHTML = `${esc(VN.disassemble(v))}${isPc ? ' <span class="pc-tag">◀ PC</span>' : ''}`;
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
