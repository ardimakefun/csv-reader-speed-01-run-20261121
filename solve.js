// solve.js — Pure JS drop-in replacement for csv-reader 1.0.0 (make.fun csv-reader-speed-01).
//
// Designed specifically for Node 22/26 V8 multi-threaded `cpu_us` under --no-incremental-marking
// and fresh-process mixed-shape execution:
//   1. Zero temporary `lines` array / `lineStr` allocations in clean stretches: eliminates the
//      64 KB block split('\n') nursery churn of l1b/l1c that triggered parallel V8 Scavenger GC
//      threads (counted in cpu_us) and slowed JSON.stringify.
//   2. Small, monomorphic per-width clean-stretch helpers (`cleanNoComma`, `cleanW2`, `cleanW3`,
//      `cleanW4`, `cleanGeneral`): each is ~20-30 lines with tiny stack frames, so V8 compiles
//      only the helper(s) actually used by each case with ZERO cross-case deopt/recompile storms
//      (unlike l1c's 250-line monolithic run()).
//   3. Unified LF + CRLF fast path guarded by `segEnd < nextQuote`: both LF and CRLF clean files
//      stay in the fast path, while quoted/mimic rows pay zero wasted calls or duplicate scans.
//   4. Fixed-width array literals (`[a]`, `[a, b]`, `[a, b, c]`, `[a, b, c, d]`): single
//      PACKED_ELEMENTS allocation per row, zero array growth, zero `.split(',')` calls.
//   5. Forwarded lookahead (`segEnd`, `nextCR`, `nextComma`) into compact `parseSlowRecord`:
//      eliminates redundant per-line indexOf rescans on quoted/broken/mimic workloads.
//   6. Always returns PACKED_ELEMENTS row arrays (never holey `new Array(width)`) for fast V8
//      JSON.stringify serialization.
//   7. Pure, deterministic, stdlib-only JS (no dependencies, no WASM, no native addons).

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

// Module-level transfer state set once per run() and cleared before returning.
let sText = '';
let sN = 0;
let sErrors = null;
let sPos = 0;
let sLine = 1;
let sSegEnd = -1;
let sNextCR = -1;
let sNextComma = -1;
let sRewound = false;
let sRecordLine = 1;
let sRecordRow = null;
let fValue = '';
let fEnded = END;
let fAdded = 0;

function scanUnquotedSlow(init) {
  let v = init;
  let added = 0;
  let pos = sPos;
  const text = sText;
  const n = sN;
  let segEnd = sSegEnd;
  if (segEnd < pos) {
    segEnd = text.indexOf('\n', pos);
    if (segEnd === -1) segEnd = n;
  }
  let nextCR = sNextCR;
  let nextComma = sNextComma;

  for (;;) {
    if (nextComma < pos) {
      nextComma = text.indexOf(',', pos);
      if (nextComma === -1) nextComma = n;
    }
    if (nextCR < pos) {
      nextCR = text.indexOf('\r', pos);
      if (nextCR === -1) nextCR = n;
    }
    const d = nextComma < segEnd ? nextComma : segEnd;
    if (d < nextCR || nextCR === n) {
      if (d > pos) {
        const seg = text.slice(pos, d);
        v = v.length === 0 ? seg : v + seg;
        added += d - pos;
      }
      sSegEnd = segEnd;
      sNextCR = nextCR;
      sNextComma = nextComma;
      if (d >= n) {
        sPos = n;
        fValue = v;
        fEnded = END;
        fAdded = added;
        return;
      }
      if (nextComma < segEnd) {
        sPos = d + 1;
        fValue = v;
        fEnded = COMMA;
        fAdded = added;
        return;
      }
      sPos = d + 1;
      sLine += 1;
      fValue = v;
      fEnded = LINE_BREAK;
      fAdded = added;
      return;
    }
    // pos <= nextCR < d is guaranteed.
    if (nextCR === d - 1 && d < n && segEnd <= nextComma) {
      if (nextCR > pos) {
        const seg = text.slice(pos, nextCR);
        v = v.length === 0 ? seg : v + seg;
        added += nextCR - pos;
      }
      sPos = d + 1;
      sLine += 1;
      sSegEnd = segEnd;
      sNextCR = nextCR;
      sNextComma = nextComma;
      fValue = v;
      fEnded = LINE_BREAK;
      fAdded = added;
      return;
    }
    sErrors.push({ code: 'stray_cr', line: sRecordLine, row: sRecordRow });
    if (nextCR > pos) {
      const seg = text.slice(pos, nextCR);
      v = v.length === 0 ? seg : v + seg;
      added += nextCR - pos;
    }
    pos = nextCR + 1;
  }
}

