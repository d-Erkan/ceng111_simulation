# Von Neumann Machine Simulator (CENG 111)

A browser-based simulator for teaching the Von Neumann architecture: students load a program (assembly or raw
binary), then step through the **fetch → decode → execute** cycle one clock step at a time. At each step they see
which components (PC, IR, MAR, MDR, AC, ALU, control unit, memory, I/O) take part, what goes into and comes out of
each one, and which buses carry which values.

It is a **static website** (HTML + CSS + plain JavaScript, no build step, no server code, no external libraries),
so it can be hosted for free and any number of students can use it at the same time.

## Features

- **Datapath diagram** that highlights the active components and animates the buses carrying data. Each bus shows
  its value, and the control bus shows READ/WRITE.
- **Step explanation** in plain language plus register-transfer notation (`MAR ← PC`, `MDR ← M[MAR]`, …), and an
  **inputs/outputs table** for every component involved in the step.
- **Micro-step**, **Instruction**, **Run** (6 speeds), **Back** (unlimited undo), **Reset**, and **breakpoints**
  (click an address in the memory table).
- **Two ways to load a program:** an assembler with labels, `DATA`, `ORG`, `IN`/`OUT`, and clear error messages
  with line numbers, or a **binary loader** (one 8-bit word per line). Students can also open a `.txt` file or a
  raw binary file.
- **Editable memory:** each cell is shown as a number *and* as an instruction, to show that instructions and data
  share one memory.
- **Predict mode** for exam practice: before each instruction, students type what PC, IR, MAR, MDR and AC will hold
  afterwards, then get checked and scored.
- **Execution trace table** (one row per micro-step or per instruction) with changed values highlighted. It exports
  to CSV, which is useful for preparing answer keys.
- Number display in binary, unsigned decimal, signed decimal or hex.
- **Share links** that encode the program in the URL, so a TA can post an exercise as a single link.
- Works offline: open `index.html` directly from disk. Dark mode, keyboard shortcuts (`S`, `I`, `B`, `R`, `Space`).

## The machine

| | |
|---|---|
| Word size | 8 bits |
| Memory | 32 cells (5-bit addresses); cells 30/31 are memory-mapped input/output ports |
| Instruction format | `ooo aaaaa`: 3-bit opcode, 5-bit address |
| Registers | PC, IR, MAR, MDR, AC, flags Z and N |

| Opcode | Instruction | Meaning | Execute micro-steps |
|---|---|---|---|
| 000 | `HLT` | stop | halt |
| 001 | `LDA a` | AC ← M[a] | MAR ← IR[addr]; MDR ← M[MAR]; AC ← MDR |
| 010 | `STA a` | M[a] ← AC | MAR ← IR[addr]; MDR ← AC; M[MAR] ← MDR |
| 011 | `ADD a` | AC ← AC + M[a] | MAR ← IR[addr]; MDR ← M[MAR]; AC ← AC + MDR |
| 100 | `SUB a` | AC ← AC − M[a] | MAR ← IR[addr]; MDR ← M[MAR]; AC ← AC − MDR |
| 101 | `JMP a` | PC ← a | PC ← IR[addr] |
| 110 | `JZ a` | if AC = 0: PC ← a | if Z: PC ← IR[addr] |
| 111 | `JN a` | if AC < 0: PC ← a | if N: PC ← IR[addr] |

Fetch (same for every instruction): `MAR ← PC`, then `MDR ← M[MAR]` and `PC ← PC + 1`, then `IR ← MDR`.
`IN` and `OUT` are assembler shorthands for `LDA 30` and `STA 31`.

> **Match the lecture notes before the Week 3 lecture.** This instruction set is a reasonable default, but the
> exam should use exactly the machine taught in *Introduction to Computer Hardware and Systems* (Üçoluk & Kalkan).
> All ISA details live in `js/core.js`: `INSTRUCTIONS` (opcodes), `EXEC_PLANS` (micro-steps per instruction) and
> `MICRO_OPS` (what each micro-step does and how it is explained). Word and address sizes are constants at the top
> of the file. After changing them, update the tests and example programs.

## Files

```
ceng111_simulation/
├── index.html        page layout and datapath diagram (SVG)
├── css/style.css
├── js/core.js        ISA, machine, assembler, binary loader (no DOM; unit-tested)
├── js/examples.js    example programs (their expected outputs are checked by the tests)
├── js/ui.js          rendering and interaction
├── tests/core.test.js
└── .github/workflows/pages.yml   runs the tests, deploys to GitHub Pages
```

## Run locally

Open `index.html` in a browser. That's all.
To serve it (for example, to test share links): `python3 -m http.server 8000` and open http://localhost:8000.

Tests (Node ≥ 20, no dependencies): `node --test tests/*.test.js`

## Hosting for free

Because the site is static, the server only sends about 100 KB of files once. After that, all simulation runs in
the student's own browser, so 200 (or 2000) students at the same time put no real load on the server. No backend,
database or scaling is needed.

| Option | Cost | Notes |
|---|---|---|
| **GitHub Pages** (recommended) | free | `.github/workflows/pages.yml` runs the tests and deploys the site on every push to `main`. One-time setup: repo **Settings → Pages → Source: GitHub Actions**. URL: `https://<user>.github.io/ceng111_simulation/`. Putting the repo under a course GitHub organization means it outlives any one TA. |
| Department web server | free | Copy `index.html`, `css/` and `js/` to the course page (`ceng.metu.edu.tr/ceng111/...`) or a personal `public_html`. This is the **safest option for the exam**: it is reachable even if the lab network blocks outside sites. |
| Cloudflare Pages / Netlify | free tier | Connect the repo, leave the output directory as the repo root, no build command. |
| Offline / exam machines | free | Copy the folder to the lab PCs and open `index.html`. It needs no internet. |

## Ideas for next steps

- Align the ISA and the diagram labels with the lecture notes (see the note above).
- An **exam question generator**: random short programs with "fill in the register values after each step"
  tables, with answer keys from the trace export.
- A **Harvard architecture toggle** (separate instruction/data memories) for the Von Neumann vs Harvard comparison
  in the syllabus.
- A Turkish UI translation, if wanted.
