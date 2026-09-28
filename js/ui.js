/* Von Neumann Machine Simulator: browser UI. Depends on VNCore (core.js) and VNExamples (examples.js). */
(function () {
  'use strict';

  const VN = window.VNCore;
  const EXAMPLES = window.VNExamples;
  const $ = (sel) => document.querySelector(sel);

  const SPEEDS = [
    { label: '0.5 step/s', ms: 2000 },
    { label: '1 step/s', ms: 1000 },
    { label: '3 steps/s', ms: 333 },
    { label: '10 steps/s', ms: 100 },
    { label: '50 steps/s', ms: 20 },
    { label: 'max', ms: 0 },
  ];
  const HISTORY_LIMIT = 20000;
  const TRACE_LIMIT = 50000;
  const TRACE_VISIBLE = 300;
  const STORE_KEY = 'ceng111-simulation:v1';

  const OP_RTL = {
    FETCH_MAR: 'MAR ← PC',
    FETCH_READ: 'MDR ← M[MAR], PC ← PC + 1',
    FETCH_IR: 'IR ← MDR',
    DECODE: 'decode IR',
    EXEC_MAR_IR: 'MAR ← IR[address]',
    EXEC_READ: 'MDR ← M[MAR]',
    EXEC_AC_MDR: 'AC ← MDR',
    EXEC_MDR_AC: 'MDR ← AC',
    EXEC_WRITE: 'M[MAR] ← MDR',
    EXEC_ADD: 'AC ← AC + MDR',
    EXEC_SUB: 'AC ← AC − MDR',
    EXEC_JMP: 'PC ← IR[address]',
    EXEC_JZ: 'if Z = 1: PC ← IR[address]',
    EXEC_JN: 'if N = 1: PC ← IR[address]',
    EXEC_HALT: 'halt',
  };
  // Micro-ops whose internal-bus value is an address (shown with 5 bits).
  const ADDR_BUS_OPS = new Set(['FETCH_MAR', 'EXEC_MAR_IR', 'EXEC_JMP', 'EXEC_JZ', 'EXEC_JN']);
  const COMPONENTS = ['CU', 'PC', 'IR', 'MAR', 'MDR', 'AC', 'ALU', 'FLAGS', 'IN', 'OUT'];
  const WIRES = ['bus-ctrl', 'bus-addr', 'bus-data', 'bus-io', 'bus-internal', 'w-ir-cu', 'w-ir-bus', 'w-pc-bus', 'w-mar-bus', 'w-mdr-bus', 'w-ac-bus', 'w-bus-alu', 'w-ac-alu', 'w-alu-ac'];
  const PREDICT_FIELDS = [
    { key: 'pc', label: 'PC', kind: 'addr' },
    { key: 'ir', label: 'IR', kind: 'word' },
    { key: 'mar', label: 'MAR', kind: 'addr' },
    { key: 'mdr', label: 'MDR', kind: 'word' },
    { key: 'ac', label: 'AC', kind: 'word' },
  ];

  const machine = new VN.Machine();
  const state = {
    format: 'bin',
    loadedWords: new Array(VN.MEM_SIZE).fill(0),
    loadedFrom: 'asm', // 'asm' | 'bin' | 'file' | 'edit'
    history: [], // [{ snap, traceLen, lastRec }]
    trace: [],
    traceOffset: 0, // number of trace rows dropped from the front (TRACE_LIMIT)
    lastRec: null,
    running: false,
    timer: null,
    breakpoints: new Set(),
    explainMode: 'step', // 'step' | 'predict' | 'predict-result'
    predictResult: null,
    predictStats: { answered: 0, perfect: 0 },
  };

  // ------------------------------------------------------------------------------------------------ formatting

  function fmtWord(v) {
    switch (state.format) {
      case 'dec': return String(v);
      case 'sdec': return String(VN.toSigned(v));
      case 'hex': return '0x' + v.toString(16).toUpperCase().padStart(2, '0');
      default: return VN.toBin(v, VN.WORD_BITS);
    }
  }
  function fmtAddr(v) {
    switch (state.format) {
      case 'dec':
      case 'sdec': return String(v);
      case 'hex': return '0x' + v.toString(16).toUpperCase().padStart(2, '0');
      default: return VN.toBin(v, VN.ADDR_BITS);
    }
  }
  function fmt(value, kind) {
    if (kind === 'word') return fmtWord(value);
    if (kind === 'addr') return fmtAddr(value);
    if (kind === 'opcode') return VN.toBin(value, VN.OPCODE_BITS);
    return String(value);
  }
  function allForms(v, kind) {
    const bits = kind === 'addr' ? VN.ADDR_BITS : VN.WORD_BITS;
    const parts = [`bin ${VN.toBin(v, bits)}`, `dec ${v}`];
    if (kind === 'word') parts.push(`signed ${VN.toSigned(v)}`, `as instruction: ${VN.disassemble(v)}`);
    parts.push(`hex 0x${v.toString(16).toUpperCase()}`);
    return parts.join(' · ');
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  function valSpan(v, kind) {
    return `<span class="v" title="${esc(allForms(v, kind))}">${esc(fmt(v, kind))}</span>`;
  }
  function richText(text) {
    return esc(text).replace(/\{([wa]):(\d+)\}/g, (_, k, n) => valSpan(Number(n), k === 'w' ? 'word' : 'addr'));
  }
  /** Parses a value typed by a student, in the current number format unless it has a 0b/0x/0d prefix. */
  function parseUserValue(text, kind) {
    const t = text.trim().replace(/[\s_]/g, '');
    if (!t) return null;
    let v = null;
    const pref = /^0([bxd])(.+)$/i.exec(t);
    if (pref) {
      const base = { b: 2, x: 16, d: 10 }[pref[1].toLowerCase()];
      const ok = { 2: /^[01]+$/, 16: /^[0-9a-f]+$/i, 10: /^-?\d+$/ }[base].test(pref[2]);
      v = ok ? parseInt(pref[2], base) : null;
    } else if (state.format === 'bin') v = /^[01]+$/.test(t) ? parseInt(t, 2) : null;
    else if (state.format === 'hex') v = /^[0-9a-f]+$/i.test(t) ? parseInt(t, 16) : null;
    else v = /^-?\d+$/.test(t) ? parseInt(t, 10) : null;
    if (v === null) return null;
    const max = kind === 'addr' ? VN.ADDR_MASK : VN.WORD_MASK;
    if (v < 0 && kind === 'word' && v >= -128) v &= VN.WORD_MASK;
    return v >= 0 && v <= max ? v : null;
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
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ asm: $('#asm-src').value, bin: $('#bin-src').value, input: $('#input-values').value, format: state.format }),
      );
    } catch {
      /* storage unavailable (private mode): ignore */
    }
  }
  function b64encode(str) {
    let bin = '';
    new TextEncoder().encode(str).forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64decode(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
  }
  function setMsg(el, text, kind) {
    el.textContent = text;
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  // ------------------------------------------------------------------------------------------------ program loading

  function loadProgram(words, from) {
    state.loadedWords = words.slice(0, VN.MEM_SIZE);
    while (state.loadedWords.length < VN.MEM_SIZE) state.loadedWords.push(0);
    state.loadedFrom = from;
    resetMachine();
  }

  function assembleAndLoad() {
    const asm = VN.assemble($('#asm-src').value);
    if (asm.errors.length) {
      setMsg($('#asm-msg'), asm.errors.map((e) => `Line ${e.line}: ${e.message}`).join('\n'), 'error');
      return false;
    }
    loadProgram(asm.words, 'asm');
    $('#bin-src').value = VN.formatBinary(asm.words);
    const last = asm.listing.length ? asm.listing[asm.listing.length - 1].addr : 0;
    setMsg($('#asm-msg'), `Assembled ${asm.listing.length} words into cells 0–${last} and loaded them into memory.`, 'ok');
    saveStore();
    return true;
  }

  function loadBinaryText(text, from) {
    const r = VN.parseBinary(text);
    if (r.errors.length) {
      setMsg($('#asm-msg'), r.errors.map((e) => `Line ${e.line}: ${e.message}`).join('\n'), 'error');
      return false;
    }
    if (!r.count) {
      setMsg($('#asm-msg'), 'No binary words found. Write one 8-bit word per line, e.g. 00101110.', 'error');
      return false;
    }
    loadProgram(r.words, from);
    setMsg($('#asm-msg'), `Loaded ${r.count} binary words into memory.`, 'ok');
    saveStore();
    return true;
  }

  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      const isText = bytes.every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 0xc2);
      if (!isText) {
        // A real binary file: every byte is one memory word.
        if (bytes.length > VN.MEM_SIZE) toast(`File has ${bytes.length} bytes; only the first ${VN.MEM_SIZE} are loaded.`);
        const words = Array.from(bytes.slice(0, VN.MEM_SIZE));
        loadProgram(words, 'file');
        $('#bin-src').value = VN.formatBinary(state.loadedWords);
        showTab('bin');
        setMsg($('#asm-msg'), `Loaded ${words.length} bytes from ${file.name} (raw binary file).`, 'ok');
        return;
      }
      const text = new TextDecoder().decode(bytes);
      const bin = VN.parseBinary(text);
      if (!bin.errors.length && bin.count) {
        $('#bin-src').value = text;
        showTab('bin');
        loadBinaryText(text, 'file');
      } else {
        $('#asm-src').value = text;
        showTab('asm');
        assembleAndLoad();
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function applyInputField() {
    const r = VN.parseValueList($('#input-values').value);
    setMsg($('#input-msg'), r.errors.join('\n'), r.errors.length ? 'error' : '');
    machine.setInput(r.values);
    return r;
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
    state.explainMode = 'step';
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
    state.trace.push({ rec, instrNo, output: machine.output.length });
    if (state.trace.length > TRACE_LIMIT) {
      state.trace.shift();
      state.traceOffset += 1;
    }
    state.lastRec = rec;
    return true;
  }

  function doInstruction() {
    while (doMicroStep()) if (state.lastRec.instructionDone) break;
  }

  function stepBack() {
    const h = state.history.pop();
    if (!h) return;
    machine.restore(h.snap);
    applyInputField();
    // Trace rows may have been dropped from the front since; keep what is still there.
    const drop = state.traceOffset - h.traceOffset;
    state.trace.length = Math.max(0, h.traceLen - drop);
    state.lastRec = h.lastRec;
  }

  function startRun() {
    if (machine.halted) return;
    state.running = true;
    state.explainMode = 'step';
    let first = true;
    const tick = () => {
      if (!state.running) return;
      const speed = SPEEDS[$('#speed').value];
      const batch = speed.ms === 0 ? 400 : 1;
      for (let i = 0; i < batch; i++) {
        if (!first && machine.atInstructionBoundary && state.breakpoints.has(machine.pc)) {
          stopRun();
          toast(`Breakpoint: stopped before the instruction at address ${machine.pc}.`);
          break;
        }
        first = false;
        if (!doMicroStep()) {
          stopRun();
          break;
        }
      }
      render();
      if (state.running) state.timer = setTimeout(tick, speed.ms);
    };
    tick();
  }
  function stopRun() {
    state.running = false;
    clearTimeout(state.timer);
  }

  // ------------------------------------------------------------------------------------------------ predict mode

  function openPredict() {
    state.explainMode = 'predict';
    const fields = PREDICT_FIELDS.map(
      (f) => `<label>${f.label}<input type="text" data-key="${f.key}" autocomplete="off" spellcheck="false" placeholder="${esc(fmt(0, f.kind))}"></label>`,
    ).join('');
    $('#explain').innerHTML = `
      <div class="predict">
        <h3>Predict: what will the registers hold after the next instruction completes?</h3>
        <p class="next">The next instruction is at address ${valSpan(machine.pc, 'addr')}. Look at that memory cell, work through fetch, decode and execute on paper, then type your answers in the current number format (${esc($('#format').selectedOptions[0].text)}). You can also use a prefix: 0b101, 0x1F, 0d12.</p>
        <div class="predict-grid">${fields}</div>
        <div class="btn-row">
          <button id="btn-check" class="primary">Check &amp; run instruction</button>
          <button id="btn-skip">Skip (just run it)</button>
          <span class="score">${scoreText()}</span>
        </div>
        <div id="predict-msg" class="msg"></div>
      </div>`;
    $('#explain input').focus();
    $('#btn-check').onclick = checkPredict;
    $('#btn-skip').onclick = () => {
      state.explainMode = 'step';
      doInstruction();
      render();
    };
    $('#explain').querySelectorAll('input').forEach((inp) =>
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') checkPredict();
      }),
    );
  }

  function scoreText() {
    const s = state.predictStats;
    return s.answered ? `Fully correct: ${s.perfect} / ${s.answered} instructions` : '';
  }

  function checkPredict() {
    const sim = machine.clone();
    const recs = sim.stepInstruction();
    if (recs.length && recs[recs.length - 1].blocked) {
      setMsg($('#predict-msg'), 'This instruction reads input, but the Input box is empty. Add an input value first.', 'error');
      return;
    }
    const rows = PREDICT_FIELDS.map((f) => {
      const raw = $(`#explain input[data-key="${f.key}"]`).value;
      const guess = parseUserValue(raw, f.kind);
      return { ...f, raw, guess, correct: sim[f.key], ok: guess === sim[f.key] };
    });
    state.predictStats.answered += 1;
    if (rows.every((r) => r.ok)) state.predictStats.perfect += 1;
    doInstruction();
    state.predictResult = rows;
    state.explainMode = 'predict-result';
    render();
  }

  function predictResultHtml() {
    const rows = state.predictResult
      .map(
        (r) => `<tr><td>${r.label}</td><td class="mono">${r.raw ? esc(r.raw) : '<i>empty</i>'}${r.raw && r.guess === null ? ' (not a valid value)' : ''}</td>
          <td>${valSpan(r.correct, r.kind)}</td><td class="${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓' : '✗'}</td></tr>`,
      )
      .join('');
    const all = state.predictResult.every((r) => r.ok);
    return `<div class="predict">
      <h3>${all ? 'All correct!' : 'Check the red rows, then read the step explanations in the trace below.'}</h3>
      <table class="io-table predict-result"><thead><tr><th>Register</th><th>Your answer</th><th>Correct</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <p class="score">${scoreText()} · Press <b>Instruction ▶▶</b> to predict the next one.</p></div>`;
  }

  // ------------------------------------------------------------------------------------------------ rendering

  function buildStatic() {
    // Memory rows inside the SVG: two columns of 16.
    const g = $('#mem-rows');
    const ns = 'http://www.w3.org/2000/svg';
    for (let i = 0; i < VN.MEM_SIZE; i++) {
      const col = Math.floor(i / 16);
      const x = 640 + col * 105;
      const y = 44 + (i % 16) * 19;
      const row = document.createElementNS(ns, 'g');
      row.setAttribute('class', 'mrow');
      row.id = `m-${i}`;
      row.innerHTML = `<rect x="${x}" y="${y}" width="100" height="18" rx="3"></rect>
        <text class="maddr" x="${x + 20}" y="${y + 13}">${i}</text>
        <text class="mval" x="${x + 27}" y="${y + 13}"></text>`;
      g.appendChild(row);
    }

    // Memory table.
    const tbody = $('#mem-table tbody');
    for (let i = 0; i < VN.MEM_SIZE; i++) {
      const tr = document.createElement('tr');
      tr.id = `mt-${i}`;
      if (i === VN.IN_ADDR || i === VN.OUT_ADDR) tr.classList.add('io');
      tr.innerHTML = `<td class="addr" title="Click to toggle a breakpoint"></td>
        <td><input type="text" maxlength="12" aria-label="Contents of cell ${i}" spellcheck="false"></td>
        <td class="num"></td><td class="dis"></td>`;
      tr.querySelector('.addr').addEventListener('click', () => {
        if (state.breakpoints.has(i)) state.breakpoints.delete(i);
        else state.breakpoints.add(i);
        render();
      });
      const inp = tr.querySelector('input');
      inp.addEventListener('change', () => {
        const v = parseUserValue(inp.value, 'word');
        if (v === null) {
          inp.classList.add('invalid');
          toast(`Cell ${i}: not a valid 8-bit value.`);
          return;
        }
        inp.classList.remove('invalid');
        machine.mem[i] = v;
        state.loadedWords[i] = v;
        state.loadedFrom = 'edit';
        render();
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') inp.blur();
      });
      tbody.appendChild(tr);
    }

    // Instruction set reference.
    $('#isa-table tbody').innerHTML = VN.INSTRUCTIONS.map(
      (ins) => `<tr><td>${VN.toBin(ins.opcode, VN.OPCODE_BITS)}</td><td>${ins.mnemonic}${ins.operand ? ' a' : ''}</td>
        <td>${esc(ins.summary)}<br><code>${esc(ins.rtl)}</code></td>
        <td>${VN.EXEC_PLANS[ins.mnemonic].map((op) => esc(OP_RTL[op])).join('<br>')}</td></tr>`,
    ).join('');

    // Examples menu.
    $('#examples').innerHTML += EXAMPLES.map((ex) => `<option value="${ex.id}">${esc(ex.title)}</option>`).join('');
  }

  function render() {
    const rec = state.lastRec && !state.lastRec.blocked ? state.lastRec : null;
    const waiting = !!(state.lastRec && state.lastRec.blocked);
    const changes = (rec && rec.changes) || {};

    // Registers.
    const regs = { PC: [machine.pc, 'addr', 'pc'], IR: [machine.ir, 'word', 'ir'], MAR: [machine.mar, 'addr', 'mar'], MDR: [machine.mdr, 'word', 'mdr'], AC: [machine.ac, 'word', 'ac'] };
    for (const [name, [v, kind, key]] of Object.entries(regs)) {
      const el = $(`#v-${name}`);
      el.textContent = fmt(v, kind);
      el.classList.toggle('changed', key in changes);
      setTitle(el.parentNode, `${name} = ${allForms(v, kind)}`);
    }
    $('#v-FLAGS').textContent = `Z=${machine.z ? 1 : 0}  N=${machine.n ? 1 : 0}`;
    $('#v-FLAGS').classList.toggle('changed', 'z' in changes || 'n' in changes);
    $('#v-ALU').textContent = rec && (rec.op === 'EXEC_ADD' || rec.op === 'EXEC_SUB') ? rec.op.slice(5) : '';

    // Control unit.
    const phase = machine.halted ? 'HALTED' : rec ? rec.phase : 'READY';
    const cuPhase = $('#cu-phase');
    cuPhase.textContent = waiting ? 'Waiting for input' : phase === 'READY' ? 'Ready' : phase === 'HALTED' ? 'Halted' : `Phase: ${phase}`;
    cuPhase.setAttribute('class', `cu-line strong phase-${waiting ? 'HALTED' : phase}`);
    const d = machine.decoded;
    $('#cu-instr').textContent = d ? `Instruction: ${VN.disassemble(machine.ir)}  (${VN.toBin(d.opcode, VN.OPCODE_BITS)} ${VN.toBin(d.operand, VN.ADDR_BITS)})` : 'Instruction: (not decoded yet)';
    $('#cu-rtl').textContent = rec ? rec.rtl : '';
    $('#cu-clock').textContent = `clock step ${machine.stepCount} · instructions done ${machine.instructionCount}`;

    // Active components, wires, buses.
    const active = new Set((state.lastRec && state.lastRec.active) || (waiting ? ['CU', 'IN'] : []));
    for (const c of COMPONENTS) $(`#c-${c}`).classList.toggle('active', active.has(c));
    const wires = new Set((rec && rec.wires) || []);
    for (const w of WIRES) $(`#${w}`).classList.toggle('active', wires.has(w));
    const bus = (rec && rec.bus) || {};
    $('#t-bus-internal').textContent = bus.internal !== undefined ? fmt(bus.internal, ADDR_BUS_OPS.has(rec.op) ? 'addr' : 'word') : '';
    $('#t-bus-addr').textContent = bus.address !== undefined ? fmtAddr(bus.address) : '';
    $('#t-bus-data').textContent = bus.data !== undefined ? fmtWord(bus.data) : '';
    $('#t-bus-ctrl').textContent = bus.control || '';

    // Memory (diagram + table).
    const written = new Set(((rec && rec.memWrites) || []).map((w) => w.addr));
    for (let i = 0; i < VN.MEM_SIZE; i++) {
      const v = machine.mem[i];
      const isPc = i === machine.pc && !machine.halted;
      const isAccess = bus.address === i;
      const row = $(`#m-${i}`);
      row.querySelector('.mval').textContent = fmtWord(v);
      row.setAttribute('class', `mrow${isPc ? ' pc' : ''}${isAccess ? ' access' : ''}${written.has(i) ? ' written' : ''}`);
      setTitle(row, `cell ${i}: ${allForms(v, 'word')}`);

      const tr = $(`#mt-${i}`);
      tr.classList.toggle('pc', isPc);
      tr.classList.toggle('access', isAccess);
      tr.classList.toggle('bp', state.breakpoints.has(i));
      tr.querySelector('.addr').innerHTML = `${fmtAddr(i)}${state.format === 'bin' ? ` <small>(${i})</small>` : ''}`;
      const inp = tr.querySelector('input');
      if (document.activeElement !== inp) {
        inp.value = fmtWord(v);
        inp.classList.remove('invalid');
      }
      tr.querySelector('.num').textContent = state.format === 'dec' ? String(VN.toSigned(v)) : String(v);
      tr.querySelector('.dis').textContent =
        i === VN.IN_ADDR ? 'input port' : i === VN.OUT_ADDR ? 'output port' : VN.disassemble(v) + (isPc ? ' ◀PC' : '');
    }

    // I/O.
    const nextIn = machine.input[machine.inputPos];
    $('#v-IN').textContent = nextIn === undefined ? '(empty)' : `next: ${fmtWord(nextIn)}`;
    const lastOut = machine.output[machine.output.length - 1];
    $('#v-OUT').textContent = lastOut === undefined ? '—' : fmtWord(lastOut);
    $('#input-chips').innerHTML = machine.input.length
      ? machine.input
          .map((v, i) => `<span class="chip${i < machine.inputPos ? ' used' : i === machine.inputPos ? ' next' : ''}" title="${esc(allForms(v, 'word'))}">${esc(fmtWord(v))}</span>`)
          .join('')
      : '<span class="empty">no input values</span>';
    $('#output-list').innerHTML = machine.output.length
      ? machine.output.map((v) => `<span class="chip" title="${esc(allForms(v, 'word'))}">${esc(fmtWord(v))}</span>`).join('')
      : '<span class="empty">nothing printed yet</span>';
    $('#input-values').closest('.field').classList.toggle('attention', waiting);

    renderStatus(waiting);
    renderExplain(rec, waiting);
    renderTrace();

    $('#btn-back').disabled = state.history.length === 0;
    $('#btn-micro').disabled = machine.halted;
    $('#btn-instr').disabled = machine.halted;
    $('#btn-run').disabled = machine.halted && !state.running;
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
    if (machine.halted) return '';
    const q = machine.queue[0];
    const op = q ? q.op : 'FETCH_MAR';
    return `Next step: ${q ? q.phase : 'FETCH'} · ${OP_RTL[op]}`;
  }

  function renderStatus(waiting) {
    let st = '<span>State: <b>Ready</b></span>';
    if (state.running) st = '<span>State: <span class="state-run">Running</span></span>';
    else if (machine.halted) st = '<span>State: <span class="state-halted">Halted</span></span>';
    else if (waiting) st = '<span>State: <span class="state-wait">Waiting for input</span></span>';
    else if (machine.stepCount) st = '<span>State: <b>Paused</b></span>';
    $('#status').innerHTML = `${st}<span>Instructions done: <b>${machine.instructionCount}</b></span><span>Clock steps: <b>${machine.stepCount}</b></span><span>${esc(nextStepText())}</span>`;
  }

  function renderExplain(rec, waiting) {
    const box = $('#explain');
    if (state.explainMode === 'predict') return; // form is live; do not overwrite what the student typed
    let html = '';
    if (state.explainMode === 'predict-result' && state.predictResult) html += predictResultHtml();

    if (waiting) {
      html += `<div class="head"><span class="badge WAIT">WAITING FOR INPUT</span><span class="rtl">${esc(state.lastRec.rtl)}</span></div>
        <p>${richText(state.lastRec.text)}</p>`;
    } else if (!rec) {
      html += `<div class="head"><span class="badge READY">READY</span></div>
        <p>The program is in memory and every register is 0, so the first instruction is fetched from address 0.
        Press <b>Micro-step</b> to execute one clock step (one micro-operation) and see which components and buses take part,
        or <b>Instruction</b> to run a whole fetch–decode–execute cycle.</p>
        <p class="next">${esc(nextStepText())}</p>`;
    } else {
      const ioRows = (rec.ioTable || [])
        .map((row) => {
          const ports = (list) =>
            list.length ? list.map((p) => `<span class="port"><span>${esc(p.label)}:</span> ${p.kind === 'text' ? `<b>${esc(p.value)}</b>` : valSpan(p.value, p.kind === 'bit' ? 'text' : p.kind)}</span>`).join('') : '<span class="port"><span>(none)</span></span>';
          return `<tr><td>${esc(componentName(row.component))}</td><td>${ports(row.inputs)}</td><td>${ports(row.outputs)}</td></tr>`;
        })
        .join('');
      html += `<div class="head"><span class="badge ${rec.phase}">${rec.phase}</span><span class="rtl">${esc(rec.rtl)}</span>
          <span class="next">clock step ${rec.step}${rec.instructionDone ? ' · instruction complete' : ''}</span></div>
        <p>${richText(rec.text)}</p>
        <table class="io-table"><thead><tr><th>Component</th><th>Inputs</th><th>Outputs</th></tr></thead><tbody>${ioRows}</tbody></table>
        <p class="next">${esc(nextStepText())}</p>`;
    }
    box.innerHTML = html;
  }

  function componentName(c) {
    return { CU: 'Control unit', MEM: 'Memory', FLAGS: 'Flags', IN: 'Input device', OUT: 'Output device' }[c] || c;
  }

  function traceCells(t) {
    const r = t.rec;
    const g = r.registers;
    const chg = r.changes;
    const cell = (key, v, kind) => ({ text: fmt(v, kind), chg: key in chg });
    let extra = r.memWrites.map((w) => (w.addr === VN.OUT_ADDR ? `OUT ${fmtWord(w.to)}` : `M[${fmtAddr(w.addr)}] ← ${fmtWord(w.to)}`)).join(', ');
    if (r.io === 'IN') extra = `IN ${fmtWord(r.bus.data)}`;
    if (r.io === 'OUT') extra = `OUT ${fmtWord(r.bus.data)}`;
    return [
      { text: String(r.step) },
      { text: String(t.instrNo) },
      { text: r.phase, cls: `ph-${r.phase}` },
      { text: r.rtl },
      cell('pc', g.pc, 'addr'),
      cell('mar', g.mar, 'addr'),
      cell('mdr', g.mdr, 'word'),
      cell('ir', g.ir, 'word'),
      cell('ac', g.ac, 'word'),
      { text: g.z ? '1' : '0', chg: 'z' in chg },
      { text: g.n ? '1' : '0', chg: 'n' in chg },
      { text: extra },
    ];
  }

  function visibleTrace() {
    return $('#trace-instr-only').checked ? state.trace.filter((t) => t.rec.instructionDone) : state.trace;
  }

  function renderTrace() {
    const rows = visibleTrace();
    const shown = rows.slice(-TRACE_VISIBLE);
    $('#trace-table tbody').innerHTML = shown
      .map((t) => {
        const cells = traceCells(t)
          .map((c) => `<td class="${c.cls || ''}${c.chg ? ' chg' : ''}">${esc(c.text)}</td>`)
          .join('');
        return `<tr class="${t.rec.instructionDone ? 'instr-end' : ''}">${cells}</tr>`;
      })
      .join('');
    const wrap = $('.trace-wrap');
    wrap.scrollTop = wrap.scrollHeight;
    const hidden = rows.length - shown.length + state.traceOffset;
    $('#trace-note').textContent =
      (rows.length ? 'Values are after the step; red = changed by that step. ' : 'Steps you execute appear here. ') +
      (hidden > 0 ? `Showing the last ${shown.length} rows; Export CSV has all ${rows.length}.` : '');
  }

  function exportCsv() {
    const head = ['step', 'instruction', 'phase', 'micro-operation', 'PC', 'MAR', 'MDR', 'IR', 'AC', 'Z', 'N', 'memory write / output'];
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = [head.map(q).join(',')].concat(visibleTrace().map((t) => traceCells(t).map((c) => q(c.text)).join(',')));
    download('trace.csv', lines.join('\r\n'), 'text/csv');
  }

  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function showTab(name) {
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    });
    $('#tab-asm').classList.toggle('hidden', name !== 'asm');
    $('#tab-bin').classList.toggle('hidden', name !== 'bin');
  }

  function loadExample(id) {
    const ex = EXAMPLES.find((e) => e.id === id);
    if (!ex) return;
    $('#asm-src').value = ex.source;
    $('#input-values').value = ex.input;
    showTab('asm');
    assembleAndLoad();
  }

  function shareLink() {
    const params = new URLSearchParams();
    if (state.loadedFrom === 'asm') params.set('src', b64encode($('#asm-src').value));
    else params.set('mem', state.loadedWords.map((w) => w.toString(16).padStart(2, '0')).join(''));
    if ($('#input-values').value.trim()) params.set('in', $('#input-values').value.trim());
    const url = `${location.href.split('#')[0]}#${params}`;
    const done = () => toast('Link copied. Anyone who opens it gets this program.');
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => prompt('Copy this link:', url));
    else prompt('Copy this link:', url);
  }

  function loadFromHash() {
    if (!location.hash || location.hash.length < 2) return false;
    try {
      const p = new URLSearchParams(location.hash.slice(1));
      if (p.has('in')) $('#input-values').value = p.get('in');
      if (p.has('src')) {
        $('#asm-src').value = b64decode(p.get('src'));
        return assembleAndLoad();
      }
      if (p.has('mem')) {
        const hex = p.get('mem');
        const words = [];
        for (let i = 0; i + 1 < hex.length && words.length < VN.MEM_SIZE; i += 2) words.push(parseInt(hex.slice(i, i + 2), 16) || 0);
        loadProgram(words, 'bin');
        $('#bin-src').value = VN.formatBinary(state.loadedWords);
        showTab('bin');
        return true;
      }
    } catch {
      toast('The link could not be read; loading the default program.');
    }
    return false;
  }

  // ------------------------------------------------------------------------------------------------ events

  function wire() {
    const act = (fn) => () => {
      stopRun();
      state.explainMode = 'step';
      fn();
      render();
    };
    $('#btn-micro').onclick = act(doMicroStep);
    $('#btn-instr').onclick = () => {
      stopRun();
      if ($('#predict-toggle').checked && !machine.halted && machine.atInstructionBoundary && state.explainMode !== 'predict') {
        openPredict();
        return;
      }
      state.explainMode = 'step';
      doInstruction();
      render();
    };
    $('#btn-back').onclick = act(stepBack);
    $('#btn-reset').onclick = act(resetMachine);
    $('#btn-run').onclick = () => {
      if (state.running) {
        stopRun();
        render();
      } else startRun();
    };
    $('#speed').oninput = () => ($('#speed-label').textContent = SPEEDS[$('#speed').value].label);
    $('#speed').oninput();
    $('#predict-toggle').onchange = () => {
      if (!$('#predict-toggle').checked && state.explainMode === 'predict') state.explainMode = 'step';
      render();
      if ($('#predict-toggle').checked) toast('Predict mode on: press Instruction ▶▶ to predict the next instruction.');
    };

    $('#format').onchange = () => {
      state.format = $('#format').value;
      saveStore();
      if (state.explainMode === 'predict') state.explainMode = 'step';
      render();
    };
    document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));
    $('#btn-assemble').onclick = assembleAndLoad;
    $('#btn-load-bin').onclick = () => loadBinaryText($('#bin-src').value, 'bin');
    $('#btn-from-mem').onclick = () => ($('#bin-src').value = VN.formatBinary(machine.mem));
    $('#examples').onchange = (e) => {
      loadExample(e.target.value);
      e.target.value = '';
    };
    $('#file-input').onchange = (e) => {
      if (e.target.files[0]) loadFile(e.target.files[0]);
      e.target.value = '';
    };
    $('#btn-download').onclick = () => download('program.txt', VN.formatBinary(state.loadedWords) + '\n', 'text/plain');
    $('#btn-share').onclick = shareLink;
    $('#btn-csv').onclick = exportCsv;
    $('#trace-instr-only').onchange = renderTrace;

    let saveTimer;
    const deferSave = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveStore, 400);
    };
    $('#asm-src').addEventListener('input', deferSave);
    $('#bin-src').addEventListener('input', deferSave);
    $('#asm-src').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) assembleAndLoad();
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        document.execCommand('insertText', false, '\t');
      }
    });
    $('#input-values').addEventListener('input', () => {
      applyInputField();
      deferSave();
      render();
    });
    $('#input-values').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && state.lastRec && state.lastRec.blocked) {
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
      } else return;
    });
  }

  // ------------------------------------------------------------------------------------------------ start

  function init() {
    buildStatic();
    wire();
    const saved = loadStore();
    if (saved.format) {
      state.format = saved.format;
      $('#format').value = saved.format;
    }
    if (loadFromHash()) return;
    if (saved.asm) {
      $('#asm-src').value = saved.asm;
      $('#bin-src').value = saved.bin || '';
      $('#input-values').value = saved.input || '';
      if (assembleAndLoad()) return;
      render();
      return;
    }
    loadExample(EXAMPLES[0].id);
  }

  init();
})();