function scanQuotedSlow(firstQ) {
  const text = sText;
  const n = sN;
  const open = sPos;
  const openLine = sLine;
  let pos = open + 1;
  let q = firstQ;
  let segEnd = sSegEnd;
  let nextCR = sNextCR;
  let v = '';

  for (;;) {
    if (q === -1) {
      sPos = open + 1;
      sLine = openLine;
      sSegEnd = -1;
      sNextCR = -1;
      sNextComma = -1;
      sRewound = true;
      sErrors.push({ code: 'unterminated_quote', line: sRecordLine, row: sRecordRow });
      scanUnquotedSlow('"');
      return;
    }
    if (segEnd < pos) {
      segEnd = text.indexOf('\n', pos);
      if (segEnd === -1) segEnd = n;
    }
    if (nextCR < pos) {
      nextCR = text.indexOf('\r', pos);
      if (nextCR === -1) nextCR = n;
    }
    if (q < segEnd && q < nextCR) {
      if (q > pos) {
        const seg = text.slice(pos, q);
        v = v.length === 0 ? seg : v + seg;
      }
    } else if (q < nextCR) {
      let nl = 0;
      let idx = segEnd;
      for (;;) {
        nl += 1;
        idx = text.indexOf('\n', idx + 1);
        if (idx === -1) {
          segEnd = n;
          break;
        }
        if (idx >= q) {
          segEnd = idx;
          break;
        }
      }
      sLine += nl;
      if (q > pos) {
        const seg = text.slice(pos, q);
        v = v.length === 0 ? seg : v + seg;
      }
    } else {
      // Contains CR (CRLF and lone CR each become one LF). No regex overhead.
      let cur = pos;
      let nr = nextCR;
      let nn = segEnd < q ? segEnd : q;
      let nl = 0;
      while (cur < q) {
        if (nr < q && nr < nn) {
          if (nr > cur) v += text.slice(cur, nr);
          v += '\n';
          nl += 1;
          cur = nr + 1;
          if (cur < q && text.charCodeAt(cur) === 10) {
            cur += 1;
            if (nn < cur) {
              nn = text.indexOf('\n', cur);
              if (nn === -1 || nn > q) nn = q;
            }
          }
          nr = text.indexOf('\r', cur);
          if (nr === -1 || nr > q) nr = q;
        } else if (nn < q) {
          nl += 1;
          if (nr >= q) {
            let idx = nn;
            while ((idx = text.indexOf('\n', idx + 1)) !== -1 && idx < q) nl++;
            v += text.slice(cur, q);
            cur = q;
            break;
          }
          nn = text.indexOf('\n', nn + 1);
          if (nn === -1 || nn > q) nn = q;
        } else {
          v += text.slice(cur, q);
          cur = q;
        }
      }
      sLine += nl;
      if (nl > 0) segEnd = -1;
      nextCR = -1;
    }

    if (q + 1 < n && text.charCodeAt(q + 1) === 34) {
      v += '"';
      pos = q + 2;
      q = text.indexOf('"', pos);
      continue;
    }
    pos = q + 1;
    break;
  }

  sPos = pos;
  sSegEnd = segEnd;
  sNextCR = nextCR;
  if (pos >= n) {
    fValue = v;
    fEnded = END;
    fAdded = 0;
    return;
  }
  const c = text.charCodeAt(pos);
  if (c === 44) {
    sPos = pos + 1;
    fValue = v;
    fEnded = COMMA;
    fAdded = 0;
    return;
  }
  if (c === 10) {
    sPos = pos + 1;
    sLine += 1;
    fValue = v;
    fEnded = LINE_BREAK;
    fAdded = 0;
    return;
  }
  if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
    sPos = pos + 2;
    sLine += 1;
    fValue = v;
    fEnded = LINE_BREAK;
    fAdded = 0;
    return;
  }
  scanUnquotedSlow(v);
  if (fAdded > 0) sErrors.push({ code: 'quote_junk', line: sRecordLine, row: sRecordRow });
}

