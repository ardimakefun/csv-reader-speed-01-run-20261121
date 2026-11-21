// A faster drop-in for csv-reader 1.0.0 (make.fun's own CSV reader): run(input)
// returns exactly csv-reader's answer for the input {text, header}, the JSON
// value {columns, rows, errors}. It reads the same broken-row policy as the
// reference (vendor/csv-reader/index.js in the kit), but scans with indexOf
// jumps and slice() instead of one character at a time, so long plain fields
// cost one slice each and the common unquoted field never builds a string a
// character at a time. A record whose span holds no quote and no stray CR is
// split on commas in one go, and the line end found for a record is reused
// by every unquoted field on it.
//
// The policy, as the reference reads it:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it one quote and each CRLF or lone CR inside it read as LF; what
//     follows its closing quote, up to the next comma or line break, is appended
//     as it stands (quote_junk, when the field ends); a quote that never closes
//     is a literal character, and the text after it is read again as unquoted
//     (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it (every record when header is false), each padded with ""
//     (short_row, with fields: its count) or cut (long_row, with extra: the cut
//     fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts
//     on (every LF, CRLF and lone CR inside a quoted field counted), row its
//     record's index in rows (null for the header), in the order met, a field's
//     quote_junk when the field ends and a record's short_row or long_row when
//     the record ends.
//
// Design: the parse state lives in module-level variables that run() resets
// on every call, and the two field readers are top-level functions, not
// closures — the optimizing compiler sees plain module-scope variables, and
// the whole-program time measures a little faster than the closure form.
// Pure: no clock, no randomness, no locale, nothing kept from one call to the
// next. Every error a record carries names that record's start line and its
// index in rows, so the scanner tracks those two numbers per record and never
// a per-character line.

/** How a field ended: at a comma (the record goes on), at a line break or at the end of the text (the record ends). */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

// Shared parse state, reset by run() on every call.
let text = '';
let header = false;
let errors = [];
let rows = [];
let columns = null;
let width = -1;
let n = 0;
let pos = 0;
let line = 1;
let recordLine = 1;
let recordRow = null;
let fValue = '';
let fEnded = END;
let fAdded = 0;
let segEnd = -1;

// Reads an unquoted field starting at pos, appending onto `init`: a CR not
// followed by LF is dropped (stray_cr) and scanning continues after it.
// Sets fValue, fEnded, fAdded.
function scanUnquoted(init) {
  let v = init;
  let added = 0;
  if (segEnd === -1) {
    segEnd = text.indexOf('\n', pos);
    if (segEnd === -1) segEnd = n;
  }
  for (;;) {
    const dc = text.indexOf(',', pos);
    const d = dc === -1 ? segEnd : dc < segEnd ? dc : segEnd;
    const seg = text.slice(pos, d);
    const r = seg.indexOf('\r');
    if (r === -1) {
      if (seg.length !== 0) {
        v += seg;
        added += seg.length;
      }
      if (d >= n) {
        pos = n;
        fValue = v;
        fEnded = END;
        fAdded = added;
        return;
      }
      if (text.charCodeAt(d) === 44) {
        pos = d + 1;
        fValue = v;
        fEnded = COMMA;
        fAdded = added;
        return;
      }
      pos = d + 1;
      line += 1;
      fValue = v;
      fEnded = LINE_BREAK;
      fAdded = added;
      return;
    }
    if (r === seg.length - 1 && d < n && text.charCodeAt(d) === 10) {
      if (r !== 0) {
        v += seg.slice(0, r);
        added += r;
      }
      pos = d + 1;
      line += 1;
      fValue = v;
      fEnded = LINE_BREAK;
      fAdded = added;
      return;
    }
    errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
    if (r !== 0) {
      v += seg.slice(0, r);
      added += r;
    }
    pos = pos + r + 1;
  }
}

// Reads a quoted field whose opening quote is at pos. Sets fValue, fEnded,
// fAdded (the junk characters appended after the closing quote, if any).
function scanQuoted() {
  const open = pos;
  const openLine = line;
  pos += 1;
  let v = '';
  for (;;) {
    const q = text.indexOf('"', pos);
    if (q === -1) {
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      scanUnquoted('"');
      return;
    }
    const seg = text.slice(pos, q);
    if (seg.indexOf('\n') === -1 && seg.indexOf('\r') === -1) {
      v += seg;
    } else {
      const rep = seg.replace(/\r\n?/g, '\n');
      let nl = 0;
      let idx = -1;
      while ((idx = rep.indexOf('\n', idx + 1)) !== -1) nl++;
      line += nl;
      if (nl > 0) segEnd = -1;
      v += rep;
    }
    if (text.charCodeAt(q + 1) === 34) {
      v += '"';
      pos = q + 2;
      continue;
    }
    pos = q + 1;
    break;
  }
  if (pos >= n) {
    fValue = v;
    fEnded = END;
    fAdded = 0;
    return;
  }
  const c = text.charCodeAt(pos);
  if (c === 44) {
    pos += 1;
    fValue = v;
    fEnded = COMMA;
    fAdded = 0;
    return;
  }
  if (c === 10) {
    pos += 1;
    line += 1;
    fValue = v;
    fEnded = LINE_BREAK;
    fAdded = 0;
    return;
  }
  if (c === 13 && text.charCodeAt(pos + 1) === 10) {
    pos += 2;
    line += 1;
    fValue = v;
    fEnded = LINE_BREAK;
    fAdded = 0;
    return;
  }
  scanUnquoted(v);
  if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
}

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  text = String(input.text);
  header = input.header === true;
  errors = [];
  rows = [];
  columns = null;
  width = -1;
  n = text.length;
  pos = 0;
  line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;
  recordLine = 1;
  recordRow = null;
  fValue = '';
  fEnded = END;
  fAdded = 0;
  segEnd = -1;

  for (;;) {
    while (pos < n) {
      const c = text.charCodeAt(pos);
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

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    segEnd = text.indexOf('\n', pos);
    if (segEnd === -1) segEnd = n;
    let fields;
    let lastQuoted = false;
    let contentEnd = segEnd;
    if (segEnd < n && segEnd > pos && text.charCodeAt(segEnd - 1) === 13) contentEnd = segEnd - 1;
    const span = text.slice(pos, contentEnd);
    if (span.indexOf('"') === -1 && span.indexOf('\r') === -1) {
      fields = span.split(',');
      if (segEnd < n) {
        pos = segEnd + 1;
        line += 1;
      } else {
        pos = n;
      }
    } else {
      const f = width < 0 ? [] : new Array(width);
      let count = 0;
      let ended;
      do {
        if (text.charCodeAt(pos) === 34) {
          lastQuoted = true;
          scanQuoted();
        } else {
          lastQuoted = false;
          scanUnquoted('');
        }
        f[count++] = fValue;
        ended = fEnded;
      } while (ended === COMMA);
      f.length = count;
      fields = f;
    }

    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
