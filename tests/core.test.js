'use strict';

// Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const VN = require('../js/core.js');
const EXAMPLES = require('../js/examples.js');

function machineFor(source, input = []) {
  const asm = VN.assemble(source);
  assert.deepEqual(asm.errors, [], JSON.stringify(asm.errors));
  const m = new VN.Machine();
  m.load(asm.words);
  m.setInput(input.map((v) => v & 255));
  return m;
}
const op = (name) => VN.BY_NAME[name].opcode;

test('machine size: 16 cells, 8-bit words, 4-bit op code and 4-bit address', () => {
  assert.equal(VN.MEM_SIZE, 16);
  assert.equal(VN.INSTRUCTIONS.length, 16);
  VN.INSTRUCTIONS.forEach((ins, i) => assert.equal(ins.opcode, i));
  assert.equal(VN.encode(op('ADD'), 5), 0b00110101);
  assert.equal(VN.wordBin(0b00110101), '0011 0101');
  assert.equal(VN.disassemble(0b00110101), 'ADD 5');
  assert.equal(VN.disassemble(0b11110000), 'HALT');
});

test('parseNumber accepts decimal and binary only', () => {
  assert.equal(VN.parseNumber('42'), 42);
  assert.equal(VN.parseNumber('-3'), -3);
  assert.equal(VN.parseNumber('0b101'), 5);
  assert.equal(VN.parseNumber('0x2A'), null);
});

test('assembler: textbook syntax with .BEGIN, labels, .DATA, -- comments and .END', () => {
  const asm = VN.assemble(`.BEGIN
AGAIN:  LOAD    ZERO   -- comment
        JUMPLT  AGAIN
        HALT
ZERO:   .DATA   255
.END
        LOAD 3  -- ignored after .END`);
  assert.deepEqual(asm.errors, []);
  assert.equal(asm.words[0], VN.encode(op('LOAD'), 3));
  assert.equal(asm.words[1], VN.encode(op('JUMPLT'), 0));
  assert.equal(asm.words[2], VN.encode(op('HALT'), 0));
  assert.equal(asm.words[3], 0xff);
  assert.equal(asm.listing.length, 4);
});