function parseSlowRecord(pos, line, segEnd, nextCR, nextComma) {
  const text = sText;
  const n = sN;
  const f = [];
  let lastQuoted = false;
  sRewound = false;

  for (;;) {
    if (pos < n && text.charCodeAt(pos) === 34) {
      const start = pos + 1;
      const q = text.indexOf('"', start);
      if (q !== -1 && q < segEnd && q < nextCR) {
        const after = q + 1;
        if (after >= n) {
          f.push(start === q ? '' : text.slice(start, q));
          lastQuoted = true;
          pos = n;
          break;
        }
        const c = text.charCodeAt(after);
        if (c === 44) {
          f.push(start === q ? '' : text.slice(start, q));
          pos = after + 1;
          continue;
        }
        if (c === 10) {
          f.push(start === q ? '' : text.slice(start, q));
          lastQuoted = true;
          pos = after + 1;
          line += 1;
          break;
        }
        if (c === 13 && after + 1 < n && text.charCodeAt(after + 1) === 10) {
          f.push(start === q ? '' : text.slice(start, q));
          lastQuoted = true;
          pos = after + 2;
          line += 1;
          break;
        }
      }
      sPos = pos;
      sLine = line;
      sSegEnd = segEnd;
      sNextCR = nextCR;
      sNextComma = nextComma;
      scanQuotedSlow(q);
      pos = sPos;
      line = sLine;
      segEnd = sSegEnd;
      nextCR = sNextCR;
      nextComma = sNextComma;
      f.push(fValue);
      if (fEnded !== COMMA) {
        lastQuoted = true;
        break;
      }
      if (segEnd < pos) {
        segEnd = text.indexOf('\n', pos);
        if (segEnd === -1) segEnd = n;
      }
      if (nextCR < pos) {
        nextCR = text.indexOf('\r', pos);
        if (nextCR === -1) nextCR = n;
      }
    } else {
      if (nextComma < pos) {
        nextComma = text.indexOf(',', pos);
        if (nextComma === -1) nextComma = n;
      }
      if (nextComma < segEnd) {
        if (nextComma < nextCR) {
          f.push(pos === nextComma ? '' : text.slice(pos, nextComma));
          pos = nextComma + 1;
          continue;
        }
      } else if (segEnd < nextCR || nextCR === n) {
        f.push(pos === segEnd ? '' : text.slice(pos, segEnd));
        lastQuoted = false;
        if (segEnd < n) {
          pos = segEnd + 1;
          line += 1;
        } else {
          pos = n;
        }
        break;
      } else if (nextCR === segEnd - 1 && segEnd < n) {
        f.push(pos === nextCR ? '' : text.slice(pos, nextCR));
        lastQuoted = false;
        pos = segEnd + 1;
        line += 1;
        break;
      }
      sPos = pos;
      sLine = line;
      sSegEnd = segEnd;
      sNextCR = nextCR;
      sNextComma = nextComma;
      scanUnquotedSlow('');
      pos = sPos;
      line = sLine;
      segEnd = sSegEnd;
      nextCR = sNextCR;
      nextComma = sNextComma;
      f.push(fValue);
      if (fEnded !== COMMA) {
        lastQuoted = false;
        break;
      }
      if (segEnd < pos) {
        segEnd = text.indexOf('\n', pos);
        if (segEnd === -1) segEnd = n;
      }
      if (nextCR < pos) {
        nextCR = text.indexOf('\r', pos);
        if (nextCR === -1) nextCR = n;
      }
    }
  }
  sPos = pos;
  sLine = line;
  sNextCR = nextCR;
  sNextComma = nextComma;
  fAdded = lastQuoted ? 1 : 0;
  return f;
}

