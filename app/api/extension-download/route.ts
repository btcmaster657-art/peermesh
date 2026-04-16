import { NextResponse } from 'next/server'
import { readFile, readdir, stat } from 'fs/promises'
import { join } from 'path'

// Simple ZIP builder without external dependencies
// Uses the ZIP local file header format

function uint32LE(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n, 0)
  return b
}
function uint16LE(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n, 0)
  return b
}

function crc32(buf: Buffer): number {
  const table = makeCRCTable()
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF]
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

let _crcTable: number[] | null = null
function makeCRCTable(): number[] {
  if (_crcTable) return _crcTable
  _crcTable = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    _crcTable[n] = c
  }
  return _crcTable
}

async function getAllFiles(dir: string, base: string): Promise<{ path: string; data: Buffer }[]> {
  const entries = await readdir(dir)
  const files: { path: string; data: Buffer }[] = []
  for (const entry of entries) {
    const full = join(dir, entry)
    const rel = base ? `${base}/${entry}` : entry
    const s = await stat(full)
    if (s.isDirectory()) {
      files.push(...await getAllFiles(full, rel))
    } else {
      files.push({ path: rel, data: await readFile(full) })
    }
  }
  return files
}

function buildZip(files: { path: string; data: Buffer }[]): Buffer {
  const localHeaders: Buffer[] = []
  const centralHeaders: Buffer[] = []
  let offset = 0

  for (const file of files) {
    const name = Buffer.from(file.path)
    const crc = crc32(file.data)
    const size = file.data.length

    // Local file header
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4B, 0x03, 0x04]), // signature
      uint16LE(20),       // version needed
      uint16LE(0),        // flags
      uint16LE(0),        // compression (stored)
      uint16LE(0),        // mod time
      uint16LE(0),        // mod date
      uint32LE(crc),
      uint32LE(size),
      uint32LE(size),
      uint16LE(name.length),
      uint16LE(0),        // extra field length
      name,
      file.data,
    ])
    localHeaders.push(local)

    // Central directory header
    const central = Buffer.concat([
      Buffer.from([0x50, 0x4B, 0x01, 0x02]), // signature
      uint16LE(20),       // version made by
      uint16LE(20),       // version needed
      uint16LE(0),        // flags
      uint16LE(0),        // compression
      uint16LE(0),        // mod time
      uint16LE(0),        // mod date
      uint32LE(crc),
      uint32LE(size),
      uint32LE(size),
      uint16LE(name.length),
      uint16LE(0),        // extra
      uint16LE(0),        // comment
      uint16LE(0),        // disk start
      uint16LE(0),        // internal attr
      uint32LE(0),        // external attr
      uint32LE(offset),   // local header offset
      name,
    ])
    centralHeaders.push(central)
    offset += local.length
  }

  const centralDir = Buffer.concat(centralHeaders)
  const centralSize = centralDir.length

  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4B, 0x05, 0x06]), // signature
    uint16LE(0),                             // disk number
    uint16LE(0),                             // central dir disk
    uint16LE(files.length),
    uint16LE(files.length),
    uint32LE(centralSize),
    uint32LE(offset),
    uint16LE(0),                             // comment length
  ])

  return Buffer.concat([...localHeaders, centralDir, eocd])
}

export async function GET() {
  try {
    const extDir = join(process.cwd(), 'extension')
    const files = await getAllFiles(extDir, 'peermesh-extension')

    // Inject production API URL into popup.js and service-worker.js
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
    const relayUrl = process.env.NEXT_PUBLIC_RELAY_ENDPOINT ?? 'ws://localhost:8080'

    const processedFiles = files.map(f => {
      if (f.path.endsWith('popup.js') || f.path.endsWith('service-worker.js')) {
        let content = f.data.toString('utf-8')
        content = content.replace(
          "const API = 'http://localhost:3000'",
          `const API = '${appUrl}'`
        )
        content = content.replace(
          "const RELAY_WS = 'ws://localhost:8080'",
          `const RELAY_WS = '${relayUrl}'`
        )
        return { path: f.path, data: Buffer.from(content, 'utf-8') }
      }
      return f
    })

    const zip = buildZip(processedFiles)

    return new NextResponse(zip, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="peermesh-extension.zip"',
        'Content-Length': String(zip.length),
      },
    })
  } catch (err) {
    console.error('Extension download error:', err)
    return NextResponse.json({ error: 'Failed to build extension' }, { status: 500 })
  }
}
