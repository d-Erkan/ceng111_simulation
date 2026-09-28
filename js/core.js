/*
 * Von Neumann Machine Simulator: core (ISA, machine, assembler, binary loader).
 *
 * Pure logic, no DOM. Works in the browser (window.VNCore) and in Node (require) so it can be unit-tested.
 *
 * The machine: 8-bit words, 32 memory cells, one accumulator (AC).
 * Instruction word = 3-bit opcode + 5-bit address field:   ooo aaaaa
 * I/O is memory-mapped: reading cell 30 takes the next input value, writing cell 31 prints a value.
 *
 * To change the instruction set (e.g. to match the lecture notes), edit INSTRUCTIONS and EXEC_PLANS below.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VNCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WORD_BITS = 8;
  const OPCODE_BITS = 3;
  const ADDR_BITS = 5;
  const MEM_SIZE = 1 << ADDR_BITS; // 32 cells
  const WORD_MASK = (1 << WORD_BITS) - 1;
  const ADDR_MASK = MEM_SIZE - 1;
  const SIGN_BIT = 1 << (WORD_BITS - 1);
  const IN_ADDR = MEM_SIZE - 2; // 30
  const OUT_ADDR = MEM_SIZE - 1; // 31

  const INSTRUCTIONS = [
    { opcode: 0b000, mnemonic: 'HLT', operand: false, rtl: 'stop', summary: 'Halt: stop the machine.' },
    { opcode: 0b001, mnemonic: 'LDA', operand: true, rtl: 'AC ← M[a]', summary: 'Load: copy memory cell a into AC.' },
    { opcode: 0b010, mnemonic: 'STA', operand: true, rtl: 'M[a] ← AC', summary: 'Store: copy AC into memory cell a.' },
    { opcode: 0b011, mnemonic: 'ADD', operand: true, rtl: 'AC ← AC + M[a]', summary: 'Add memory cell a to AC.' },
    { opcode: 0b100, mnemonic: 'SUB', operand: true, rtl: 'AC ← AC − M[a]', summary: 'Subtract memory cell a from AC.' },
    { opcode: 0b101, mnemonic: 'JMP', operand: true, rtl: 'PC ← a', summary: 'Jump: continue execution at address a.' },
    { opcode: 0b110, mnemonic: 'JZ', operand: true, rtl: 'if AC = 0: PC ← a', summary: 'Jump to a if AC is zero (Z = 1).' },
    { opcode: 0b111, mnemonic: 'JN', operand: true, rtl: 'if AC < 0: PC ← a', summary: 'Jump to a if AC is negative (N = 1, leftmost bit of AC is 1).' },
  ];
  const BY_MNEMONIC = Object.fromEntries(INSTRUCTIONS.map((i) => [i.mnemonic, i]));

  // Micro-operations run in the EXECUTE phase of each instruction (after the shared FETCH + DECODE).
  const EXEC_PLANS = {
    HLT: ['EXEC_HALT'],
    LDA: ['EXEC_MAR_IR', 'EXEC_READ', 'EXEC_AC_MDR'],
    STA: ['EXEC_MAR_IR', 'EXEC_MDR_AC', 'EXEC_WRITE'],
    ADD: ['EXEC_MAR_IR', 'EXEC_READ', 'EXEC_ADD'],
    SUB: ['EXEC_MAR_IR', 'EXEC_READ', 'EXEC_SUB'],
    JMP: ['EXEC_JMP'],
    JZ: ['EXEC_JZ'],
    JN: ['EXEC_JN'],
  };
  const FETCH_PLAN = ['FETCH_MAR', 'FETCH_READ', 'FETCH_IR'];

  // ---------------------------------------------------------------------------------------------------------------
  // Helpers

  function toBin(value, bits) {
    return (value >>> 0).toString(2).padStart(bits, '0').slice(-bits);
  }
  function toSigned(word) {
    return word & SIGN_BIT ? word - (1 << WORD_BITS) : word;
  }
  function opcodeOf(word) {
    return (word >> ADDR_BITS) & ((1 << OPCODE_BITS) - 1);
  }
  function operandOf(word) {
    return word & ADDR_MASK;
  }
  function encode(opcode, operand) {
    return ((opcode << ADDR_BITS) | (operand & ADDR_MASK)) & WORD_MASK;
  }
  function disassemble(word) {
    const ins = INSTRUCTIONS[opcodeOf(word)];
    return ins.operand ? `${ins.mnemonic} ${operandOf(word)}` : ins.mnemonic;
  }
  /** Parses 42, -3, 0b101, 0x2A. Returns null if the text is not a number. */
  function parseNumber(text) {
    const m = /^([+-]?)(?:0b([01]+)|0x([0-9a-f]+)|(\d+))$/i.exec(String(text).trim());
    if (!m) return null;
    let v;
    if (m[2] !== undefined) v = parseInt(m[2], 2);
    else if (m[3] !== undefined) v = parseInt(m[3], 16);
    else v = parseInt(m[4], 10);
    return m[1] === '-' ? -v : v;
  }
  /** Parses "12, -3 0x10" into word values. Returns { values, errors }. */
  function parseValueList(text) {
    const values = [];
    const errors = [];
    for (const tok of String(text).split(/[\s,;]+/).filter(Boolean)) {
      const v = parseNumber(tok);
      if (v === null || v < -(1 << (WORD_BITS - 1)) || v > WORD_MASK) errors.push(`"${tok}" is not a value between −128 and 255`);
      else values.push(v & WORD_MASK);
    }
    return { values, errors };
  }

  // Tokens embedded in explanation texts; the UI renders them in the selected number format.
  const W = (v) => `{w:${v}}`; // 8-bit word
  const A = (v) => `{a:${v}}`; // 5-bit address
  const port = (label, value, kind) => ({ label, value, kind }); // kind: 'word' | 'addr' | 'bit' | 'opcode' | 'text'

  // ---------------------------------------------------------------------------------------------------------------
  // Machine

  class Machine {
    constructor() {
      this.mem = new Array(MEM_SIZE).fill(0);
      this.input = [];
      this.reset();
    }

    /** CPU reset: clears registers, output and input position. Memory is kept. */
    reset() {
      this.pc = 0;
      this.mar = 0;
      this.mdr = 0;
      this.ir = 0;
      this.ac = 0;
      this.z = true;
      this.n = false;
      this.halted = false;
      this.queue = []; // pending micro-ops of the current instruction: [{ op, phase }]
      this.decoded = null; // { opcode, operand, mnemonic } once DECODE has run
      this.output = [];
      this.inputPos = 0;
      this.instructionCount = 0;
      this.stepCount = 0;
    }

    load(words) {
      this.mem = new Array(MEM_SIZE).fill(0);
      words.slice(0, MEM_SIZE).forEach((w, i) => (this.mem[i] = w & WORD_MASK));
      this.reset();
    }

    setInput(values) {
      this.input = values.map((v) => v & WORD_MASK);
    }

    get atInstructionBoundary() {
      return this.queue.length === 0;
    }

    /** Name of the phase the next micro-step belongs to. */
    get nextPhase() {
      if (this.halted) return 'HALTED';
      return this.queue.length ? this.queue[0].phase : 'FETCH';
    }

    registers() {
      return { pc: this.pc, mar: this.mar, mdr: this.mdr, ir: this.ir, ac: this.ac, z: this.z, n: this.n };
    }

    snapshot() {
      return {
        ...this.registers(),
        mem: this.mem.slice(),
        input: this.input.slice(),
        inputPos: this.inputPos,
        output: this.output.slice(),
        halted: this.halted,
        queue: this.queue.map((q) => ({ ...q })),
        decoded: this.decoded && { ...this.decoded },
        instructionCount: this.instructionCount,
        stepCount: this.stepCount,
      };
    }

    restore(s) {
      Object.assign(this, s, {
        mem: s.mem.slice(),
        input: s.input.slice(),
        output: s.output.slice(),
        queue: s.queue.map((q) => ({ ...q })),
        decoded: s.decoded && { ...s.decoded },
      });
    }

    clone() {
      const m = new Machine();
      m.restore(this.snapshot());
      return m;
    }

    setAC(value) {
      this.ac = value & WORD_MASK;
      this.z = this.ac === 0;
      this.n = (this.ac & SIGN_BIT) !== 0;
    }

    /** Memory read through the bus. Returns { value, io } or { blocked: true } when input is needed. */
    busRead(addr) {
      if (addr === IN_ADDR) {
        if (this.inputPos >= this.input.length) return { blocked: true };
        const value = this.input[this.inputPos++];
        this.mem[IN_ADDR] = value;
        return { value, io: 'IN' };
      }
      return { value: this.mem[addr] };
    }

    busWrite(addr, value) {
      this.mem[addr] = value & WORD_MASK;
      if (addr === OUT_ADDR) {
        this.output.push(value & WORD_MASK);
        return { io: 'OUT' };
      }
      return {};
    }

    /**
     * Executes one micro-operation (one clock step) and returns a record describing it, or null when halted.
     * A record with `blocked: 'input'` means nothing happened because the program wants input that is not there yet.
     */
    microStep() {
      if (this.halted) return null;
      if (this.queue.length === 0) {
        this.queue = FETCH_PLAN.map((op) => ({ op, phase: 'FETCH' })).concat({ op: 'DECODE', phase: 'DECODE' });
        this.decoded = null;
      }
      const item = this.queue[0];
      const before = this.registers();
      const memBefore = this.mem.slice();
      const rec = MICRO_OPS[item.op].call(this);
      if (rec.blocked) return rec;

      this.queue.shift();
      this.stepCount += 1;
      const after = this.registers();
      rec.op = item.op;
      rec.phase = item.phase;
      rec.step = this.stepCount;
      rec.changes = {};
      for (const k of Object.keys(after)) if (after[k] !== before[k]) rec.changes[k] = [before[k], after[k]];
      rec.memWrites = [];
      this.mem.forEach((v, i) => {
        if (v !== memBefore[i]) rec.memWrites.push({ addr: i, from: memBefore[i], to: v });
      });
      rec.instructionDone = this.queue.length === 0 || this.halted;
      if (rec.instructionDone) {
        this.queue = [];
        this.instructionCount += 1;
      }
      rec.registers = this.registers();
      return rec;
    }

    /** Runs micro-steps until the current instruction completes. Returns the records. */
    stepInstruction() {
      const records = [];
      do {
        const rec = this.microStep();
        if (!rec) break;
        records.push(rec);
        if (rec.blocked || rec.instructionDone) break;
      } while (!this.halted);
      return records;
    }

    /** Runs until HLT, blocked input, or maxSteps micro-steps. Returns { reason, steps }. */
    run(maxSteps = 10000) {
      let steps = 0;
      while (!this.halted && steps < maxSteps) {
        const rec = this.microStep();
        if (rec.blocked) return { reason: 'input', steps };
        steps += 1;
      }
      return { reason: this.halted ? 'halted' : 'limit', steps };
    }
  }

  // Each micro-op mutates the machine and returns what the UI needs to show:
  //   rtl    register-transfer notation, e.g. "MAR ← PC"
  //   text   plain-language explanation (with {w:..}/{a:..} value tokens)
  //   active components that take part; wires: diagram wires carrying data
  //   bus    values on the buses: { internal, address, data, control }
  //   io     per-component inputs and outputs
  function memoryAccess(m, kind, phase) {
    const addr = m.mar;
    if (kind === 'READ') {
      const r = m.busRead(addr);
      if (r.blocked) {
        return {
          blocked: 'input',
          rtl: 'MDR ← M[MAR]',
          text: `The program reads the input port (address ${A(IN_ADDR)}), but there are no input values left. Add a value in the Input box and step again.`,
        };
      }
      m.mdr = r.value;
      const ioComp = r.io ? [r.io] : [];
      return {
        io: r.io,
        active: ['CU', 'MAR', 'MEM', 'MDR', ...ioComp],
        wires: ['bus-ctrl', 'bus-addr', 'bus-data', ...(r.io ? ['bus-io'] : [])],
        bus: { address: addr, data: r.value, control: 'READ' },
        ioTable: [
          { component: 'CU', inputs: [], outputs: [port('control bus', 'READ', 'text')] },
          { component: 'MAR', inputs: [], outputs: [port('address bus', addr, 'addr')] },
          {
            component: r.io ? 'IN' : 'MEM',
            inputs: [port('address', addr, 'addr'), port('control', 'READ', 'text')],
            outputs: [port('data bus', r.value, 'word')],
          },
          { component: 'MDR', inputs: [port('data bus', r.value, 'word')], outputs: [port('new value', r.value, 'word')] },
        ],
        text: r.io
          ? `${phase}: MAR holds ${A(addr)}, the input port. The control unit sends READ; the input device puts the next input value ${W(r.value)} on the data bus and MDR stores it.`
          : `${phase}: the control unit sends READ on the control bus. MAR puts address ${A(addr)} on the address bus, memory puts the contents of that cell, ${W(r.value)}, on the data bus, and MDR stores it.`,
      };
    }
    const value = m.mdr;
    const w = m.busWrite(addr, value);
    return {
      io: w.io,
      active: ['CU', 'MAR', 'MDR', 'MEM', ...(w.io ? [w.io] : [])],
      wires: ['bus-ctrl', 'bus-addr', 'bus-data', ...(w.io ? ['bus-io'] : [])],
      bus: { address: addr, data: value, control: 'WRITE' },
      ioTable: [
        { component: 'CU', inputs: [], outputs: [port('control bus', 'WRITE', 'text')] },
        { component: 'MAR', inputs: [], outputs: [port('address bus', addr, 'addr')] },
        { component: 'MDR', inputs: [], outputs: [port('data bus', value, 'word')] },
        {
          component: w.io ? 'OUT' : 'MEM',
          inputs: [port('address', addr, 'addr'), port('data', value, 'word'), port('control', 'WRITE', 'text')],
          outputs: w.io ? [port('printed', value, 'word')] : [port(`cell ${addr}`, value, 'word')],
        },
      ],
      text: w.io
        ? `The control unit sends WRITE. MAR holds ${A(addr)}, the output port, so the value in MDR, ${W(value)}, is sent to the output device (printed).`
        : `The control unit sends WRITE on the control bus. MAR puts address ${A(addr)} on the address bus, MDR puts ${W(value)} on the data bus, and memory stores it in cell ${A(addr)}. The old value is overwritten.`,
    };
  }

  function aluOp(m, op) {
    const a = m.ac;
    const b = m.mdr;
    const raw = op === 'ADD' ? a + b : a - b;
    m.setAC(raw);
    const wrapped = raw < 0 || raw > WORD_MASK;
    const sym = op === 'ADD' ? '+' : '−';
    return {
      rtl: `AC ← AC ${sym} MDR`,
      active: ['MDR', 'ALU', 'AC', 'FLAGS', 'CU'],
      wires: ['w-mdr-bus', 'bus-internal', 'w-bus-alu', 'w-ac-alu', 'w-alu-ac'],
      bus: { internal: b },
      ioTable: [
        { component: 'CU', inputs: [], outputs: [port('ALU operation', op, 'text')] },
        { component: 'MDR', inputs: [], outputs: [port('internal bus', b, 'word')] },
        {
          component: 'ALU',
          inputs: [port('A (from AC)', a, 'word'), port('B (from MDR)', b, 'word'), port('operation', op, 'text')],
          outputs: [port('result', m.ac, 'word'), port('Z', m.z ? 1 : 0, 'bit'), port('N', m.n ? 1 : 0, 'bit')],
        },
        { component: 'AC', inputs: [port('ALU result', m.ac, 'word')], outputs: [port('new value', m.ac, 'word')] },
      ],
      text:
        `The control unit tells the ALU to ${op === 'ADD' ? 'add' : 'subtract'}. Input A is AC (${W(a)}), input B is MDR (${W(b)}). ` +
        `The result ${W(m.ac)} goes back into AC.` +
        (wrapped ? ` The true result (${raw}) does not fit in 8 bits, so it wraps around (only the lowest 8 bits are kept).` : '') +
        ` Flags: Z = ${m.z ? 1 : 0} (${m.z ? 'result is zero' : 'result is not zero'}), N = ${m.n ? 1 : 0} (leftmost bit ${m.n ? 'is 1: negative in two’s complement' : 'is 0'}).`,
    };
  }

  function conditionalJump(m, flag) {
    const target = operandOf(m.ir);
    const set = flag === 'Z' ? m.z : m.n;
    const oldPc = m.pc;
    if (set) m.pc = target;
    const meaning = flag === 'Z' ? 'AC is zero' : 'AC is negative';
    return {
      rtl: `if ${flag} = 1: PC ← IR[address]`,
      active: set ? ['CU', 'FLAGS', 'IR', 'PC'] : ['CU', 'FLAGS'],
      wires: set ? ['w-ir-bus', 'bus-internal', 'w-pc-bus'] : [],
      bus: set ? { internal: target } : {},
      ioTable: [
        { component: 'FLAGS', inputs: [], outputs: [port(flag, set ? 1 : 0, 'bit')] },
        {
          component: 'CU',
          inputs: [port(flag, set ? 1 : 0, 'bit')],
          outputs: [port('decision', set ? 'jump' : 'no jump', 'text')],
        },
        set
          ? { component: 'PC', inputs: [port('from IR', target, 'addr')], outputs: [port('new value', target, 'addr')] }
          : { component: 'PC', inputs: [], outputs: [port('unchanged', oldPc, 'addr')] },
      ],
      text: set
        ? `The control unit checks flag ${flag}: it is 1 (${meaning}), so the jump is taken. The address field of IR, ${A(target)}, is copied into PC. The next fetch reads from there.`
        : `The control unit checks flag ${flag}: it is 0 (${meaning.replace('is', 'is not')}), so no jump. PC keeps ${A(oldPc)}, already pointing at the next instruction.`,
    };
  }

  const MICRO_OPS = {
    FETCH_MAR() {
      const pc = this.pc;
      this.mar = pc;
      return {
        rtl: 'MAR ← PC',
        active: ['PC', 'MAR', 'CU'],
        wires: ['w-pc-bus', 'bus-internal', 'w-mar-bus'],
        bus: { internal: pc },
        ioTable: [
          { component: 'PC', inputs: [], outputs: [port('internal bus', pc, 'addr')] },
          { component: 'MAR', inputs: [port('internal bus', pc, 'addr')], outputs: [port('new value', pc, 'addr')] },
        ],
        text: `A new instruction cycle starts. PC holds the address of the next instruction, ${A(pc)}. It is copied into the Memory Address Register (MAR), the only register connected to memory's address lines.`,
      };
    },
    FETCH_READ() {
      const oldPc = this.pc;
      const r = memoryAccess(this, 'READ', 'Fetch');
      if (r.blocked) return r;
      this.pc = (oldPc + 1) & ADDR_MASK;
      r.rtl = 'MDR ← M[MAR],  PC ← PC + 1';
      r.active.push('PC');
      r.ioTable.push({ component: 'PC', inputs: [port('old value', oldPc, 'addr')], outputs: [port('+1', this.pc, 'addr')] });
      r.text += ` At the same time, PC is incremented to ${A(this.pc)} so it points to the next instruction.`;
      return r;
    },
    FETCH_IR() {
      const v = this.mdr;
      this.ir = v;
      return {
        rtl: 'IR ← MDR',
        active: ['MDR', 'IR', 'CU'],
        wires: ['w-mdr-bus', 'bus-internal', 'w-ir-bus'],
        bus: { internal: v },
        ioTable: [
          { component: 'MDR', inputs: [], outputs: [port('internal bus', v, 'word')] },
          { component: 'IR', inputs: [port('internal bus', v, 'word')], outputs: [port('new value', v, 'word')] },
        ],
        text: `The word just read, ${W(v)}, is copied from MDR into the Instruction Register (IR). The fetch phase is over: IR now holds the instruction to be executed.`,
      };
    },
    DECODE() {
      const opcode = opcodeOf(this.ir);
      const operand = operandOf(this.ir);
      const ins = INSTRUCTIONS[opcode];
      this.decoded = { opcode, operand, mnemonic: ins.mnemonic };
      const plan = EXEC_PLANS[ins.mnemonic];
      this.queue.push(...plan.map((op) => ({ op, phase: 'EXECUTE' })));
      return {
        rtl: 'decode IR',
        active: ['IR', 'CU'],
        wires: ['w-ir-cu'],
        bus: {},
        ioTable: [
          { component: 'IR', inputs: [], outputs: [port('instruction', this.ir, 'word')] },
          {
            component: 'CU',
            inputs: [port('instruction', this.ir, 'word')],
            outputs: [
              port('opcode', opcode, 'opcode'),
              port('instruction', ins.mnemonic, 'text'),
              ...(ins.operand ? [port('address field', operand, 'addr')] : []),
            ],
          },
        ],
        text:
          `The control unit splits IR into the opcode (leftmost ${OPCODE_BITS} bits) = ${toBin(opcode, OPCODE_BITS)} and the address field (rightmost ${ADDR_BITS} bits) = ${A(operand)}. ` +
          `Opcode ${toBin(opcode, OPCODE_BITS)} means ${ins.mnemonic}${ins.operand ? ' ' + operand : ''}: ${ins.summary} ` +
          `The execute phase will take ${plan.length} step${plan.length > 1 ? 's' : ''}.`,
      };
    },
    EXEC_MAR_IR() {
      const a = operandOf(this.ir);
      this.mar = a;
      return {
        rtl: 'MAR ← IR[address]',
        active: ['IR', 'MAR', 'CU'],
        wires: ['w-ir-bus', 'bus-internal', 'w-mar-bus'],
        bus: { internal: a },
        ioTable: [
          { component: 'IR', inputs: [], outputs: [port('address field', a, 'addr')] },
          { component: 'MAR', inputs: [port('internal bus', a, 'addr')], outputs: [port('new value', a, 'addr')] },
        ],
        text: `The instruction needs the data in memory cell ${A(a)}, so the address field of IR (its rightmost ${ADDR_BITS} bits) is copied into MAR.`,
      };
    },
    EXEC_READ() {
      const r = memoryAccess(this, 'READ', 'Execute');
      if (r.blocked) return r;
      r.rtl = 'MDR ← M[MAR]';
      return r;
    },
    EXEC_AC_MDR() {
      const v = this.mdr;
      this.setAC(v);
      return {
        rtl: 'AC ← MDR',
        active: ['MDR', 'AC', 'FLAGS', 'CU'],
        wires: ['w-mdr-bus', 'bus-internal', 'w-ac-bus'],
        bus: { internal: v },
        ioTable: [
          { component: 'MDR', inputs: [], outputs: [port('internal bus', v, 'word')] },
          {
            component: 'AC',
            inputs: [port('internal bus', v, 'word')],
            outputs: [port('new value', v, 'word'), port('Z', this.z ? 1 : 0, 'bit'), port('N', this.n ? 1 : 0, 'bit')],
          },
        ],
        text: `The value from memory, ${W(v)}, is copied from MDR into the accumulator (AC). Flags are updated: Z = ${this.z ? 1 : 0}, N = ${this.n ? 1 : 0}.`,
      };
    },
    EXEC_MDR_AC() {
      const v = this.ac;
      this.mdr = v;
      return {
        rtl: 'MDR ← AC',
        active: ['AC', 'MDR', 'CU'],
        wires: ['w-ac-bus', 'bus-internal', 'w-mdr-bus'],
        bus: { internal: v },
        ioTable: [
          { component: 'AC', inputs: [], outputs: [port('internal bus', v, 'word')] },
          { component: 'MDR', inputs: [port('internal bus', v, 'word')], outputs: [port('new value', v, 'word')] },
        ],
        text: `To store AC (${W(v)}) in memory, it is first copied into the Memory Data Register (MDR), the only register connected to memory's data lines.`,
      };
    },
    EXEC_WRITE() {
      const r = memoryAccess(this, 'WRITE', 'Execute');
      r.rtl = 'M[MAR] ← MDR';
      return r;
    },
    EXEC_ADD() {
      return aluOp(this, 'ADD');
    },
    EXEC_SUB() {
      return aluOp(this, 'SUB');
    },
    EXEC_JMP() {
      const a = operandOf(this.ir);
      this.pc = a;
      return {
        rtl: 'PC ← IR[address]',
        active: ['IR', 'PC', 'CU'],
        wires: ['w-ir-bus', 'bus-internal', 'w-pc-bus'],
        bus: { internal: a },
        ioTable: [
          { component: 'IR', inputs: [], outputs: [port('address field', a, 'addr')] },
          { component: 'PC', inputs: [port('internal bus', a, 'addr')], outputs: [port('new value', a, 'addr')] },
        ],
        text: `Jump: the address field of IR, ${A(a)}, is copied into PC. The next fetch reads the instruction at ${A(a)} instead of the next one in sequence.`,
      };
    },
    EXEC_JZ() {
      return conditionalJump(this, 'Z');
    },
    EXEC_JN() {
      return conditionalJump(this, 'N');
    },
    EXEC_HALT() {
      this.halted = true;
      return {
        rtl: 'halt',
        active: ['CU'],
        wires: [],
        bus: {},
        ioTable: [{ component: 'CU', inputs: [port('opcode', 0, 'opcode')], outputs: [port('clock', 'stopped', 'text')] }],
        text: 'HLT: the control unit stops the clock. No more instructions are fetched. Press Reset to run the program again.',
      };
    },
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Assembler

  const PSEUDO = {
    IN: { mnemonic: 'LDA', operand: IN_ADDR, note: `LDA ${IN_ADDR}` },
    OUT: { mnemonic: 'STA', operand: OUT_ADDR, note: `STA ${OUT_ADDR}` },
  };
  const DATA_DIRECTIVES = new Set(['DATA', 'DAT', '.DATA', 'DB', '.BYTE']);
  const RESERVED = new Set([...Object.keys(BY_MNEMONIC), ...Object.keys(PSEUDO), ...DATA_DIRECTIVES, 'ORG']);

  /**
   * Two-pass assembler.
   *   label:  MNEMONIC operand   ; comment
   * operand = number (12, 0b1100, 0xC), label, or label+n / label-n.
   * Directives: DATA v1, v2, ...   ORG address.   Pseudo-instructions: IN (= LDA 30), OUT (= STA 31).
   * Returns { words, errors: [{ line, message }], listing: [{ addr, word, line, source }], symbols }.
   */
  function assemble(source) {
    const errors = [];
    const symbols = {};
    const items = [];
    let loc = 0;
    const err = (line, message) => errors.push({ line, message });

    String(source)
      .split(/\r?\n/)
      .forEach((raw, idx) => {
        const line = idx + 1;
        let text = raw.replace(/(;|\/\/|#).*$/, '').trim();
        let m;
        while ((m = /^([A-Za-z_]\w*)\s*:\s*/.exec(text))) {
          const key = m[1].toLowerCase();
          if (RESERVED.has(m[1].toUpperCase())) err(line, `"${m[1]}" is an instruction name and cannot be a label`);
          else if (key in symbols) err(line, `Label "${m[1]}" is defined twice`);
          else symbols[key] = loc;
          text = text.slice(m[0].length);
        }
        if (!text) return;

        const [head, ...rest] = text.split(/\s+/);
        const mnemonic = head.toUpperCase();
        const args = rest.join(' ').split(/\s*,\s*|\s+/).filter(Boolean);

        if (mnemonic === 'ORG') {
          const v = args.length === 1 ? parseNumber(args[0]) : null;
          if (v === null || v < 0 || v >= MEM_SIZE) err(line, `ORG needs one address between 0 and ${MEM_SIZE - 1}`);
          else loc = v;
          return;
        }
        if (DATA_DIRECTIVES.has(mnemonic)) {
          if (args.length === 0) err(line, `${head} needs at least one value`);
          for (const expr of args) items.push({ kind: 'data', expr, line, addr: loc++, source: raw.trim() });
          return;
        }
        if (PSEUDO[mnemonic]) {
          if (args.length) err(line, `${mnemonic} takes no operand (it means ${PSEUDO[mnemonic].note})`);
          items.push({ kind: 'pseudo', mnemonic, line, addr: loc++, source: raw.trim() });
          return;
        }
        const ins = BY_MNEMONIC[mnemonic];
        if (!ins) {
          err(line, `Unknown instruction "${head}". Valid: ${Object.keys(BY_MNEMONIC).join(', ')}, IN, OUT, DATA, ORG`);
          return;
        }
        if (ins.operand && args.length !== 1) err(line, `${mnemonic} needs exactly one address operand`);
        else if (!ins.operand && args.length) err(line, `${mnemonic} takes no operand`);
        items.push({ kind: 'ins', ins, expr: args[0], line, addr: loc++, source: raw.trim() });
      });

    const resolve = (expr, line) => {
      const lm = /^([A-Za-z_]\w*)([+-]\d+)?$/.exec(expr);
      if (lm) {
        const key = lm[1].toLowerCase();
        if (!(key in symbols)) {
          err(line, `Unknown label "${lm[1]}"`);
          return null;
        }
        return symbols[key] + (lm[2] ? parseInt(lm[2], 10) : 0);
      }
      const v = parseNumber(expr);
      if (v === null) err(line, `"${expr}" is not a number or label`);
      return v;
    };

    const words = new Array(MEM_SIZE).fill(0);
    const owner = new Array(MEM_SIZE).fill(null);
    const listing = [];
    for (const it of items) {
      if (it.addr >= MEM_SIZE) {
        err(it.line, `Program does not fit: memory has only ${MEM_SIZE} cells (0–${MEM_SIZE - 1})`);
        continue;
      }
      if (it.addr === IN_ADDR || it.addr === OUT_ADDR) {
        err(it.line, `Cells ${IN_ADDR} and ${OUT_ADDR} are the I/O ports; the program cannot be placed there`);
        continue;
      }
      if (owner[it.addr] !== null) {
        err(it.line, `Cell ${it.addr} is already used by line ${owner[it.addr]}`);
        continue;
      }
      owner[it.addr] = it.line;
      let word = 0;
      if (it.kind === 'data') {
        const v = resolve(it.expr, it.line);
        if (v !== null && (v < -(1 << (WORD_BITS - 1)) || v > WORD_MASK)) err(it.line, `Value ${v} does not fit in ${WORD_BITS} bits (−128…255)`);
        word = (v ?? 0) & WORD_MASK;
      } else if (it.kind === 'pseudo') {
        const p = PSEUDO[it.mnemonic];
        word = encode(BY_MNEMONIC[p.mnemonic].opcode, p.operand);
      } else {
        let operand = 0;
        if (it.ins.operand && it.expr !== undefined) {
          const v = resolve(it.expr, it.line);
          if (v !== null && (v < 0 || v >= MEM_SIZE)) err(it.line, `Address ${v} is outside memory (0–${MEM_SIZE - 1})`);
          else if (v !== null) operand = v;
        }
        word = encode(it.ins.opcode, operand);
      }
      words[it.addr] = word;
      listing.push({ addr: it.addr, word, line: it.line, source: it.source });
    }
    errors.sort((a, b) => a.line - b.line);
    listing.sort((a, b) => a.addr - b.addr);
    return { words, errors, listing, symbols };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Binary program loader / exporter

  /**
   * One 8-bit word per line, loaded from address 0 upwards. Spaces inside a word are ignored ("001 01110").
   * An optional address prefix places a word elsewhere: "01110: 00000101" (5 binary digits) or "14: 00000101".
   * Comments start with ; or #.
   */
  function parseBinary(text) {
    const words = new Array(MEM_SIZE).fill(0);
    const errors = [];
    let loc = 0;
    let count = 0;
    String(text)
      .split(/\r?\n/)
      .forEach((raw, idx) => {
        const line = idx + 1;
        let t = raw.replace(/[;#].*$/, '').trim();
        if (!t) return;
        let addr = loc;
        const colon = t.indexOf(':');
        if (colon >= 0) {
          const a = t.slice(0, colon).trim();
          const v = new RegExp(`^[01]{${ADDR_BITS}}$`).test(a) ? parseInt(a, 2) : parseNumber(a);
          if (v === null || v < 0 || v >= MEM_SIZE) {
            errors.push({ line, message: `"${a}" is not a valid address (0–${MEM_SIZE - 1})` });
            return;
          }
          addr = v;
          t = t.slice(colon + 1).trim();
        }
        const bits = t.replace(/[\s_]/g, '');
        if (!new RegExp(`^[01]{${WORD_BITS}}$`).test(bits)) {
          errors.push({ line, message: `"${t}" is not an ${WORD_BITS}-bit binary word (exactly ${WORD_BITS} digits of 0/1)` });
          return;
        }
        if (addr >= MEM_SIZE) {
          errors.push({ line, message: `Program does not fit: memory has only ${MEM_SIZE} cells` });
          return;
        }
        words[addr] = parseInt(bits, 2);
        loc = addr + 1;
        count += 1;
      });
    return { words, errors, count };
  }

  /** Memory image as text: "00000: 001 01110   ; LDA 14". Stops after the last non-zero cell. */
  function formatBinary(words) {
    let last = 0;
    words.forEach((w, i) => {
      if (w) last = i;
    });
    const lines = [];
    for (let i = 0; i <= last; i++) {
      const w = words[i];
      const bits = toBin(w, WORD_BITS);
      lines.push(`${toBin(i, ADDR_BITS)}: ${bits.slice(0, OPCODE_BITS)} ${bits.slice(OPCODE_BITS)}   ; ${disassemble(w).padEnd(7)} | ${w}`);
    }
    return lines.join('\n');
  }

  return {
    WORD_BITS,
    OPCODE_BITS,
    ADDR_BITS,
    MEM_SIZE,
    WORD_MASK,
    ADDR_MASK,
    IN_ADDR,
    OUT_ADDR,
    INSTRUCTIONS,
    BY_MNEMONIC,
    EXEC_PLANS,
    FETCH_PLAN,
    PSEUDO,
    Machine,
    assemble,
    parseBinary,
    formatBinary,
    parseNumber,
    parseValueList,
    toBin,
    toSigned,
    opcodeOf,
    operandOf,
    encode,
    disassemble,
  };
});