function fixWidth(fields, width, recordLine, rows, errors) {
  const flen = fields.length;
  const rRow = rows.length;
  if (flen < width) {
    errors.push({ code: 'short_row', line: recordLine, row: rRow, fields: flen });
    while (fields.length < width) fields.push('');
  } else {
    errors.push({ code: 'long_row', line: recordLine, row: rRow, extra: fields.splice(width) });
  }
}

// Small, independent, monomorphic clean-stretch helpers (LF + CRLF).
// Keeping each width in its own tiny function eliminates cross-case V8 deopt/recompile storms.

function cleanNoComma(p, nl, nextQuote, nextCR, line, rows) {
  const text = sText;
  const n = sN;
  for (;;) {
    const end = (nl > p && text.charCodeAt(nl - 1) === 13) ? nl - 1 : nl;
    if (nextCR < p) {
      nextCR = text.indexOf('\r', p);
      if (nextCR === -1) nextCR = n;
    }
    if (nextCR < end) break;
    if (end > p) rows.push([text.slice(p, end)]);
    p = nl + 1;
    line += 1;
    if (p >= nextQuote) break;
    nl = text.indexOf('\n', p);
    if (nl === -1 || nl >= nextQuote) break;
  }
  sPos = p;
  sLine = line;
  sNextCR = nextCR;
}

function cleanW1(p, nl, nextQuote, nextCR, line, rows) {
  const text = sText;
  const n = sN;
  const errors = sErrors;
  for (;;) {
    const end = (nl > p && text.charCodeAt(nl - 1) === 13) ? nl - 1 : nl;
    if (nextCR < p) {
      nextCR = text.indexOf('\r', p);
      if (nextCR === -1) nextCR = n;
    }
    if (nextCR < end) break;
    if (end > p) {
      const c1 = text.indexOf(',', p);
      if (c1 === -1 || c1 >= end) {
        rows.push([text.slice(p, end)]);
      } else {
        const fields = text.slice(p, end).split(',');
        fixWidth(fields, 1, line, rows, errors);
        rows.push(fields);
      }
    }
    p = nl + 1;
    line += 1;
    if (p >= nextQuote) break;
    nl = text.indexOf('\n', p);
    if (nl === -1 || nl >= nextQuote) break;
  }
  sPos = p;
  sLine = line;
  sNextCR = nextCR;
}

function cleanW2(p, nl, nextQuote, nextCR, line, rows) {
  const text = sText;
  const n = sN;
  const errors = sErrors;
  for (;;) {
    const end = (nl > p && text.charCodeAt(nl - 1) === 13) ? nl - 1 : nl;
    if (nextCR < p) {
      nextCR = text.indexOf('\r', p);
      if (nextCR === -1) nextCR = n;
    }
    if (nextCR < end) break;
    if (end > p) {
      const c1 = text.indexOf(',', p);
      if (c1 !== -1 && c1 < end) {
        const c2 = text.indexOf(',', c1 + 1);
        if (c2 === -1 || c2 >= end) {
          rows.push([
            p === c1 ? '' : text.slice(p, c1),
            c1 + 1 === end ? '' : text.slice(c1 + 1, end),
          ]);
          p = nl + 1;
          line += 1;
          if (p >= nextQuote) break;
          nl = text.indexOf('\n', p);
          if (nl === -1 || nl >= nextQuote) break;
          continue;
        }
      }
      const fields = text.slice(p, end).split(',');
      if (fields.length !== 2) fixWidth(fields, 2, line, rows, errors);
      rows.push(fields);
    }
    p = nl + 1;
    line += 1;
    if (p >= nextQuote) break;
    nl = text.indexOf('\n', p);
    if (nl === -1 || nl >= nextQuote) break;
  }
  sPos = p;
  sLine = line;
  sNextCR = nextCR;
}

