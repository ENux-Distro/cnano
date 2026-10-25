// Extra Monaco languages that cnano cares about but Monaco doesn't ship.
/* exported registerCnanoLanguages */
function registerCnanoLanguages(monaco) {
  // ---------- Assembly (x86/x86-64 in GAS + NASM syntax, plus common ARM/RISC-V mnemonics) ----------
  monaco.languages.register({ id: 'asm', extensions: ['.s', '.S', '.asm', '.nasm', '.inc'], aliases: ['Assembly', 'asm'] });
  monaco.languages.setMonarchTokensProvider('asm', {
    ignoreCase: true,
    registers: [
      'rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp', 'rip', 'eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'eip',
      'ax', 'bx', 'cx', 'dx', 'si', 'di', 'bp', 'sp', 'ip', 'al', 'ah', 'bl', 'bh', 'cl', 'ch', 'dl', 'dh', 'sil', 'dil', 'bpl', 'spl',
      'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
      'r8d', 'r9d', 'r10d', 'r11d', 'r12d', 'r13d', 'r14d', 'r15d', 'r8w', 'r9w', 'r10w', 'r11w', 'r12w', 'r13w', 'r14w', 'r15w',
      'r8b', 'r9b', 'r10b', 'r11b', 'r12b', 'r13b', 'r14b', 'r15b',
      'cs', 'ds', 'es', 'fs', 'gs', 'ss', 'cr0', 'cr2', 'cr3', 'cr4', 'cr8', 'dr0', 'dr1', 'dr2', 'dr3', 'dr6', 'dr7', 'eflags', 'rflags',
      'xmm0', 'xmm1', 'xmm2', 'xmm3', 'xmm4', 'xmm5', 'xmm6', 'xmm7', 'xmm8', 'xmm9', 'xmm10', 'xmm11', 'xmm12', 'xmm13', 'xmm14', 'xmm15',
      'ymm0', 'ymm1', 'ymm2', 'ymm3', 'ymm4', 'ymm5', 'ymm6', 'ymm7', 'zmm0', 'zmm1', 'st0', 'st1',
      // ARM / AArch64 / RISC-V
      'x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'x9', 'x10', 'x11', 'x12', 'x13', 'x14', 'x15', 'x16', 'x17', 'x18',
      'x19', 'x20', 'x21', 'x22', 'x23', 'x24', 'x25', 'x26', 'x27', 'x28', 'x29', 'x30', 'xzr', 'wzr', 'lr', 'pc', 'fp',
      'w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7',
      'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 's0', 's1', 'ra', 'gp', 'tp', 'zero',
    ],
    nasmDirectives: [
      'section', 'segment', 'global', 'extern', 'bits', 'org', 'db', 'dw', 'dd', 'dq', 'dt', 'do', 'dy', 'resb', 'resw', 'resd', 'resq',
      'times', 'equ', 'default', 'rel', 'abs', 'align', 'alignb', 'struc', 'endstruc', 'istruc', 'iend', 'at', 'incbin', 'use16', 'use32', 'use64',
    ],
    sizes: ['byte', 'word', 'dword', 'qword', 'tword', 'oword', 'yword', 'zword', 'ptr', 'near', 'far', 'short', 'strict'],
    tokenizer: {
      root: [
        [/^\s*[#%]\s*\w+.*$/, 'keyword.directive'],                // %define / #include / %macro
        [/(;|#|\/\/|@ ).*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/^\s*[A-Za-z_.$][\w.$]*:/, 'type.identifier'],             // label:
        [/^\s*\d+:/, 'type.identifier'],                             // local numeric label
        [/\.[A-Za-z_]\w*/, 'keyword.directive'],                     // .text .globl .section
        [/%[A-Za-z]\w*/, 'variable.predefined'],                     // %rax (AT&T)
        [/\$(0x[0-9a-f]+|\d+)/, 'number'],                          // $42 immediates
        [/\$[A-Za-z_]\w*/, 'number'],
        [/0x[0-9a-f_]+|0b[01_]+|[0-9][0-9a-f_]*h\b|\d+/, 'number'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/`([^`\\]|\\.)*`/, 'string'],
        [/^(\s*)([a-z][\w.]*)/, ['', 'keyword']],                    // mnemonic at line start
        [/[A-Za-z_][\w.$]*/, {
          cases: {
            '@registers': 'variable.predefined',
            '@nasmDirectives': 'keyword.directive',
            '@sizes': 'type',
            '@default': 'identifier',
          },
        }],
        [/[[\]]/, 'delimiter.bracket'],
        [/[,+\-*()]/, 'delimiter'],
      ],
      comment: [
        [/[^*/]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[*/]/, 'comment'],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration('asm', {
    comments: { lineComment: '#', blockComment: ['/*', '*/'] },
    brackets: [['[', ']'], ['(', ')']],
    autoClosingPairs: [{ open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"' }, { open: "'", close: "'" }],
  });

  // ---------- Makefile ----------
  monaco.languages.register({ id: 'makefile', filenames: ['Makefile', 'makefile', 'GNUmakefile'], extensions: ['.mk', '.mak'], aliases: ['Makefile'] });
  monaco.languages.setMonarchTokensProvider('makefile', {
    keywords: ['ifeq', 'ifneq', 'ifdef', 'ifndef', 'else', 'endif', 'include', '-include', 'sinclude', 'define', 'endef', 'export', 'unexport', 'override', 'vpath'],
    tokenizer: {
      root: [
        [/#.*$/, 'comment'],
        [/^\t/, '', '@recipe'],
        [/^\s*(\.PHONY|\.SUFFIXES|\.DEFAULT|\.PRECIOUS|\.SILENT)\b/, 'keyword.directive'],
        [/^\s*[\w./%$(){}-]+(?=\s*::?(?!=))/, 'type.identifier'],     // target:
        [/^\s*([\w.-]+)(\s*)(:=|\?=|\+=|::=|=)/, ['variable', '', 'operator']],
        { include: '@vars' },
        [/[A-Za-z_-]+/, { cases: { '@keywords': 'keyword', '@default': '' } }],
        [/"[^"]*"|'[^']*'/, 'string'],
      ],
      recipe: [
        [/$/, '', '@pop'],
        [/#.*$/, 'comment'],
        [/^[@-]+/, 'keyword'],
        { include: '@vars' },
        [/"[^"]*"|'[^']*'/, 'string'],
        [/[^$"'#]+/, ''],
      ],
      vars: [
        [/\$[@<^?*+%|]/, 'variable.predefined'],
        [/\$\((\w+)\s/, 'keyword'],                                  // $(wildcard ...
        [/\$[({][\w.-]+[)}]/, 'variable'],
        [/\$\$\w+/, 'variable'],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration('makefile', { comments: { lineComment: '#' } });

  // ---------- Linker scripts ----------
  monaco.languages.register({ id: 'linkerscript', extensions: ['.ld', '.lds'], aliases: ['Linker Script'] });
  monaco.languages.setMonarchTokensProvider('linkerscript', {
    keywords: ['ENTRY', 'SECTIONS', 'MEMORY', 'OUTPUT_FORMAT', 'OUTPUT_ARCH', 'INPUT', 'GROUP', 'OUTPUT', 'SEARCH_DIR', 'STARTUP',
      'PROVIDE', 'PROVIDE_HIDDEN', 'KEEP', 'ALIGN', 'SIZEOF', 'ADDR', 'LOADADDR', 'AT', 'ORIGIN', 'LENGTH', 'ASSERT', 'DEFINED', 'PHDRS',
      'FILL', 'NOLOAD', 'INCLUDE', 'HIDDEN', 'SORT', 'BYTE', 'SHORT', 'LONG', 'QUAD'],
    tokenizer: {
      root: [
        [/\/\*/, 'comment', '@comment'],
        [/[A-Z_]+(?=\s*\()|\b[A-Z_]{2,}\b/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
        [/\.[\w.]+/, 'type.identifier'],
        [/0x[0-9a-fA-F]+[KM]?|\d+[KM]?/, 'number'],
        [/"[^"]*"/, 'string'],
      ],
      comment: [[/[^*/]+/, 'comment'], [/\*\//, 'comment', '@pop'], [/[*/]/, 'comment']],
    },
  });
}

// Map a filename to a Monaco language id.
/* exported languageForFile */
function languageForFile(name) {
  const lower = name.toLowerCase();
  const byName = {
    makefile: 'makefile', gnumakefile: 'makefile', dockerfile: 'dockerfile', 'cmakelists.txt': 'plaintext',
    '.bashrc': 'shell', '.bash_profile': 'shell', '.profile': 'shell', '.zshrc': 'shell', '.bash_aliases': 'shell',
    pkgbuild: 'shell', '.gitignore': 'plaintext', 'cargo.lock': 'ini',
  };
  if (byName[lower]) return byName[lower];
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : '';
  const byExt = {
    '.c': 'c', '.h': 'c',
    '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.c++': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp', '.inl': 'cpp', '.ipp': 'cpp', '.tpp': 'cpp',
    '.s': 'asm', '.asm': 'asm', '.nasm': 'asm', '.inc': 'asm',
    '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.ksh': 'shell',
    '.rs': 'rust', '.py': 'python', '.pyw': 'python', '.pyi': 'python',
    '.md': 'markdown', '.markdown': 'markdown', '.mdx': 'markdown',
    '.json': 'json', '.jsonc': 'json', '.toml': 'ini', '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini',
    '.yml': 'yaml', '.yaml': 'yaml', '.xml': 'xml', '.html': 'html', '.htm': 'html', '.css': 'css',
    '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.ts': 'typescript', '.lua': 'lua', '.go': 'go',
    '.mk': 'makefile', '.mak': 'makefile', '.ld': 'linkerscript', '.lds': 'linkerscript',
    '.sql': 'sql', '.diff': 'plaintext', '.patch': 'plaintext', '.java': 'java', '.cmake': 'plaintext',
  };
  return byExt[ext] || 'plaintext';
}

// Detect language from a shebang when the file has no useful extension.
/* exported languageFromShebang */
function languageFromShebang(firstLine) {
  if (!firstLine.startsWith('#!')) return null;
  if (/\b(ba|z|k|da)?sh\b/.test(firstLine)) return 'shell';
  if (/python/.test(firstLine)) return 'python';
  if (/node/.test(firstLine)) return 'javascript';
  return null;
}
