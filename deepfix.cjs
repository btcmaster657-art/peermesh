const fs = require('fs');

// Read raw bytes
const bytes = fs.readFileSync('app/dashboard/page.tsx');
let text = bytes.toString('utf8');

// The file has been UTF-8 encoded multiple times. 
// We need to iteratively decode latin1->utf8 until stable.
function tryDecode(str) {
  try {
    const buf = Buffer.from(str, 'latin1');
    const decoded = buf.toString('utf8');
    // Only accept if it reduced the high-byte count
    const before = (str.match(/[\u0080-\u00ff]/g) || []).length;
    const after = (decoded.match(/[\u0080-\u00ff]/g) || []).length;
    if (after < before) return decoded;
  } catch(e) {}
  return null;
}

// Keep decoding until stable
let prev = '';
let current = text;
let passes = 0;
while (current !== prev && passes < 5) {
  prev = current;
  const attempt = tryDecode(current);
  if (attempt) { current = attempt; passes++; }
  else break;
}

console.log('Passes:', passes);

// Strip BOM if present
if (current.charCodeAt(0) === 0xFEFF) current = current.slice(1);

// Replace any remaining box-drawing comment lines with plain dashes
current = current.replace(/\/\/([ \t]+)([^\u0000-\u007f\n]+)([^\n]*)/g, (match, sp, garbage, rest) => {
  // Extract readable ASCII words from the garbage
  const words = rest.replace(/[^\u0020-\u007e]/g, ' ').replace(/\s+/g, ' ').trim();
  return '//' + sp + words;
});

fs.writeFileSync('app/dashboard/page.tsx', current, 'utf8');
console.log('Done. First 50 chars:', JSON.stringify(current.slice(0, 50)));
