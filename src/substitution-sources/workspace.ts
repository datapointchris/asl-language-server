// Finds the suppliers of one definition by reading every .tf file and SAM template under the
// workspace root. Read from disk, so an unsaved edit to a .tf file is seen once it is written.

import fs from 'node:fs'
import path from 'node:path'
import { samSuppliers } from './sam.ts'
import type { Supplier } from './supplier.ts'
import { type TemplatefileCall, templatefileCalls, terraformSuppliers } from './terraform.ts'

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.terraform',
  '.terragrunt-cache',
  '.aws-sam',
  'cdk.out',
  'node_modules',
  '.venv',
  'venv',
  'dist',
  'build',
  'target',
])

// A walk of a large monorepo stops here rather than stall every request behind it.
const MAX_ENTRIES = 50_000
const LISTING_TTL_MS = 3_000

interface Listing {
  at: number
  files: string[]
}

// The parse is kept beside the text under the same mtime and size, so a lookup re-tokenizes
// only a file that changed.
interface ParsedFile {
  mtimeMs: number
  size: number
  text: string
  calls: TemplatefileCall[]
}

export class SupplierIndex {
  private listings = new Map<string, Listing>()
  private files = new Map<string, ParsedFile>()
  private log: (message: string) => void

  constructor(log: (message: string) => void) {
    this.log = log
  }

  forgetListings(): void {
    this.listings.clear()
  }

  suppliersFor(documentPath: string, root: string): Supplier[] {
    const suppliers: Supplier[] = []
    for (const file of this.candidateFiles(root)) {
      const parsed = this.read(file)
      if (parsed === undefined) continue
      if (file.endsWith('.tf')) {
        if (parsed.calls.length > 0) suppliers.push(...terraformSuppliers(parsed.calls, parsed.text, file, documentPath))
      } else suppliers.push(...samSuppliers(parsed.text, file, documentPath))
    }
    return suppliers.some((s) => s.matchedBy === 'path') ? suppliers.filter((s) => s.matchedBy === 'path') : suppliers
  }

  private candidateFiles(root: string): string[] {
    const cached = this.listings.get(root)
    if (cached && Date.now() - cached.at < LISTING_TTL_MS) return cached.files
    const files: string[] = []
    let entries = 0
    const pending = [root]
    while (pending.length > 0 && entries < MAX_ENTRIES) {
      const directory = pending.pop() as string
      let listing: fs.Dirent[]
      try {
        listing = fs.readdirSync(directory, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of listing) {
        entries++
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(path.join(directory, entry.name))
        } else if (/\.(tf|ya?ml)$/.test(entry.name) && !/\.asl\.ya?ml$/.test(entry.name)) {
          files.push(path.join(directory, entry.name))
        }
      }
    }
    if (entries >= MAX_ENTRIES) this.log(`stopped reading ${root} after ${MAX_ENTRIES} entries`)
    this.listings.set(root, { at: Date.now(), files })
    return files
  }

  private read(file: string): ParsedFile | undefined {
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      return undefined
    }
    const cached = this.files.get(file)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached
    const text = fs.readFileSync(file, 'utf8')
    const calls = file.endsWith('.tf') && text.includes('templatefile') ? templatefileCalls(text) : []
    const parsed = { mtimeMs: stat.mtimeMs, size: stat.size, text, calls }
    this.files.set(file, parsed)
    return parsed
  }
}
