/*
 * Von Neumann Machine Simulator: core (instruction set, machine, assembler).
 *
 * Pure logic, no DOM. Works in the browser (window.VNCore) and in Node (require) so it can be unit-tested
 * and reused to generate exam questions and answer keys.
 *
 * The machine follows the course textbook (Schneider & Gersting, "Invitation to Computer Science"):
 *   - 16 memory cells, 8 bits each (address = 4 bits)
 *   - instruction word = 4-bit op code + 4-bit address field:   oooo aaaa
 *   - one register R, condition codes GT / EQ / LT (set by COMPARE)
 *   - registers PC, IR, MAR, MDR
 *   - numbers are unsigned 8-bit binary numbers (0 … 255)
 *
 * To change the instruction set, edit INSTRUCTIONS and EXEC_PLANS below.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VNCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WORD_BITS = 8;
  const OPCODE_BITS = 4;
  const ADDR_BITS = 4;
  const MEM_SIZE = 1 << ADDR_BITS; // 16 cells
  const WORD_MASK = (1 << WORD_BITS) - 1;
  const ADDR_MASK = MEM_SIZE - 1;
  const MIN_VALUE = 0;
  const MAX_VALUE = WORD_MASK; // 255

  // Op codes and meanings as in the textbook's instruction set.
  const INSTRUCTIONS = [
    { opcode: 0, name: 'LOAD', meaning: 'R ← content of X', summary: 'Load register R with the content of memory cell X.' },
    { opcode: 1, name: 'STORE', meaning: 'content of X ← R', summary: 'Store register R into memory cell X.' },
    { opcode: 2, name: 'CLEAR', meaning: 'content of X ← 0', summary: 'Set memory cell X to 0.' },
    { opcode: 3, name: 'ADD', meaning: 'R ← R + content of X', summary: 'Add the content of memory cell X to R.' },
    { opcode: 4, name: 'INCREMENT', meaning: 'content of X ← content of X + 1', summary: 'Add 1 to memory cell X.' },
    { opcode: 5, name: 'SUBTRACT', meaning: 'R ← R − content of X', summary: 'Subtract the content of memory cell X from R.' },
    { opcode: 6, name: 'DECREMENT', meaning: 'content of X ← content of X − 1', summary: 'Subtract 1 from memory cell X.' },
    {
      opcode: 7,
      name: 'COMPARE',
      meaning: 'compare content of X with R',
      summary: 'Set the condition codes: GT = 1 if content of X > R, EQ = 1 if content of X = R, LT = 1 if content of X < R (the other two become 0).',
    },
    { opcode: 8, name: 'JUMP', meaning: 'PC ← X', summary: 'Jump: the next instruction is taken from cell X.' },
    { opcode: 9, name: 'JUMPGT', meaning: 'if GT = 1 then PC ← X', summary: 'Jump to X if the last COMPARE found content of X > R.' },
    { opcode: 10, name: 'JUMPEQ', meaning: 'if EQ = 1 then PC ← X', summary: 'Jump to X if the last COMPARE found them equal.' },
    { opcode: 11, name: 'JUMPLT', meaning: 'if LT = 1 then PC ← X', summary: 'Jump to X if the last COMPARE found content of X < R.' },
    { opcode: 12, name: 'JUMPNEQ', meaning: 'if EQ = 0 then PC ← X', summary: 'Jump to X if the last COMPARE found them different.' },
    { opcode: 13, name: 'IN', meaning: 'content of X ← input', summary: 'Read the next input value into memory cell X.' },
    { opcode: 14, name: 'OUT', meaning: 'output ← content of X', summary: 'Print the content of memory cell X.' },
    { opcode: 15, name: 'HALT', meaning: 'stop', summary: 'Stop the machine. (The address field is not used.)', noOperand: true },
  ];
  const BY_NAME = Object.fromEntries(INSTRUCTIONS.map((i) => [i.name, i]));

  // Micro-operations of the EXECUTE phase. Each entry is [microOp, parameter].
  const EXEC_PLANS = {
    LOAD: [['ADDR_TO_MAR'], ['FETCH'], ['MDR_TO_R']],
    STORE: [['ADDR_TO_MAR'], ['R_TO_MDR'], ['STORE']],
    CLEAR: [['ADDR_TO_MAR'], ['ZERO_TO_MDR'], ['STORE']],
    ADD: [['ADDR_TO_MAR'], ['FETCH'], ['ALU_R', 'ADD']],
    INCREMENT: [['ADDR_TO_MAR'], ['FETCH'], ['ALU_MDR', 'INC'], ['STORE']],
    SUBTRACT: [['ADDR_TO_MAR'], ['FETCH'], ['ALU_R', 'SUB']],
    DECREMENT: [['ADDR_TO_MAR'], ['FETCH'], ['ALU_MDR', 'DEC'], ['STORE']],
    COMPARE: [['ADDR_TO_MAR'], ['FETCH'], ['ALU_COMPARE']],
    JUMP: [['JUMP']],
    JUMPGT: [['JUMP_IF', 'GT']],
    JUMPEQ: [['JUMP_IF', 'EQ']],
    JUMPLT: [['JUMP_IF', 'LT']],
    JUMPNEQ: [['JUMP_IF', 'NEQ']],
    IN: [['ADDR_TO_MAR'], ['INPUT_TO_MDR'], ['STORE']],
    OUT: [['ADDR_TO_MAR'], ['FETCH'], ['MDR_TO_OUTPUT']],
    HALT: [['HALT']],
  };
  const FETCH_PLAN = [['PC_TO_MAR'], ['FETCH'], ['MDR_TO_IR'], ['PC_INC']];

  /** Short register-transfer text of a micro-operation, written right to left: "destination ← source". */
  function microText(op, param) {
    switch (op) {
      case 'PC_TO_MAR': return 'MAR ← PC';
      case 'FETCH': return 'MDR ← content of cell MAR   (fetch)';
      case 'MDR_TO_IR': return 'IR ← MDR';
      case 'PC_INC': return 'PC ← PC + 1';
      case 'DECODE': return 'decode IR';
      case 'ADDR_TO_MAR': return 'MAR ← IR(address)';
      case 'MDR_TO_R': return 'R ← MDR';
      case 'R_TO_MDR': return 'MDR ← R';
      case 'ZERO_TO_MDR': return 'MDR ← 0';
      case 'STORE': return 'content of cell MAR ← MDR   (store)';
      case 'ALU_R': return param === 'ADD' ? 'R ← R + MDR' : 'R ← R − MDR';
      case 'ALU_MDR': return param === 'INC' ? 'MDR ← MDR + 1' : 'MDR ← MDR − 1';
      case 'ALU_COMPARE': return 'GT, EQ, LT ← compare MDR with R';
      case 'JUMP': return 'PC ← IR(address)';
      case 'JUMP_IF': return param === 'NEQ' ? 'if EQ = 0 then PC ← IR(address)' : `if ${param} = 1 then PC ← IR(address)`;
      case 'INPUT_TO_MDR': return 'MDR ← input';
      case 'MDR_TO_OUTPUT': return 'output ← MDR';
      case 'HALT': return 'stop';
      default: return op;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Helpers

  function toBin(value, bits) {
    return (value >>> 0).toString(2).padStart(bits, '0').slice(-bits);
  }
  /** "0011 0101": a word in binary with a space between op code and address field. */
  function wordBin(word) {
    const b = toBin(word, WORD_BITS);
    return `${b.slice(0, OPCODE_BITS)} ${b.slice(OPCODE_BITS)}`;
  }
  function opcodeOf(word) {
    return (word >> ADDR_BITS) & ((1 << OPCODE_BITS) - 1);
  }
  function addressOf(word) {
    return word & ADDR_MASK;
  }
  function encode(opcode, address) {
    return ((opcode << ADDR_BITS) | (address & ADDR_MASK)) & WORD_MASK;
  }
  function disassemble(word) {
    const ins = INSTRUCTIONS[opcodeOf(word)];
    return ins.noOperand ? ins.name : `${ins.name} ${addressOf(word)}`;
  }
  /** Parses 42, -3, 0b101. Returns null if the text is not a number. */
  function parseNumber(text) {
    const m = /^([+-]?)(?:0b([01]+)|(\d+))$/i.exec(String(text).trim());
    if (!m) return null;
    const v = m[2] !== undefined ? parseInt(m[2], 2) : parseInt(m[3], 10);
    return m[1] === '-' ? -v : v;
  }
  /** Parses an input list such as "5, 7, -1". Returns { values (as 8-bit words), errors }. */
  function parseValueList(text) {
    const values = [];
    const errors = [];
    for (const tok of String(text).split(/[\s,;]+/).filter(Boolean)) {
      const v = parseNumber(tok);
      if (v === null || v < MIN_VALUE || v > MAX_VALUE) errors.push(`"${tok}" is not a whole number from ${MIN_VALUE} to ${MAX_VALUE}`);
      else values.push(v & WORD_MASK);
    }
    return { values, errors };
  }

  // Tokens embedded in explanation texts; the UI renders them in the selected number format.
  const W = (v) => `{w:${v}}`; // 8-bit word
  const A = (v) => `{a:${v}}`; // 4-bit address
  const port = (label, value, kind) => ({ label, value, kind }); // kind: 'word' | 'addr' | 'bit' | 'opcode' | 'text'

  // ---------------------------------------------------------------------------------------------------------------
  // Machine

  class Machine {
    constructor() {
      this.mem = new Array(MEM_SIZE).fill(0);
      this.input = [];
      this.reset();
    }

    /** CPU reset: clears registers, condition codes, output and input position. Memory is kept. */
    reset() {
      this.pc = 0;
      this.mar = 0;
      this.mdr = 0;
      this.ir = 0;
      this.r = 0;
      this.gt = 0;
      this.eq = 0;
      this.lt = 0;
      this.halted = false;
      this.queue = []; // pending micro-ops of the current instruction: [{ op, param, phase }]
      this.decoded = null; // { opcode, address, name } once DECODE has run
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

    /** The micro-operation that the next microStep() will execute: { op, param, phase }. */
    get nextMicro() {
      if (this.halted) return null;
      return this.queue.length ? this.queue[0] : { op: FETCH_PLAN[0][0], phase: 'FETCH' };
    }

    registers() {
      return { pc: this.pc, mar: this.mar, mdr: this.mdr, ir: this.ir, r: this.r, gt: this.gt, eq: this.eq, lt: this.lt };
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

    /**
     * Executes one micro-operation (one clock step) and returns a record describing it, or null when halted.
     * A record with `blocked: 'input'` means nothing happened: the program wants an input value that is not there.
     */
    microStep() {
      if (this.halted) return null;
      if (this.queue.length === 0) {
        this.queue = FETCH_PLAN.map(([op, param]) => ({ op, param, phase: 'FETCH' })).concat({ op: 'DECODE', phase: 'DECODE' });
        this.decoded = null;
      }
      const item = this.queue[0];
      const before = this.registers();
      const memBefore = this.mem.slice();
      const rec = MICRO_OPS[item.op].call(this, item.param);
      rec.rtl = microText(item.op, item.param);
      if (rec.blocked) return rec;

      this.queue.shift();
      this.stepCount += 1;
      const after = this.registers();
      rec.op = item.op;
      rec.param = item.param;
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

    /** Runs until HALT, missing input, or maxInstructions. Returns { reason, instructions }. */
    run(maxInstructions = 1000) {
      const start = this.instructionCount;
      while (!this.halted && this.instructionCount - start < maxInstructions) {
        const recs = this.stepInstruction();
        if (recs.length && recs[recs.length - 1].blocked) return { reason: 'input', instructions: this.instructionCount - start };
      }
      return { reason: this.halted ? 'halted' : 'limit', instructions: this.instructionCount - start };
    }
  }

  // Each micro-op changes the machine and returns what the UI shows:
  //   text      plain-language explanation (with {w:..}/{a:..} value tokens)
  //   active    components taking part; wires: diagram wires carrying data
  //   bus       values on the buses: { internal, internalKind, address, data, control, io }
  //   ioTable   inputs and outputs of each component
  const IR_ADDR_TEXT = `the address field of IR (its rightmost ${ADDR_BITS} bits)`;

  function aluResult(op, a, b) {
    const raw = op === 'ADD' ? a + b : op === 'SUB' ? a - b : op === 'INC' ? a + 1 : a - 1;
    return { value: raw & WORD_MASK, overflow: raw < MIN_VALUE || raw > MAX_VALUE, raw };
  }
  const OVERFLOW_TEXT = (raw) =>
    ` The true result ${raw} does not fit in ${WORD_BITS} bits (${MIN_VALUE} … ${MAX_VALUE}), so it wraps around (only the last ${WORD_BITS} bits are kept): this is called overflow.`;

  const MICRO_OPS = {
    PC_TO_MAR() {
      const pc = this.pc;
      this.mar = pc;
      return {
        active: ['PC', 'MAR', 'CU'],
        wires: ['w-pc-bus', 'bus-internal', 'w-mar-bus'],
        bus: { internal: pc, internalKind: 'addr' },
        ioTable: [
          { component: 'PC', inputs: [], outputs: [port('to bus', pc, 'addr')] },
          { component: 'MAR', inputs: [port('from bus', pc, 'addr')], outputs: [port('new value', pc, 'addr')] },
        ],
        text: `A new instruction starts. PC holds the address of the next instruction, ${A(pc)}. It is copied into the Memory Address Register (MAR), because MAR is the only register connected to memory's address lines.`,
      };
    },
    FETCH() {
      const addr = this.mar;
      const value = this.mem[addr];
      this.mdr = value;
      return {
        active: ['CU', 'MAR', 'MEM', 'MDR'],
        wires: ['bus-ctrl', 'bus-addr', 'bus-data'],
        bus: { address: addr, data: value, control: 'FETCH' },
        ioTable: [
          { component: 'CU', inputs: [], outputs: [port('signal to memory', 'FETCH', 'text')] },
          { component: 'MAR', inputs: [], outputs: [port('address', addr, 'addr')] },
          { component: 'MEM', inputs: [port('address', addr, 'addr'), port('signal', 'FETCH', 'text')], outputs: [port(`contents of cell ${addr}`, value, 'word')] },
          { component: 'MDR', inputs: [port('from memory', value, 'word')], outputs: [port('new value', value, 'word')] },
        ],
        text: `The fetch/store controller sends a FETCH signal. Memory reads the cell whose address is in MAR (${A(addr)}) and puts its contents, ${W(value)}, into the Memory Data Register (MDR). The memory cell itself does not change.`,
      };
    },
    MDR_TO_IR() {
      const v = this.mdr;
      this.ir = v;
      return {
        active: ['MDR', 'IR', 'CU'],
        wires: ['w-mdr-bus', 'bus-internal', 'w-ir-bus'],
        bus: { internal: v, internalKind: 'word' },
        ioTable: [
          { component: 'MDR', inputs: [], outputs: [port('to bus', v, 'word')] },
          { component: 'IR', inputs: [port('from bus', v, 'word')], outputs: [port('new value', v, 'word')] },
        ],
        text: `The word just fetched, ${W(v)}, is an instruction, so it is copied from MDR into the Instruction Register (IR).`,
      };
    },
    PC_INC() {
      const old = this.pc;
      this.pc = (old + 1) & ADDR_MASK;
      return {
        active: ['PC', 'INC', 'CU'],
        wires: ['w-pc-inc'],
        bus: {},
        ioTable: [
          { component: 'INC', inputs: [port('PC', old, 'addr')], outputs: [port('PC + 1', this.pc, 'addr')] },
          { component: 'PC', inputs: [port('from +1 circuit', this.pc, 'addr')], outputs: [port('new value', this.pc, 'addr')] },
        ],
        text:
          `PC is increased by 1 (from ${A(old)} to ${A(this.pc)}), so it points to the next instruction in memory. The fetch phase is over.` +
          (old === ADDR_MASK ? ` (PC was at the last cell, ${MEM_SIZE - 1}, so it wraps around to 0.)` : ''),
      };
    },
    DECODE() {
      const opcode = opcodeOf(this.ir);
      const address = addressOf(this.ir);
      const ins = INSTRUCTIONS[opcode];
      this.decoded = { opcode, address, name: ins.name };
      const plan = EXEC_PLANS[ins.name];
      this.queue.push(...plan.map(([op, param]) => ({ op, param, phase: 'EXECUTE' })));
      const asText = ins.noOperand ? ins.name : `${ins.name} ${address}`;
      return {
        active: ['IR', 'CU'],
        wires: ['w-ir-cu'],
        bus: {},
        ioTable: [
          { component: 'IR', inputs: [], outputs: [port('op code', opcode, 'opcode'), port('address field', address, 'addr')] },
          { component: 'CU', inputs: [port('op code', opcode, 'opcode')], outputs: [port('instruction', asText, 'text')] },
        ],
        text:
          `The instruction decoder looks at the op code (leftmost ${OPCODE_BITS} bits of IR) = ${toBin(opcode, OPCODE_BITS)}, which means ${ins.name}. ` +
          (ins.noOperand ? '' : `The address field (rightmost ${ADDR_BITS} bits) is ${A(address)}. `) +
          `So the instruction is ${asText}: ${ins.summary} Its execute phase has ${plan.length} step${plan.length > 1 ? 's' : ''}.`,
      };
    },
    ADDR_TO_MAR() {
      const a = addressOf(this.ir);
      this.mar = a;
      return {
        active: ['IR', 'MAR', 'CU'],
        wires: ['w-ir-bus', 'bus-internal', 'w-mar-bus'],
        bus: { internal: a, internalKind: 'addr' },
        ioTable: [
          { component: 'IR', inputs: [], outputs: [port('address field', a, 'addr')] },
          { component: 'MAR', inputs: [port('from bus', a, 'addr')], outputs: [port('new value', a, 'addr')] },
        ],
        text: `The instruction works on memory cell ${A(a)}, so ${IR_ADDR_TEXT} is copied into MAR.`,
      };
    },
    MDR_TO_R() {
      const v = this.mdr;
      this.r = v;
      return {
        active: ['MDR', 'R', 'CU'],
        wires: ['w-mdr-bus', 'bus-internal', 'w-r-bus'],
        bus: { internal: v, internalKind: 'word' },
        ioTable: [
          { component: 'MDR', inputs: [], outputs: [port('to bus', v, 'word')] },
          { component: 'R', inputs: [port('from bus', v, 'word')], outputs: [port('new value', v, 'word')] },
        ],
        text: `The value from memory, ${W(v)}, is copied from MDR into register R.`,
      };
    },
    R_TO_MDR() {
      const v = this.r;
      this.mdr = v;
      return {
        active: ['R', 'MDR', 'CU'],
        wires: ['w-r-bus', 'bus-internal', 'w-mdr-bus'],
        bus: { internal: v, internalKind: 'word' },
        ioTable: [
          { component: 'R', inputs: [], outputs: [port('to bus', v, 'word')] },
          { component: 'MDR', inputs: [port('from bus', v, 'word')], outputs: [port('new value', v, 'word')] },
        ],
        text: `To store R (${W(v)}) in memory, it is first copied into MDR, because MDR is the only register connected to memory's data lines.`,
      };
    },
    ZERO_TO_MDR() {
      this.mdr = 0;
      return {
        active: ['MDR', 'CU'],
        wires: [],
        bus: {},
        ioTable: [{ component: 'MDR', inputs: [port('value from control unit', 0, 'word')], outputs: [port('new value', 0, 'word')] }],
        text: 'The control unit puts 0 into MDR, ready to be stored.',
      };
    },
    STORE() {
      const addr = this.mar;
      const value = this.mdr;
      const old = this.mem[addr];
      this.mem[addr] = value;
      return {
        active: ['CU', 'MAR', 'MDR', 'MEM'],
        wires: ['bus-ctrl', 'bus-addr', 'bus-data'],
        bus: { address: addr, data: value, control: 'STORE' },
        ioTable: [
          { component: 'CU', inputs: [], outputs: [port('signal to memory', 'STORE', 'text')] },
          { component: 'MAR', inputs: [], outputs: [port('address', addr, 'addr')] },
          { component: 'MDR', inputs: [], outputs: [port('data', value, 'word')] },
          {
            component: 'MEM',
            inputs: [port('address', addr, 'addr'), port('data', value, 'word'), port('signal', 'STORE', 'text')],
            outputs: [port(`new contents of cell ${addr}`, value, 'word')],
          },
        ],
        text: `The fetch/store controller sends a STORE signal. The value in MDR, ${W(value)}, is written into the memory cell whose address is in MAR (${A(addr)}). The old contents (${W(old)}) are overwritten.`,
      };
    },
    ALU_R(op) {
      const a = this.r;
      const b = this.mdr;
      const res = aluResult(op, a, b);
      this.r = res.value;
      const sym = op === 'ADD' ? '+' : '−';
      return {
        active: ['MDR', 'R', 'ALU', 'CU'],
        wires: ['w-mdr-bus', 'bus-internal', 'w-bus-alu', 'w-r-alu', 'w-alu-r'],
        bus: { internal: b, internalKind: 'word' },
        alu: op === 'ADD' ? 'ADD' : 'SUBTRACT',
        ioTable: [
          { component: 'CU', inputs: [], outputs: [port('ALU selector', op === 'ADD' ? 'ADD' : 'SUBTRACT', 'text')] },
          { component: 'ALU', inputs: [port('A (from R)', a, 'word'), port('B (from MDR)', b, 'word')], outputs: [port(`A ${sym} B`, res.value, 'word')] },
          { component: 'R', inputs: [port('from ALU', res.value, 'word')], outputs: [port('new value', res.value, 'word')] },
        ],
        text:
          `R (${W(a)}) and MDR (${W(b)}) go into the ALU. All ALU circuits compute at once, and the multiplexer selects the ${op === 'ADD' ? 'addition' : 'subtraction'} result: ` +
          `${a} ${sym} ${b} = ${res.value}. The result goes into R.` +
          (res.overflow ? OVERFLOW_TEXT(res.raw) : ''),
      };
    },
    ALU_MDR(op) {
      const a = this.mdr;
      const res = aluResult(op, a);
      this.mdr = res.value;
      const sym = op === 'INC' ? '+' : '−';
      return {
        active: ['MDR', 'ALU', 'CU'],
        wires: ['w-mdr-bus', 'bus-internal', 'w-bus-alu', 'w-alu-bus'],
        bus: { internal: a, internalKind: 'word' },
        alu: op === 'INC' ? '+1' : '−1',
        ioTable: [
          { component: 'CU', inputs: [], outputs: [port('ALU selector', op === 'INC' ? 'ADD 1' : 'SUBTRACT 1', 'text')] },
          { component: 'ALU', inputs: [port('from MDR', a, 'word'), port('constant', 1, 'text')], outputs: [port(`MDR ${sym} 1`, res.value, 'word')] },
          { component: 'MDR', inputs: [port('from ALU', res.value, 'word')], outputs: [port('new value', res.value, 'word')] },
        ],
        text:
          `The value in MDR (${W(a)}) goes through the ALU, which ${op === 'INC' ? 'adds' : 'subtracts'} 1: ${a} ${sym} 1 = ${res.value}. ` +
          'The result goes back into MDR. R is not used and does not change.' +
          (res.overflow ? OVERFLOW_TEXT(res.raw) : ''),
      };
    },
    ALU_COMPARE() {
      const x = this.mdr;
      const r = this.r;
      this.gt = x > r ? 1 : 0;
      this.eq = x === r ? 1 : 0;
      this.lt = x < r ? 1 : 0;
      const rel = x > r ? '>' : x === r ? '=' : '<';
      return {
        active: ['MDR', 'R', 'ALU', 'CC', 'CU'],
        wires: ['w-mdr-bus', 'bus-internal', 'w-bus-alu', 'w-r-alu', 'w-alu-cc'],
        bus: { internal: this.mdr, internalKind: 'word' },
        alu: 'COMPARE',
        ioTable: [
          { component: 'CU', inputs: [], outputs: [port('ALU selector', 'COMPARE', 'text')] },
          { component: 'ALU', inputs: [port('content of X (from MDR)', this.mdr, 'word'), port('R', this.r, 'word')], outputs: [port('result', `content of X ${rel} R`, 'text')] },
          { component: 'CC', inputs: [], outputs: [port('GT', this.gt, 'bit'), port('EQ', this.eq, 'bit'), port('LT', this.lt, 'bit')] },
        ],
        text: `The ALU compares the value from memory (MDR = ${x}) with R (${r}). Since ${x} ${rel} ${r}, the condition codes become GT = ${this.gt}, EQ = ${this.eq}, LT = ${this.lt}. R and memory do not change.`,
      };
    },
    JUMP() {
      const a = addressOf(this.ir);
      this.pc = a;
      return {
        active: ['IR', 'PC', 'CU'],
        wires: ['w-ir-bus', 'bus-internal', 'w-pc-bus'],
        bus: { internal: a, internalKind: 'addr' },
        ioTable: [
          { component: 'IR', inputs: [], outputs: [port('address field', a, 'addr')] },
          { component: 'PC', inputs: [port('from bus', a, 'addr')], outputs: [port('new value', a, 'addr')] },
        ],
        text: `Jump: ${IR_ADDR_TEXT}, ${A(a)}, is copied into PC. The next instruction will be fetched from cell ${A(a)} instead of the next cell.`,
      };
    },
    JUMP_IF(cond) {
      const a = addressOf(this.ir);
      const flag = cond === 'NEQ' ? 'EQ' : cond;
      const flagVal = this[flag.toLowerCase()];
      const taken = cond === 'NEQ' ? flagVal === 0 : flagVal === 1;
      const oldPc = this.pc;
      if (taken) this.pc = a;
      const need = cond === 'NEQ' ? 'EQ = 0' : `${cond} = 1`;
      return {
        active: taken ? ['CU', 'CC', 'IR', 'PC'] : ['CU', 'CC'],
        wires: taken ? ['w-cc-cu', 'w-ir-bus', 'bus-internal', 'w-pc-bus'] : ['w-cc-cu'],
        bus: taken ? { internal: a, internalKind: 'addr' } : {},
        ioTable: [
          { component: 'CC', inputs: [], outputs: [port(flag, flagVal, 'bit')] },
          { component: 'CU', inputs: [port(flag, flagVal, 'bit')], outputs: [port('decision', taken ? 'jump' : 'no jump', 'text')] },
          taken
            ? { component: 'PC', inputs: [port('from IR', a, 'addr')], outputs: [port('new value', a, 'addr')] }
            : { component: 'PC', inputs: [], outputs: [port('unchanged', oldPc, 'addr')] },
        ],
        text: taken
          ? `The jump happens only if ${need}. The condition code ${flag} is ${flagVal}, so the jump is taken: ${IR_ADDR_TEXT}, ${A(a)}, is copied into PC.`
          : `The jump happens only if ${need}. The condition code ${flag} is ${flagVal}, so there is no jump. PC keeps ${A(oldPc)}, which already points to the next instruction.`,
      };
    },
    INPUT_TO_MDR() {
      if (this.inputPos >= this.input.length) {
        return { blocked: 'input', text: 'IN needs an input value, but there are no input values left. Type a value in the Input box and continue.' };
      }
      const v = this.input[this.inputPos++];
      this.mdr = v;
      return {
        active: ['IN', 'MDR', 'CU'],
        wires: ['bus-io', 'bus-internal', 'w-mdr-bus'],
        bus: { internal: v, internalKind: 'word' },
        io: 'IN',
        ioTable: [
          { component: 'IN', inputs: [], outputs: [port('next input value', v, 'word')] },
          { component: 'MDR', inputs: [port('from input device', v, 'word')], outputs: [port('new value', v, 'word')] },
        ],
        text: `The input device gives the next input value, ${W(v)} (decimal ${v}). It travels over the I/O bus into MDR.`,
      };
    },
    MDR_TO_OUTPUT() {
      const v = this.mdr;
      this.output.push(v);
      return {
        active: ['MDR', 'OUT', 'CU'],
        wires: ['w-mdr-bus', 'bus-internal', 'bus-io'],
        bus: { internal: v, internalKind: 'word' },
        io: 'OUT',
        ioTable: [
          { component: 'MDR', inputs: [], outputs: [port('to output device', v, 'word')] },
          { component: 'OUT', inputs: [port('value', v, 'word')], outputs: [port('printed', v, 'text')] },
        ],
        text: `The value in MDR, ${W(v)}, is sent over the I/O bus to the output device, which prints it as the decimal number ${v}.`,
      };
    },
    HALT() {
      this.halted = true;
      return {
        active: ['CU'],
        wires: [],
        bus: {},
        ioTable: [{ component: 'CU', inputs: [port('op code', 15, 'opcode')], outputs: [port('machine', 'stopped', 'text')] }],
        text: 'HALT: the control unit stops. No more instructions are fetched. Press Reset to run the program again.',
      };
    },
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Assembler

  /**
   * Two-pass assembler for the textbook's assembly language:
   *
   *   .BEGIN                      -- optional first line
   *   AGAIN:  LOAD   ZERO         -- label: instruction operand
   *           HALT
   *   ZERO:   .DATA  0            -- data cell
   *   .END                        -- optional last line
   *
   * Comments start with -- (or ;). Operands: a label, a cell number (0–15), or label+n / label-n.
   * Returns { words, errors: [{ line, message }], listing: [{ addr, word, line, source, kind }], symbols }
   * (kind: 'data' for a .DATA cell, 'instruction' otherwise).
   */
  function assemble(source) {
    const errors = [];
    const symbols = {};
    const items = [];
    let loc = 0;
    let ended = false;
    const err = (line, message) => errors.push({ line, message });

    String(source)
      .split(/\r?\n/)
      .forEach((raw, idx) => {
        if (ended) return;
        const line = idx + 1;
        let text = raw.replace(/(--|;).*$/, '').trim();
        let m;
        while ((m = /^([A-Za-z_]\w*)\s*:\s*/.exec(text))) {
          const key = m[1].toUpperCase();
          if (BY_NAME[key]) err(line, `"${m[1]}" is an instruction name and cannot be used as a label`);
          else if (key in symbols) err(line, `Label "${m[1]}" is defined twice`);
          else symbols[key] = loc;
          text = text.slice(m[0].length);
        }
        if (!text) return;

        const [head, ...rest] = text.split(/\s+/);
        const word = head.toUpperCase();
        const args = rest.join(' ').split(/\s*,\s*|\s+/).filter(Boolean);

        if (word === '.BEGIN') return;
        if (word === '.END') {
          ended = true;
          return;
        }
        if (word === '.DATA') {
          if (args.length === 0) err(line, '.DATA needs a value, e.g. ".DATA 5"');
          for (const expr of args) items.push({ kind: 'data', expr, line, addr: loc++, source: raw.trim() });
          return;
        }
        const ins = BY_NAME[word];
        if (!ins) {
          err(line, `Unknown instruction "${head}". The instructions are: ${INSTRUCTIONS.map((i) => i.name).join(', ')}`);
          return;
        }
        if (!ins.noOperand && args.length !== 1) err(line, `${ins.name} needs exactly one operand: a memory address or a label`);
        else if (ins.noOperand && args.length) err(line, `${ins.name} takes no operand`);
        items.push({ kind: 'ins', ins, expr: args[0], line, addr: loc++, source: raw.trim() });
      });

    const resolve = (expr, line) => {
      const lm = /^([A-Za-z_]\w*)([+-]\d+)?$/.exec(expr);
      if (lm) {
        const key = lm[1].toUpperCase();
        if (!(key in symbols)) {
          err(line, `Unknown label "${lm[1]}"`);
          return null;
        }
        return symbols[key] + (lm[2] ? parseInt(lm[2], 10) : 0);
      }
      const v = parseNumber(expr);
      if (v === null) err(line, `"${expr}" is not a number or a label`);
      return v;
    };

    const words = new Array(MEM_SIZE).fill(0);
    const listing = [];
    let tooLong = false;
    for (const it of items) {
      if (it.addr >= MEM_SIZE) {
        if (!tooLong) err(it.line, `The program does not fit: memory has only ${MEM_SIZE} cells (0–${MEM_SIZE - 1}). This line would go into cell ${it.addr}.`);
        tooLong = true;
        continue;
      }
      let word = 0;
      if (it.kind === 'data') {
        const v = resolve(it.expr, it.line);
        if (v !== null && (v < MIN_VALUE || v > MAX_VALUE)) err(it.line, `${v} does not fit in a cell (${WORD_BITS} bits): use a number from ${MIN_VALUE} to ${MAX_VALUE}`);
        word = (v ?? 0) & WORD_MASK;
      } else {
        let address = 0;
        if (!it.ins.noOperand && it.expr !== undefined) {
          const v = resolve(it.expr, it.line);
          if (v !== null && (v < 0 || v >= MEM_SIZE)) err(it.line, `Address ${v} is outside memory (0–${MEM_SIZE - 1})`);
          else if (v !== null) address = v;
        }
        word = encode(it.ins.opcode, address);
      }
      words[it.addr] = word;
      listing.push({ addr: it.addr, word, line: it.line, source: it.source, kind: it.kind === 'data' ? 'data' : 'instruction' });
    }
    errors.sort((a, b) => a.line - b.line);
    return { words, errors, listing, symbols };
  }

  return {
    WORD_BITS,
    OPCODE_BITS,
    ADDR_BITS,
    MEM_SIZE,
    WORD_MASK,
    ADDR_MASK,
    MIN_VALUE,
    MAX_VALUE,
    INSTRUCTIONS,
    BY_NAME,
    EXEC_PLANS,
    FETCH_PLAN,
    Machine,
    microText,
    assemble,
    parseNumber,
    parseValueList,
    toBin,
    wordBin,
    opcodeOf,
    addressOf,
    encode,
    disassemble,
  };
});
