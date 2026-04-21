const fs = require('fs');
const bytes = fs.readFileSync('app/dashboard/page.tsx');
let text = bytes.toString('utf8');

// These comment separators are ─ (U+2500 BOX DRAWINGS LIGHT HORIZONTAL)
// encoded as UTF-8 (e2 94 80) then misread as latin1 giving Ã¢ââ¬
// After our previous fix pass they may appear as various forms
// Replace any run of the broken sequence with clean dashes
text = text.replace(/[\u00c3][\u00a2][\u00e2][\u0080][\u0094][\u00e2][\u0080][\u0094]/g, '──');
text = text.replace(/[Ã][¢][â][€]["][â][€]["]/g, '──');

// Simpler: just replace all comment separator lines with plain dashes
text = text.replace(/\/\/ [^\n]*Load peer counts[^\n]*/g, '// ── Load peer counts ──────────────────────────────────────────────────────────────────');
text = text.replace(/\/\/ [^\n]*Network status[^\n]*/g, '// ── Network status ──────────────────────────────────────────────────────────────────────');
text = text.replace(/\/\/ [^\n]*Load profile[^\n]*/g, '// ── Load profile ────────────────────────────────────────────────────────────────────────');
text = text.replace(/\/\/ [^\n]*Poll desktop[^\n]*/g, '// ── Poll desktop state + refresh profile from DB ──────────────────────────────────────');
text = text.replace(/\/\/ [^\n]*Share toggle[^\n]*/g, '// ── Share toggle ────────────────────────────────────────────────────────────────────────');
text = text.replace(/\/\/ [^\n]*Connect[^\n]*──/g, '// ── Connect ─────────────────────────────────────────────────────────────────────────────');

// Nuclear option: replace any line that is purely a comment with mojibake chars
// Match lines like:  // Ã¢... text ...Ã¢...
text = text.replace(/\/\/ [\u00c0-\u00ff][\u00c0-\u00ff][^\n]*([\u00c0-\u00ff][\u00c0-\u00ff]){3,}[^\n]*/g, (match) => {
  // Extract the label between the garbage
  const clean = match.replace(/[\u00c0-\u00ff]+/g, '').replace(/\s+/g, ' ').trim();
  return '// ' + clean;
});

fs.writeFileSync('app/dashboard/page.tsx', text, 'utf8');
console.log('done');
