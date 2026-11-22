// A Level-1 CSV reader for csv-reader-speed-01, written fresh in this
// session (2026-11-22) as a clean-room reimplementation of the documented
// Level-1 design. It answers exactly what csv-reader 1.0.0 answers for an
// input {text, header}: {columns, rows, errors} under make.fun's broken-row
// policy. Nothing here is copied from any earlier solve.js; the behavior
// was derived from the reference program and the design notes, and is
// checked against the reference by the edge / differential / fuzz batteries.
//
// The policy, as the reference reads it:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is
//     no record;
//   - outside a quoted field a CR not followed by LF is dropped
//     (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it one quote and each CRLF or lone CR inside it
//     read as LF; what follows its closing quote, up to the next comma or
//     line break, is appended as it stands (quote_junk, when the field
//     ends); a quote that never closes is a literal character, and the
//     text after it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows
//     holds the records after it (every record when header is false), each
//     padded with "" (short_row, with fields: its count) or cut (long_row,
//     with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record
//     starts on (every LF, CRLF and lone CR inside a quoted field
//     counted), row its record's index in rows (null for the header), in
//     the order met, a field's quote_junk when the field ends and a
//     record's short_row or long_row when the record ends.
//
// Speed comes from the three documented Level-1 ideas. (1) Cached
// lookahead: the positions of the next '"', CR and comma live in module
// variables and are recomputed only once the cached value falls behind
// the cursor, so the clean-record test is two integer comparisons and an
// unquoted field's comma search never runs past its line end (without
// that bound, a single-column input of quoted or CR-carrying fields
// would rescan to the end of the text per field). (2) Block path: where
// there is no '"' and no CR for a stretch, up to 64 KB of clean LF lines
// are sliced and split in one go, letting the engine's native split do
// the line breaking instead of one indexOf + slice per record in JS.
// (3) The width test is fields.length !== width first, so the common
// case is a single comparison. Field lists are built with [] + push
// (packed arrays, cheaper to access and to stringify than pre-sized
// holey ones). Parse state lives in module variables reset by run() on
// every call, and the two field readers are top-level functions, not
// closures. Pure: no clock, no randomness, no locale, nothing kept from
// one call to the next.

// How a field ended: at a comma (the record goes on), at a line break, or
// at the end of the text (the record ends).
const END_COMMA = 0;
const END_BREAK = 1;
const END_EOF = 2;

// Shared parse state, reset by run() on every call.
let src = '';
let srcLen = 0;
let pos = 0;
let lineNo = 1;
let errs = [];
let outRows = [];
let outCols = null;
let rowWidth = -1;
// The record being read: the line it starts on and its index in rows
// (null while the header is being read).
let recLineNo = 1;
let recRowIdx = null;
// Result slots of the field just read.
let fieldVal = '';
let fieldEnd = END_EOF;
let fieldAdded = 0;
// End of the current record's line: the index of its LF, or srcLen.
let lineEnd = -1;
// Cached positions of the next '"' / CR / ',' at or after pos (srcLen
// when there is none). Recomputed only while the cached value is behind
// pos; reset to -1 in run() and on the unterminated-quote rewind, where
// the cursor moves backwards and every cached position goes stale.
let nextDquote = -1;
let nextCR = -1;
let nextComma = -1;

function pushErr(code) {
  errs.push({ code, line: recLineNo, row: recRowIdx });
}

// Reads an unquoted field starting at pos, appending onto `seed`: a CR
// not followed by LF is dropped (stray_cr) and scanning continues after
// it. Sets fieldVal / fieldEnd / fieldAdded. The comma search is bounded
// by lineEnd through the cached nextComma, so it never scans past the
// line end.
function readPlain(seed) {
  let v = seed;
  let added = 0;
  if (lineEnd === -1) {
    lineEnd = src.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = srcLen;
  }
  for (;;) {
    if (nextComma < pos) {
      nextComma = src.indexOf(',', pos);
      if (nextComma === -1) nextComma = srcLen;
    }
    if (nextCR < pos) {
      nextCR = src.indexOf('\r', pos);
      if (nextCR === -1) nextCR = srcLen;
    }
    const cut = nextComma < lineEnd ? nextComma : lineEnd;
    const piece = src.slice(pos, cut);
    // When the cut falls before the next CR the piece cannot hold one:
    // skip the indexOf('\r') scan entirely.
    const crAt = cut < nextCR ? -1 : piece.indexOf('\r');
    if (crAt === -1) {
      if (piece.length !== 0) {
        v += piece;
        added += piece.length;
      }
      if (cut >= srcLen) {
        pos = srcLen;
        fieldVal = v;
        fieldEnd = END_EOF;
        fieldAdded = added;
        return;
      }
      if (src.charCodeAt(cut) === 44) {
        pos = cut + 1;
        fieldVal = v;
        fieldEnd = END_COMMA;
        fieldAdded = added;
        return;
      }
      pos = cut + 1;
      lineNo += 1;
      fieldVal = v;
      fieldEnd = END_BREAK;
      fieldAdded = added;
      return;
    }
    if (crAt === piece.length - 1 && cut < srcLen && src.charCodeAt(cut) === 10) {
      // The piece ends with the CR of a CRLF line ending.
      if (crAt !== 0) {
        v += piece.slice(0, crAt);
        added += crAt;
      }
      pos = cut + 1;
      lineNo += 1;
      fieldVal = v;
      fieldEnd = END_BREAK;
      fieldAdded = added;
      return;
    }
    pushErr('stray_cr');
    if (crAt !== 0) {
      v += piece.slice(0, crAt);
      added += crAt;
    }
    pos = pos + crAt + 1;
  }
}