function cleanW3(p, nl, nextQuote, nextCR, line, rows) {
  const text = sText;
  const n = sN;
  const errors = sErrors;
  for (;;) {
    const end = (nl > p && text.charCodeAt(nl - 1) === 13) ? nl - 1 : nl;
    if (nextCR < p) {
      nextCR = text.indexOf('\r', p);
      if (nextCR === -1) nextCR = n;
    }
    if (nextCR < end) break;
    if (end > p) {
      const c1 = text.indexOf(',', p);
      if (c1 !== -1 && c1 < end) {
        const c2 = text.indexOf(',', c1 + 1);
        if (c2 !== -1 && c2 < end) {
          const c3 = text.indexOf(',', c2 + 1);
          if (c3 === -1 || c3 >= end) {
            rows.push([
              p === c1 ? '' : text.slice(p, c1),
              c1 + 1 === c2 ? '' : text.slice(c1 + 1, c2),
              c2 + 1 === end ? '' : text.slice(c2 + 1, end),
            ]);
            p = nl + 1;
            line += 1;
            if (p >= nextQuote) break;
            nl = text.indexOf('\n', p);
            if (nl === -1 || nl >= nextQuote) break;
            continue;
          }
        }
      }
      const fields = text.slice(p, end).split(',');
      if (fields.length !== 3) fixWidth(fields, 3, line, rows, errors);
      rows.push(fields);
    }
    p = nl + 1;
    line += 1;
    if (p >= nextQuote) break;
    nl = text.indexOf('\n', p);
    if (nl === -1 || nl >= nextQuote) break;
  }
  sPos = p;
  sLine = line;
  sNextCR = nextCR;
}

function cleanW4(p, nl, nextQuote, nextCR, line, rows) {
  const text = sText;
  const n = sN;
  const errors = sErrors;
  for (;;) {
    const end = (nl > p && text.charCodeAt(nl - 1) === 13) ? nl - 1 : nl;
    if (nextCR < p) {
      nextCR = text.indexOf('\r', p);
      if (nextCR === -1) nextCR = n;
    }
    if (nextCR < end) break;
    if (end > p) {
      const c1 = text.indexOf(',', p);
      if (c1 !== -1 && c1 < end) {
        const c2 = text.indexOf(',', c1 + 1);
        if (c2 !== -1 && c2 < end) {
          const c3 = text.indexOf(',', c2 + 1);
          if (c3 !== -1 && c3 < end) {
            const c4 = text.indexOf(',', c3 + 1);
            if (c4 === -1 || c4 >= end) {
              rows.push([
                p === c1 ? '' : text.slice(p, c1),
                c1 + 1 === c2 ? '' : text.slice(c1 + 1, c2),
                c2 + 1 === c3 ? '' : text.slice(c2 + 1, c3),
                c3 + 1 === end ? '' : text.slice(c3 + 1, end),
              ]);
              p = nl + 1;
              line += 1;
              if (p >= nextQuote) break;
              nl = text.indexOf('\n', p);
              if (nl === -1 || nl >= nextQuote) break;
              continue;
            }
          }
        }
      }
      const fields = text.slice(p, end).split(',');
      if (fields.length !== 4) fixWidth(fields, 4, line, rows, errors);
      rows.push(fields);
    }
    p = nl + 1;
    line += 1;
    if (p >= nextQuote) break;
    nl = text.indexOf('\n', p);
    if (nl === -1 || nl >= nextQuote) break;
  }
  sPos = p;
  sLine = line;
  sNextCR = nextCR;
}

