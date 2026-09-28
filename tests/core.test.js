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
  m.setInput(input);
  return m;
}

test('encoding: opcode in the top 3 bits, address in the low 5 bits', () => {
  assert.equal(VN.encode(0b001, 14), 0b00101110);
  assert.equal(VN.opcodeOf(0b00101110), 0b001);
  assert.equal(VN.operandOf(0b00101110), 14);
  assert.equal(VN.disassemble(0b00101110), 'LDA 14');
  assert.equal(VN.disassemble(0), 'HLT');
});

test('parseNumber handles decimal, binary, hex and sign', () => {
  assert.equal(VN.parseNumber('42'), 42);
  assert.equal(VN.parseNumber('-3'), -3);
  assert.equal(VN.parseNumber('0b101'), 5);
  assert.equal(VN.parseNumber('0x2A'), 42);
  assert.equal(VN.parseNumber('abc'), null);
});

test('assembler resolves labels, pseudo-instructions, DATA lists and label offsets', () => {
  const asm = VN.assemble(`
start:  LDA x   ; comment
        ADD arr+2
        OUT
        IN
        JMP start
        HLT
x:      DATA -1
arr:    DATA 1, 2, 0b11
`);
  assert.deepEqual(asm.errors, []);
  assert.equal(asm.words[0], VN.encode(1, 6)); // LDA x (x = 6)
  assert.equal(asm.words[1], VN.encode(3, 9)); // ADD arr+2 (arr = 7)
  assert.equal(asm.words[2], VN.encode(2, 31)); // OUT = STA 31
  assert.equal(asm.words[3], VN.encode(1, 30)); // IN = LDA 30
  assert.equal(asm.words[4], VN.encode(5, 0));
  assert.equal(asm.words[6], 0xff); // -1 in two's complement
  assert.deepEqual(asm.words.slice(7, 10), [1, 2, 3]);
});

test('assembler reports useful errors with line numbers', () => {
  const asm = VN.assemble('LDA nowhere\nFOO 3\nADD\nHLT 3\nx: DATA 300\nx: DATA 1\nLDA 40');
  const lines = asm.errors.map((e) => e.line);
  assert.deepEqual(lines, [1, 2, 3, 4, 5, 6, 7]);
  assert.match(asm.errors[0].message, /Unknown label/);
  assert.match(asm.errors[1].message, /Unknown instruction/);
});

test('assembler rejects programs that do not fit or overlap the I/O ports', () => {
  const tooLong = Array.from({ length: 31 }, () => 'HLT').join('\n');
  assert.ok(VN.assemble(tooLong).errors.some((e) => /I\/O ports/.test(e.message)));
  assert.ok(VN.assemble('ORG 5\nHLT\nORG 5\nHLT').errors.some((e) => /already used/.test(e.message)));
});

test('binary loader accepts plain words, spaced words, address prefixes and comments', () => {
  const r = VN.parseBinary(`
; program
001 01110
00111: 00000101   # at address 7
10: 11111111
`);
  assert.deepEqual(r.errors, []);
  assert.equal(r.words[0], 0b00101110);
  assert.equal(r.words[7], 5);
  assert.equal(r.words[10], 255);
  assert.equal(r.count, 3);
  assert.equal(VN.parseBinary('0101').errors.length, 1);
});

test('formatBinary output can be loaded back unchanged', () => {
  const asm = VN.assemble(EXAMPLES.find((e) => e.id === 'selfmod').source);
  const text = VN.formatBinary(asm.words);
  assert.deepEqual(VN.parseBinary(text).words, asm.words);
});

test('fetch is MAR<-PC, then MDR<-M[MAR] with PC+1, then IR<-MDR, then decode', () => {
  const m = machineFor('LDA x\nHLT\nx: DATA 9');
  const ops = [];
  let r;
  do {
    r = m.microStep();
    ops.push([r.phase, r.op]);
  } while (!r.instructionDone);
  assert.deepEqual(ops, [
    ['FETCH', 'FETCH_MAR'],
    ['FETCH', 'FETCH_READ'],
    ['FETCH', 'FETCH_IR'],
    ['DECODE', 'DECODE'],
    ['EXECUTE', 'EXEC_MAR_IR'],
    ['EXECUTE', 'EXEC_READ'],
    ['EXECUTE', 'EXEC_AC_MDR'],
  ]);
  assert.deepEqual(m.registers(), { pc: 1, mar: 2, mdr: 9, ir: VN.encode(1, 2), ac: 9, z: false, n: false });
});

test('records list register changes and memory writes', () => {
  const m = machineFor('STA 10\nHLT');
  m.ac = 77;
  const recs = m.stepInstruction();
  assert.deepEqual(recs[1].changes.pc, [0, 1]);
  const write = recs[recs.length - 1];
  assert.equal(write.bus.control, 'WRITE');
  assert.deepEqual(write.memWrites, [{ addr: 10, from: 0, to: 77 }]);
  assert.equal(m.mem[10], 77);
});

test('ALU wraps around in 8 bits and sets Z and N', () => {
  const m = machineFor('LDA a\nADD b\nSUB c\nHLT\na: DATA 250\nb: DATA 10\nc: DATA 5');
  m.stepInstruction();
  m.stepInstruction();
  assert.equal(m.ac, 4); // 260 mod 256
  m.stepInstruction();
  assert.equal(m.ac, 255); // 4 - 5 = -1
  assert.equal(m.n, true);
  assert.equal(m.z, false);
});

test('JZ and JN jump only when their flag is set', () => {
  const m = machineFor('LDA zero\nJZ 5\nHLT\nHLT\nHLT\nLDA neg\nJN 9\nHLT\nHLT\nHLT\nzero: DATA 0\nneg: DATA -2');
  m.stepInstruction();
  m.stepInstruction();
  assert.equal(m.pc, 5);
  m.stepInstruction();
  m.stepInstruction();
  assert.equal(m.pc, 9);

  const n = machineFor('LDA one\nJZ 5\nHLT\none: DATA 1');
  n.stepInstruction();
  n.stepInstruction();
  assert.equal(n.pc, 2);
});

test('reading the input port blocks when no input is left, and resumes when it is added', () => {
  const m = machineFor('IN\nOUT\nHLT');
  assert.equal(m.run().reason, 'input');
  assert.equal(m.nextPhase, 'EXECUTE');
  const pcBefore = m.pc;
  const blocked = m.microStep();
  assert.equal(blocked.blocked, 'input');
  assert.equal(m.pc, pcBefore);
  m.setInput([33]);
  assert.equal(m.run().reason, 'halted');
  assert.deepEqual(m.output, [33]);
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

test('HLT stops the machine', () => {
  const m = machineFor('HLT');
  const recs = m.stepInstruction();
  assert.equal(recs.at(-1).op, 'EXEC_HALT');
  assert.equal(m.halted, true);
  assert.equal(m.microStep(), null);
});

for (const ex of EXAMPLES) {
  test(`example "${ex.title}" assembles and prints ${JSON.stringify(ex.expected)}`, () => {
    const m = machineFor(ex.source, VN.parseValueList(ex.input).values);
    assert.equal(m.run().reason, 'halted');
    assert.deepEqual(m.output, ex.expected);
  });
}
