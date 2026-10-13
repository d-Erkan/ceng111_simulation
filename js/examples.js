/* Example programs shown in the "Examples" menu. `expected` (the printed output) is checked by the unit tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VNExamples = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  return [
    {
      id: 'add',
      title: '1. Set a to b + c (slides, Week 3)',
      input: '',
      expected: [12],
      source: `.BEGIN
-- a = b + c, then print a.
-- Tip: press "Next step" to watch every fetch, decode and execute step.
        LOAD    B       -- Put the value of b into register R.
        ADD     C       -- Add c to register R. R now holds b + c.
        STORE   A       -- Store the contents of register R into a.
        OUT     A       -- Print a.
        HALT
A:      .DATA   0
B:      .DATA   5
C:      .DATA   7
.END
`,
    },
    {
      id: 'expr',
      title: '2. A = B + C − 7 (slides, Week 3)',
      input: '',
      expected: [13],
      source: `.BEGIN
        LOAD     B       -- Put the value B into register R.
        ADD      C       -- R now holds the sum (B + C).
        SUBTRACT SEVEN   -- R now holds the expression (B + C - 7).
        STORE    A       -- Store the result into A.
        OUT      A
        HALT
-- These data should be placed after the HALT.
A:      .DATA   0
B:      .DATA   12
C:      .DATA   8
SEVEN:  .DATA   7        -- The constant 7.
.END
`,
    },
    {
      id: 'max',
      title: '3. The larger of two inputs (COMPARE, JUMPGT)',
      input: '17, 9',
      expected: [17],
      source: `.BEGIN
-- Read a and b, then print the larger one.
        IN      A
        IN      B
        LOAD    B        -- R = b
        COMPARE A        -- GT = 1 if a > b
        JUMPGT  ABIG     -- go to ABIG if a > b
        OUT     B        -- here a <= b, so print b
        HALT
ABIG:   OUT     A        -- here a > b, so print a
        HALT
A:      .DATA   0
B:      .DATA   0
.END
`,
    },
    {
      id: 'countdown',
      title: '4. Countdown loop (DECREMENT, JUMPEQ)',
      input: '',
      expected: [3, 2, 1],
      source: `.BEGIN
-- Print N, N-1, ..., 1
LOOP:   LOAD    ZERO     -- R = 0
        COMPARE N        -- EQ = 1 if N = 0
        JUMPEQ  DONE     -- stop when N = 0
        OUT     N
        DECREMENT N
        JUMP    LOOP
DONE:   HALT
N:      .DATA   3
ZERO:   .DATA   0
.END
`,
    },
    {
      id: 'sum',
      title: '5. Sum of numbers until 0 is entered (slides, Week 3)',
      input: '5, 7, 3, 0',
      expected: [15],
      source: `.BEGIN
-- Read numbers one by one and add them up. When 0 is entered, print the sum and stop.
-- (The slides stop at a negative number; this machine only has numbers 0..255, so it stops at 0.)
        CLEAR   SUM      -- Set the running sum to 0.
        IN      N        -- Input the first number N.
AGAIN:  LOAD    ZERO     -- Put 0 into register R.
        COMPARE N        -- Compare N and 0.
        JUMPEQ  DONE     -- Go to DONE if N = 0.
        LOAD    SUM      -- Put SUM into R.
        ADD     N        -- Add N. R now holds (N + SUM).
        STORE   SUM      -- Put the result back into SUM.
        IN      N        -- Get the next input value.
        JUMP    AGAIN    -- Go back and repeat the loop.
DONE:   OUT     SUM      -- Print the sum
        HALT             -- and stop.
SUM:    .DATA   0        -- The running sum goes here.
N:      .DATA   0        -- The input data are placed here.
ZERO:   .DATA   0        -- The constant 0.
.END
`,
    },
    {
      id: 'multiply',
      title: '6. Multiply by repeated addition',
      input: '',
      expected: [42],
      source: `.BEGIN
-- P = A * B  (add A to P, B times)
LOOP:   LOAD    ZERO
        COMPARE B        -- EQ = 1 if B = 0
        JUMPEQ  DONE
        LOAD    P
        ADD     A
        STORE   P        -- P = P + A
        DECREMENT B      -- B = B - 1
        JUMP    LOOP
DONE:   OUT     P
        HALT
A:      .DATA   6
B:      .DATA   7
P:      .DATA   0
ZERO:   .DATA   0
.END
`,
    },
    {
      id: 'stored',
      title: '7. Stored program: an instruction changes itself',
      input: '',
      expected: [10, 20, 30],
      source: `.BEGIN
-- Instructions and data are in the same memory (the stored-program idea).
-- INCREMENT LOOP adds 1 to the instruction "OUT ARR" itself, so its address
-- field moves to the next array cell. Watch cell 0 change in the Memory editor.
LOOP:   OUT     ARR
        INCREMENT LOOP
        DECREMENT CNT
        LOAD    ZERO
        COMPARE CNT      -- EQ = 1 if CNT = 0
        JUMPNEQ LOOP
        HALT
CNT:    .DATA   3
ZERO:   .DATA   0
ARR:    .DATA   10
        .DATA   20
        .DATA   30
.END
`,
    },
    {
      id: 'loop',
      title: '8. Loop: 1 + 2 + 3 + 4 + 5 (JUMPGT goes back)',
      input: '',
      expected: [15],
      source: `.BEGIN
-- Adds 1 + 2 + 3 + 4 + 5 with a loop and prints the sum (15).
-- The loop body (addresses 0-6) runs 5 times; JUMPGT jumps back to LOOP while LIMIT > I.
LOOP:   LOAD    SUM     -- R = SUM
        ADD     I       -- R = SUM + I
        STORE   SUM     -- SUM = SUM + I
        INCREMENT I     -- I = I + 1: the next number
        LOAD    I       -- R = I
        COMPARE LIMIT   -- compare LIMIT with R: GT = 1 if LIMIT > I
        JUMPGT  LOOP    -- more numbers to add? go back
        OUT     SUM     -- print the sum
        HALT
SUM:    .DATA   0
I:      .DATA   1
LIMIT:  .DATA   6
.END
`,
    },
    {
      id: 'blank',
      title: 'Empty program',
      input: '',
      expected: [],
      source: `.BEGIN
-- Write your program here, then press "Assemble & load".
--   LABEL:  INSTRUCTION  operand   -- comment
        HALT
.END
`,
    },
  ];
});