test('assembler reports useful errors with line numbers', () => {
  const asm = VN.assemble('LOAD nowhere\nFOO 3\nADD\nHALT 3\nX: .DATA 300\nX: .DATA 1\nLOAD 16\nLOAD: .DATA 1\nY: .DATA -1');
  assert.deepEqual(asm.errors.map((e) => e.line), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.match(asm.errors[0].message, /Unknown label/);
  assert.match(asm.errors[1].message, /Unknown instruction/);
});

test('assembler rejects programs longer than 16 cells', () => {
  const asm = VN.assemble(Array.from({ length: 17 }, () => 'HALT').join('\n'));
  assert.equal(asm.errors.length, 1);
  assert.match(asm.errors[0].message, /does not fit/);
});

test('fetch is MAR ← PC, fetch, IR ← MDR, PC ← PC + 1, then decode', () => {
  const m = machineFor('LOAD X\nHALT\nX: .DATA 9');
  const recs = m.stepInstruction();
  assert.deepEqual(
    recs.map((r) => `${r.phase} ${r.rtl}`),
    [
      'FETCH MAR ← PC',
      'FETCH MDR ← content of cell MAR   (fetch)',
      'FETCH IR ← MDR',
      'FETCH PC ← PC + 1',
      'DECODE decode IR',
      'EXECUTE MAR ← IR(address)',
      'EXECUTE MDR ← content of cell MAR   (fetch)',
      'EXECUTE R ← MDR',
    ],
  );
  assert.deepEqual(m.registers(), { pc: 1, mar: 2, mdr: 9, ir: VN.encode(op('LOAD'), 2), r: 9, gt: 0, eq: 0, lt: 0 });
});

test('STORE, CLEAR, INCREMENT and DECREMENT change memory', () => {
  const m = machineFor('LOAD A\nSTORE B\nCLEAR A\nINCREMENT B\nDECREMENT C\nHALT\nA: .DATA 5\nB: .DATA 0\nC: .DATA 0');
  m.run();
  assert.deepEqual([m.mem[6], m.mem[7], m.mem[8]], [0, 6, 255]); // 0 - 1 wraps around to 255
  assert.equal(m.r, 5); // INCREMENT/DECREMENT do not touch R
});

test('ADD and SUBTRACT work on R with unsigned 8-bit numbers (results wrap around)', () => {
  const m = machineFor('LOAD A\nADD B\nSTORE A\nSUBTRACT C\nHALT\nA: .DATA 200\nB: .DATA 50\nC: .DATA 1');
  m.stepInstruction();
  m.stepInstruction();
  assert.equal(m.r, 250);
  m.run();
  assert.equal(m.r, 249);
  const w = machineFor('LOAD A\nADD A\nHALT\nA: .DATA 200');
  w.run();
  assert.equal(w.r, 144); // 400 does not fit in 8 bits: 400 - 256
});

test('COMPARE sets GT/EQ/LT by comparing CON(X) with R (signed)', () => {
  const cases = [
    [5, 3, [1, 0, 0]],
    [3, 3, [0, 1, 0]],
    [2, 3, [0, 0, 1]],
    [200, 3, [1, 0, 0]],
  ];
  for (const [x, r, cc] of cases) {
    const m = machineFor(`LOAD R\nCOMPARE X\nHALT\nR: .DATA ${r}\nX: .DATA ${x}`);
    m.stepInstruction();
    m.stepInstruction();
    assert.deepEqual([m.gt, m.eq, m.lt], cc, `CON(X)=${x}, R=${r}`);
  }
});

test('conditional jumps follow the condition codes', () => {
  const run = (jump, x, r) => {
    const m = machineFor(`LOAD R\nCOMPARE X\n${jump} 15\nHALT\nR: .DATA ${r}\nX: .DATA ${x}`);
    m.stepInstruction();
    m.stepInstruction();
    m.stepInstruction();
    return m.pc;
  };
  assert.equal(run('JUMPGT', 5, 3), 15);
  assert.equal(run('JUMPGT', 3, 3), 3);
  assert.equal(run('JUMPEQ', 3, 3), 15);
  assert.equal(run('JUMPLT', 1, 3), 15);
  assert.equal(run('JUMPNEQ', 3, 3), 3);
  assert.equal(run('JUMPNEQ', 4, 3), 15);
});

test('IN waits for input, and resumes when input is added', () => {
  const m = machineFor('IN X\nOUT X\nHALT\nX: .DATA 0');
  assert.equal(m.run().reason, 'input');
  const pc = m.pc;
  assert.equal(m.microStep().blocked, 'input');
  assert.equal(m.pc, pc);
  m.setInput([33]);
  assert.equal(m.run().reason, 'halted');
  assert.deepEqual(m.output, [33]);
  assert.equal(m.mem[3], 33);
});

test('records list register changes and memory writes', () => {
  const m = machineFor('STORE 10\nHALT');
  m.r = 77;
  const recs = m.stepInstruction();
  assert.deepEqual(recs[3].changes.pc, [0, 1]);
  const store = recs[recs.length - 1];
  assert.equal(store.bus.control, 'STORE');
  assert.deepEqual(store.memWrites, [{ addr: 10, from: 0, to: 77 }]);
});

test('snapshot/restore allows stepping back', () => {
  const m = machineFor(EXAMPLES[0].source);
  m.microStep();
  const snap = m.snapshot();
  m.stepInstruction();
  m.stepInstruction();
  m.restore(snap);
  assert.deepEqual(m.snapshot(), snap);
});

test('run stops runaway programs', () => {
  const m = machineFor('LOOP: JUMP LOOP');
  assert.equal(m.run(50).reason, 'limit');
});

test('HALT stops the machine', () => {
  const m = machineFor('HALT');
  m.stepInstruction();
  assert.equal(m.halted, true);
  assert.equal(m.microStep(), null);
});

for (const ex of EXAMPLES) {
  test(`example "${ex.title}" fits in memory and prints ${JSON.stringify(ex.expected)}`, () => {
    const m = machineFor(ex.source, VN.parseValueList(ex.input).values);
    assert.equal(m.run().reason, 'halted');
    assert.deepEqual(m.output, ex.expected);
  });
}
