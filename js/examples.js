/* Example programs shown in the "Examples" menu. `expected` is checked by the unit tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VNExamples = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  return [
    {
      id: 'add',
      title: '1. Add two numbers',
      input: '',
      expected: [12],
      source: `; z = x + y, then print z
; Start with Micro-step to watch every fetch, decode and execute step.
        LDA x       ; AC <- M[x]
        ADD y       ; AC <- AC + M[y]
        STA z       ; M[z] <- AC
        OUT         ; print AC (same as STA 31)
        HLT

x:      DATA 5
y:      DATA 7
z:      DATA 0
`,
    },
    {
      id: 'io',
      title: '2. Read two inputs, print the sum',
      input: '20, 22',
      expected: [42],
      source: `; IN reads the next value from the Input box (it is LDA 30).
; OUT prints AC (it is STA 31). Cells 30 and 31 are memory-mapped I/O ports.
        IN
        STA a
        IN
        ADD a
        OUT
        HLT

a:      DATA 0
`,
    },
    {
      id: 'countdown',
      title: '3. Countdown loop (JZ, JMP)',
      input: '',
      expected: [5, 4, 3, 2, 1],
      source: `; Print n, n-1, ..., 1
loop:   LDA n
        JZ done     ; stop when n = 0
        OUT
        SUB one
        STA n
        JMP loop
done:   HLT

n:      DATA 5
one:    DATA 1
`,
    },
    {
      id: 'multiply',
      title: '4. Multiply by repeated addition',
      input: '',
      expected: [42],
      source: `; prod = a * b   (add a to prod, b times)
loop:   LDA b
        JZ done
        SUB one
        STA b
        LDA prod
        ADD a
        STA prod
        JMP loop
done:   LDA prod
        OUT
        HLT

a:      DATA 6
b:      DATA 7
prod:   DATA 0
one:    DATA 1
`,
    },
    {
      id: 'max',
      title: '5. Larger of two inputs (JN)',
      input: '17, 9',
      expected: [17],
      source: `; Print the larger of two input values (works for 0..127)
        IN
        STA a
        IN
        STA b
        SUB a       ; AC = b - a
        JN aBig     ; negative => a > b
        LDA b
        JMP print
aBig:   LDA a
print:  OUT
        HLT

a:      DATA 0
b:      DATA 0
`,
    },
    {
      id: 'selfmod',
      title: '6. Sum an array (self-modifying code)',
      input: '',
      expected: [24],
      source: `; Instructions and data share one memory (the stored-program idea).
; The program changes its own ADD instruction to walk through the array:
; "LDA step" loads an INSTRUCTION as a NUMBER, adds 1 to its address field,
; and stores it back. Watch cell 1 change in the memory view.
loop:   LDA sum
step:   ADD arr     ; the address field of this word is incremented each pass
        STA sum
        LDA step
        ADD one
        STA step
        LDA count
        SUB one
        STA count
        JZ done
        JMP loop
done:   LDA sum
        OUT
        HLT

sum:    DATA 0
one:    DATA 1
count:  DATA 4
arr:    DATA 3, 5, 7, 9
`,
    },
    {
      id: 'blank',
      title: 'Empty program',
      input: '',
      expected: [],
      source: `; Write your program here, then press "Assemble & load".
;   label:  MNEMONIC operand   ; comment
        HLT
`,
    },
  ];
});
