import type { LineRange } from './types.ts'

export function parseLineSpec(spec: string): LineRange {
  if (!spec || spec.trim() === '') {
    throw new Error('Line spec cannot be empty')
  }

  const trimmed = spec.trim()

  if (trimmed.startsWith('-')) {
    throw new Error('Line numbers must be positive')
  }

  const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/)

  if (rangeMatch) {
    const start = Number.parseInt(rangeMatch[1], 10)
    const end = Number.parseInt(rangeMatch[2], 10)

    if (start <= 0 || end <= 0) {
      throw new Error('Line numbers must be positive')
    }

    if (start > end) {
      throw new Error(`Invalid range: start (${start}) must be <= end (${end})`)
    }

    return { start, end }
  }

  const singleMatch = trimmed.match(/^(\d+)$/)

  if (singleMatch) {
    const line = Number.parseInt(singleMatch[1], 10)

    if (line <= 0) {
      throw new Error('Line numbers must be positive')
    }

    return { start: line, end: line }
  }

  throw new Error(`Invalid line spec: "${spec}". Use "10" for a single line or "10-20" for a range`)
}

export function parseLineSpecs(specs: string[]): LineRange[] {
  if (!specs || specs.length === 0) {
    throw new Error('At least one line spec is required')
  }

  return specs.map(parseLineSpec)
}
