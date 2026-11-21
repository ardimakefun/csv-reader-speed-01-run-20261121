// l1c — Faster drop-in for csv-reader 1.0.0 (pure JS, no closures).
// Built on l1b: keeps global lookahead, 64 KB block fast path, and packed arrays,
// while moving hot loop state to register-resident locals in run(), inlining clean
// quoted/unquoted fields directly on `text` with cached `nextComma` (no nested
// SlicedString, no unbounded indexOf, no speculative row re-parsing), avoiding
// wasted lastIndexOf / 1-line block splits, and removing redundant scans/regex in
// the slow field helpers.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

// Module-level transfer state used ONLY when a truly slow field occurs
// (escaped "", multiline quote, CR inside quote, unterminated_quote, quote_junk, stray_cr).
let sText = '';
let sN = 0;
let sErrors = null;
let sPos = 0;
let sLine = 1;
let sSegEnd = -1;
let sNextCR = -1;
let sNextComma = -1;
let sNextQuote = -1;
let sRecordLine = 1;
let sRecordRow = null;
let fValue = '';
let fEnded = END;
let fAdded = 0;

function scanUnquotedSlow(init) {
  let v = init;
  let added = 0;
  if (sSegEnd < sPos) {
    sSegEnd = sText.indexOf('\n', sPos);
    if (sSegEnd === -1) sSegEnd = sN;
  }
  for (;;) {
    if (sNextComma < sPos) {
      sNextComma = sText.indexOf(',', sPos);
      if (sNextComma === -1) sNextComma = sN;
    }
    if (sNextCR < sPos) {
      sNextCR = sText.indexOf('\r', sPos);
      if (sNextCR === -1) sNextCR = sN;
    }
    const d = sNextComma < sSegEnd ? sNextComma : sSegEnd;
    if (d < sNextCR || sNextCR === sN) {
      if (d > sPos) {
        v += sText.slice(sPos, d);
        added += d - sPos;
      }
      if (d >= sN) {
        sPos = sN;
        fValue = v;
        fEnded = END;
        fAdded = added;
        return;
      }
      if (sNextComma < sSegEnd) {
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
    // sPos <= sNextCR < d is guaranteed.
    if (sNextCR === d - 1 && d < sN && sSegEnd <= sNextComma) {
      if (sNextCR > sPos) {
        v += sText.slice(sPos, sNextCR);
        added += sNextCR - sPos;
      }
      sPos = d + 1;
      sLine += 1;
      fValue = v;
      fEnded = LINE_BREAK;
      fAdded = added;
      return;
    }
    sErrors.push({ code: 'stray_cr', line: sRecordLine, row: sRecordRow });
    if (sNextCR > sPos) {
      v += sText.slice(sPos, sNextCR);
      added += sNextCR - sPos;
    }
    sPos = sNextCR + 1;
  }
}

function scanQuotedSlow(q) {
  const open = sPos;
  const openLine = sLine;
  sPos = open + 1;
  let v = '';
  for (;;) {
    if (q === -1) {
      sPos = open + 1;
      sLine = openLine;
      sSegEnd = -1;
      sNextComma = -1;
      sNextCR = -1;
      sNextQuote = -1;
      sErrors.push({ code: 'unterminated_quote', line: sRecordLine, row: sRecordRow });
      scanUnquotedSlow('"');
      return;
    }
    if (sSegEnd < sPos) {
      sSegEnd = sText.indexOf('\n', sPos);
      if (sSegEnd === -1) sSegEnd = sN;
    }
    if (sNextCR < sPos) {
      sNextCR = sText.indexOf('\r', sPos);
      if (sNextCR === -1) sNextCR = sN;
    }
    if (q < sSegEnd && q < sNextCR) {
      if (q > sPos) v += sText.slice(sPos, q);
    } else if (q < sNextCR) {
      // Contains LF(s) but no CR: count LF directly and advance sSegEnd past q.
      let nl = 0;
      let idx = sSegEnd;
      for (;;) {
        nl += 1;
        idx = sText.indexOf('\n', idx + 1);
        if (idx === -1) {
          sSegEnd = sN;
          break;
        }
        if (idx >= q) {
          sSegEnd = idx;
          break;
        }
      }
      sLine += nl;
      if (q > sPos) v += sText.slice(sPos, q);
    } else {
      const seg = sText.slice(sPos, q);
      const rep = seg.replace(/\r\n?/g, '\n');
      let nl = 0;
      let idx = -1;
      while ((idx = rep.indexOf('\n', idx + 1)) !== -1) nl++;
      sLine += nl;
      if (nl > 0) sSegEnd = -1;
      v += rep;
    }
    if (sText.charCodeAt(q + 1) === 34) {
      v += '"';
      sPos = q + 2;
      q = sText.indexOf('"', sPos);
      continue;
    }
    sPos = q + 1;
    break;
  }
  if (sPos >= sN) {
    fValue = v;
    fEnded = END;
    fAdded = 0;
    return;
  }
  const c = sText.charCodeAt(sPos);
  if (c === 44) {
    sPos += 1;
    fValue = v;
    fEnded = COMMA;
    fAdded = 0;
    return;
  }
  if (c === 10) {
    sPos += 1;
    sLine += 1;
    fValue = v;
    fEnded = LINE_BREAK;
    fAdded = 0;
    return;
  }
  if (c === 13 && sText.charCodeAt(sPos + 1) === 10) {
    sPos += 2;
    sLine += 1;
    fValue = v;
    fEnded = LINE_BREAK;
    fAdded = 0;
    return;
  }
  scanUnquotedSlow(v);
  if (fAdded > 0) sErrors.push({ code: 'quote_junk', line: sRecordLine, row: sRecordRow });
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
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
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

    let segEnd = text.indexOf('\n', pos);
    if (segEnd === -1) segEnd = n;

    // Block fast path: only when >= 2 complete clean LF lines fit before safeLimit.
    const safeLimit = nextQuote < nextCR ? nextQuote : nextCR;
    if (segEnd < safeLimit && safeLimit - pos >= 256) {
      const cap = pos + 65536;
      const limit = safeLimit < cap ? safeLimit : cap;
      if (segEnd < limit) {
        const blockEnd = text.lastIndexOf('\n', limit - 1);
        if (blockEnd > segEnd) {
          const lines = text.slice(pos, blockEnd).split('\n');
          const len = lines.length;
          let i = 0;
          if (width < 0) {
            const first = lines[0].split(',');
            width = first.length;
            if (header) {
              columns = first;
            } else {
              rows.push(first);
            }
            line += 1;
            i = 1;
          }
          for (; i < len; i++) {
            const lineStr = lines[i];
            if (lineStr.length === 0) {
              line += 1;
              continue;
            }
            const fields = lineStr.split(',');
            const flen = fields.length;
            if (flen !== width) {
              const rRow = rows.length;
              if (flen < width) {
                errors.push({ code: 'short_row', line, row: rRow, fields: flen });
                while (fields.length < width) fields.push('');
              } else {
                errors.push({ code: 'long_row', line, row: rRow, extra: fields.splice(width) });
              }
            }
            rows.push(fields);
            line += 1;
          }
          pos = blockEnd + 1;
          continue;
        }
      }
    }

    const contentEnd = nextCR === segEnd - 1 && segEnd < n ? segEnd - 1 : segEnd;
    let fields;
    let recordLine = line;
    if (nextQuote >= segEnd && nextCR >= contentEnd) {
      fields = text.slice(pos, contentEnd).split(',');
      if (segEnd < n) {
        pos = segEnd + 1;
        line += 1;
      } else {
        pos = n;
      }
    } else {
      const recordRow = width < 0 && header ? null : rows.length;
      const f = [];
      let lastQuoted = false;
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
            if (c === 13 && text.charCodeAt(after + 1) === 10) {
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
          sNextQuote = nextQuote;
          sRecordLine = recordLine;
          sRecordRow = recordRow;
          scanQuotedSlow(q);
          pos = sPos;
          line = sLine;
          segEnd = sSegEnd;
          nextCR = sNextCR;
          nextComma = sNextComma;
          nextQuote = sNextQuote;
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
          sRecordLine = recordLine;
          sRecordRow = recordRow;
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
          if (nextCR < pos) {
            nextCR = text.indexOf('\r', pos);
            if (nextCR === -1) nextCR = n;
          }
        }
      }
      if (f.length === 1 && f[0] === '' && !lastQuoted) continue;
      fields = f;
    }

    if (width < 0) {
      width = fields.length;
      if (header) {
        columns = fields;
        continue;
      }
    }
    const flen = fields.length;
    if (flen !== width) {
      const rRow = rows.length;
      if (flen < width) {
        errors.push({ code: 'short_row', line: recordLine, row: rRow, fields: flen });
        while (fields.length < width) fields.push('');
      } else {
        errors.push({ code: 'long_row', line: recordLine, row: rRow, extra: fields.splice(width) });
      }
    }
    rows.push(fields);
  }

  sText = '';
  sErrors = null;
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