function cleanGeneral(p, nl, nextQuote, nextCR, line, width, rows) {
  const text = sText;
  const n = sN;
  const errors = sErrors;
  for (;;) {
    const end = (nl > p && text.charCodeAt(nl - 1) === 13) ? nl - 1 : nl;
    if (nextCR < p) {
      nextCR = text.indexOf('\r', p);
      if (nextCR === -1) nextCR = n;
    }
    if (nextCR < end) break;
    if (end > p) {
      const fields = text.slice(p, end).split(',');
      if (fields.length !== width) fixWidth(fields, width, line, rows, errors);
      rows.push(fields);
    }
    p = nl + 1;
    line += 1;
    if (p >= nextQuote) break;
    nl = text.indexOf('\n', p);
    if (nl === -1 || nl >= nextQuote) break;
  }
  sPos = p;
  sLine = line;
  sNextCR = nextCR;
}

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;
  let pos = n > 0 && text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  let line = 1;
  let nextQuote = -1;
  let nextCR = -1;
  let nextComma = -1;

  sText = text;
  sN = n;
  sErrors = errors;

  for (;;) {
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c > 13) break;
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    if (nextQuote < pos) {
      nextQuote = text.indexOf('"', pos);
      if (nextQuote === -1) nextQuote = n;
    }
    if (nextCR < pos) {
      nextCR = text.indexOf('\r', pos);
      if (nextCR === -1) nextCR = n;
    }

    const recordLine = line;
    let segEnd = text.indexOf('\n', pos);
    if (segEnd === -1) segEnd = n;
    const contentEnd = (segEnd < n && segEnd > pos && text.charCodeAt(segEnd - 1) === 13) ? segEnd - 1 : segEnd;

    let fields;
    let lastQuoted = false;
    if (nextQuote >= segEnd && nextCR >= contentEnd) {
      if (width > 0 && segEnd < nextQuote) {
        if (width === 1) {
          if (nextComma < pos) {
            nextComma = text.indexOf(',', pos);
            if (nextComma === -1) nextComma = n;
          }
          if (nextComma >= nextQuote) {
            cleanNoComma(pos, segEnd, nextQuote, nextCR, line, rows);
          } else {
            cleanW1(pos, segEnd, nextQuote, nextCR, line, rows);
          }
        } else if (width === 3) {
          cleanW3(pos, segEnd, nextQuote, nextCR, line, rows);
        } else if (width === 2) {
          cleanW2(pos, segEnd, nextQuote, nextCR, line, rows);
        } else if (width === 4) {
          cleanW4(pos, segEnd, nextQuote, nextCR, line, rows);
        } else {
          cleanGeneral(pos, segEnd, nextQuote, nextCR, line, width, rows);
        }
        pos = sPos;
        line = sLine;
        nextCR = sNextCR;
        continue;
      }
      fields = text.slice(pos, contentEnd).split(',');
      if (segEnd < n) {
        pos = segEnd + 1;
        line += 1;
      } else {
        pos = n;
      }
    } else {
      sRecordLine = recordLine;
      sRecordRow = (width < 0 && header) ? null : rows.length;
      fields = parseSlowRecord(pos, line, segEnd, nextCR, nextComma);
      pos = sPos;
      line = sLine;
      nextCR = sNextCR;
      nextComma = sNextComma;
      lastQuoted = fAdded === 1;
      if (sRewound) {
        nextQuote = -1;
        nextCR = -1;
        nextComma = -1;
      }
    }

    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) {
      width = fields.length;
      if (header) {
        columns = fields;
        continue;
      }
    }
    if (fields.length !== width) fixWidth(fields, width, recordLine, rows, errors);
    rows.push(fields);
  }

  sText = '';
  sErrors = null;
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