// Reads a quoted field whose opening quote is at pos. Sets fieldVal /
// fieldEnd / fieldAdded (the junk characters appended after the closing
// quote, if any).
function readQuoted() {
  const openAt = pos;
  const openLine = lineNo;
  pos += 1;
  let v = '';
  // One-step fast path: the next quote closes a clean field. lineEnd and
  // nextCR are made fresh first so the test is reliable; a stale value
  // only disables the fast path, it never misfires. The quote must close
  // before the line end (so no newline inside) and before the next CR
  // (so no CR inside), and the character after it must not be another
  // quote (so it is a real closing quote, not the first half of a ""
  // pair). Then the content is one slice, no loop.
  if (lineEnd === -1) {
    lineEnd = src.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = srcLen;
  }
  if (nextCR < pos) {
    nextCR = src.indexOf('\r', pos);
    if (nextCR === -1) nextCR = srcLen;
  }
  let q = src.indexOf('"', pos);
  if (q !== -1 && q < lineEnd && q < nextCR && src.charCodeAt(q + 1) !== 34) {
    v = src.slice(pos, q);
    pos = q + 1;
  } else {
    for (;;) {
      if (q === -1) {
        // The quote never closes: rewind and re-read as unquoted. The
        // cursor moves backwards, so every cached position goes stale:
        // reset them all to -1 (nextDquote in particular must be -1,
        // not srcLen, or the main loop would believe there is no quote
        // until the end of the text).
        pos = openAt + 1;
        lineNo = openLine;
        lineEnd = -1;
        nextComma = -1;
        nextCR = -1;
        nextDquote = -1;
        pushErr('unterminated_quote');
        readPlain('"');
        return;
      }
      const chunk = src.slice(pos, q);
      if (chunk.indexOf('\n') === -1 && chunk.indexOf('\r') === -1) {
        v += chunk;
      } else {
        const flat = chunk.replace(/\r\n?/g, '\n');
        let nl = 0;
        let at = -1;
        while ((at = flat.indexOf('\n', at + 1)) !== -1) nl++;
        lineNo += nl;
        if (nl > 0) lineEnd = -1;
        v += flat;
      }
      if (src.charCodeAt(q + 1) === 34) {
        v += '"';
        pos = q + 2;
        q = src.indexOf('"', pos);
        continue;
      }
      pos = q + 1;
      break;
    }
  }
  if (pos >= srcLen) {
    fieldVal = v;
    fieldEnd = END_EOF;
    fieldAdded = 0;
    return;
  }
  const c = src.charCodeAt(pos);
  if (c === 44) {
    pos += 1;
    fieldVal = v;
    fieldEnd = END_COMMA;
    fieldAdded = 0;
    return;
  }
  if (c === 10) {
    pos += 1;
    lineNo += 1;
    fieldVal = v;
    fieldEnd = END_BREAK;
    fieldAdded = 0;
    return;
  }
  if (c === 13 && src.charCodeAt(pos + 1) === 10) {
    pos += 2;
    lineNo += 1;
    fieldVal = v;
    fieldEnd = END_BREAK;
    fieldAdded = 0;
    return;
  }
  readPlain(v);
  if (fieldAdded > 0) pushErr('quote_junk');
}

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  src = String(input.text);
  const wantHeader = input.header === true;
  errs = [];
  outRows = [];
  outCols = null;
  rowWidth = -1;
  srcLen = src.length;
  pos = 0;
  lineNo = 1;
  if (srcLen > 0 && src.charCodeAt(0) === 0xFEFF) pos = 1;
  recLineNo = 1;
  recRowIdx = null;
  fieldVal = '';
  fieldEnd = END_EOF;
  fieldAdded = 0;
  lineEnd = -1;
  nextDquote = -1;
  nextCR = -1;
  nextComma = -1;

  for (;;) {
    // Lines with no characters are no records.
    while (pos < srcLen) {
      const c = src.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        lineNo += 1;
      } else if (c === 13 && src.charCodeAt(pos + 1) === 10) {
        pos += 2;
        lineNo += 1;
      } else {
        break;
      }
    }
    if (pos >= srcLen) break;

    recLineNo = lineNo;
    recRowIdx = wantHeader && outCols === null ? null : outRows.length;

    if (nextDquote < pos) {
      nextDquote = src.indexOf('"', pos);
      if (nextDquote === -1) nextDquote = srcLen;
    }
    if (nextCR < pos) {
      nextCR = src.indexOf('\r', pos);
      if (nextCR === -1) nextCR = srcLen;
    }

    // Block fast path: no '"' and no CR ahead, so a stretch of clean LF
    // lines. Take up to 64 KB, cut it at the last complete line, and let
    // one split('\n') break the lines instead of one indexOf + slice per
    // record in JS. The 64 KB cap keeps the temporary array small. Only
    // enter it for a meaningful clean stretch (>= 256 chars): when the
    // file uses CRLF or almost every row carries a quote, the clean end
    // sits close to pos and the lastIndexOf call on every row is wasted
    // overhead.
    const cleanEnd = nextDquote < nextCR ? nextDquote : nextCR;
    if (cleanEnd - pos >= 256) {
      const cap = pos + 65536;
      const bound = cleanEnd < cap ? cleanEnd : cap;
      const cutAt = src.lastIndexOf('\n', bound - 1);
      if (cutAt > pos) {
        const blockLines = src.slice(pos, cutAt).split('\n');
        for (let i = 0; i < blockLines.length; i++) {
          const ln = blockLines[i];
          if (ln.length === 0) {
            lineNo += 1;
            continue;
          }
          const flds = ln.split(',');
          if (rowWidth < 0) rowWidth = flds.length;
          if (wantHeader && outCols === null) {
            outCols = flds;
            lineNo += 1;
            continue;
          }
          const fl = flds.length;
          if (fl !== rowWidth) {
            const rr = outRows.length;
            if (fl < rowWidth) {
              errs.push({ code: 'short_row', line: lineNo, row: rr, fields: fl });
              while (flds.length < rowWidth) flds.push('');
            } else {
              errs.push({ code: 'long_row', line: lineNo, row: rr, extra: flds.splice(rowWidth) });
            }
          }
          outRows.push(flds);
          lineNo += 1;
        }
        pos = cutAt + 1;
        continue;
      }
    }

    // Single-line fast path (also catches a clean CRLF line): the
    // lookahead says no '"' before the line end and no CR before the
    // content end.
    lineEnd = src.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = srcLen;
    let bodyEnd = lineEnd;
    if (lineEnd < srcLen && lineEnd > pos && src.charCodeAt(lineEnd - 1) === 13) bodyEnd = lineEnd - 1;
    let flds;
    let lastWasQuoted = false;
    if (nextDquote >= lineEnd && nextCR >= bodyEnd) {
      flds = src.slice(pos, bodyEnd).split(',');
      if (lineEnd < srcLen) {
        pos = lineEnd + 1;
        lineNo += 1;
      } else {
        pos = srcLen;
      }
    } else {
      // Packed array via push (vs a pre-sized array, which is holey).
      const acc = [];
      let how;
      do {
        if (src.charCodeAt(pos) === 34) {
          lastWasQuoted = true;
          readQuoted();
        } else {
          lastWasQuoted = false;
          readPlain('');
        }
        acc.push(fieldVal);
        how = fieldEnd;
      } while (how === END_COMMA);
      flds = acc;
    }

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (flds.length === 1 && flds[0] === '' && !lastWasQuoted) continue;

    if (rowWidth < 0) rowWidth = flds.length;
    if (wantHeader && outCols === null) {
      outCols = flds;
      continue;
    }
    const fl = flds.length;
    if (fl !== rowWidth) {
      if (fl < rowWidth) {
        errs.push({ code: 'short_row', line: recLineNo, row: recRowIdx, fields: fl });
        while (flds.length < rowWidth) flds.push('');
      } else {
        errs.push({ code: 'long_row', line: recLineNo, row: recRowIdx, extra: flds.splice(rowWidth) });
      }
    }
    outRows.push(flds);
  }

  return { columns: wantHeader ? (outCols ?? []) : null, rows: outRows, errors: errs };
}
