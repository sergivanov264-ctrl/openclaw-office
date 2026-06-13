// Real port scan via `ss -ltnp`. Maps well-known ports to service names.
// Status:
//   safe    — listening only on loopback (127.0.0.1 / [::1])
//   warning — DB ports (mysql/postgres/redis/mongo/elasticsearch) on 0.0.0.0
//   danger  — DB ports on 0.0.0.0 (mongo/redis/mysql + couchdb), no auth assumed
//
// Only listening TCP sockets; udp / non-listening sockets ignored.

import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const pexec = promisify(exec)

const SERVICE_BY_PORT = {
  22: 'SSH',
  80: 'HTTP',
  443: 'HTTPS',
  53: 'DNS',
  21: 'FTP',
  25: 'SMTP',
  3306: 'MySQL',
  5432: 'PostgreSQL',
  6379: 'Redis',
  27017: 'MongoDB',
  9200: 'Elasticsearch',
  5984: 'CouchDB',
  11211: 'Memcached',
  9092: 'Kafka',
  2181: 'Zookeeper',
  4200: 'OpenClaw Office',
  18789: 'OpenClaw Gateway',
  3000: 'Node.js',
  8000: 'HTTP-alt',
  8080: 'HTTP-alt',
  8443: 'HTTPS-alt',
  5000: 'HTTP-alt',
  3389: 'RDP',
  5900: 'VNC',
  55543: 'SSH (hardened)',
  631: 'CUPS',
  14200: 'Office tunnel',
}

const DANGER_DB_PORTS = new Set([27017, 6379, 11211])     // обычно без auth по дефолту
const WARNING_DB_PORTS = new Set([3306, 5432, 9200, 5984])

function classify(port, addr) {
  const isPublic = !addr.startsWith('127.') && !addr.startsWith('[::1]') && !addr.startsWith('::1')
  if (!isPublic) return 'safe'
  if (DANGER_DB_PORTS.has(port)) return 'danger'
  if (WARNING_DB_PORTS.has(port)) return 'warning'
  return 'safe'
}

function parseSsOutput(text) {
  const lines = text.split('\n').filter(Boolean)
  const rows = []
  const seen = new Set()
  for (const line of lines) {
    if (!line.startsWith('LISTEN')) continue
    const parts = line.trim().split(/\s+/)
    const local = parts[3] || ''
    const idx = local.lastIndexOf(':')
    if (idx < 0) continue
    const addr = local.slice(0, idx)
    const portStr = local.slice(idx + 1)
    const port = parseInt(portStr, 10)
    if (!Number.isFinite(port)) continue
    const key = `${addr}:${port}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({
      port,
      service: SERVICE_BY_PORT[port] || 'Unknown',
      address: `${addr}:${port}`,
      status: classify(port, addr),
    })
  }
  rows.sort((a, b) => a.port - b.port)
  return rows
}

export async function GET() {
  try {
    const { stdout } = await pexec('ss -ltn 2>/dev/null', { timeout: 5000 })
    const ports = parseSsOutput(stdout)
    const counts = ports.reduce(
      (acc, p) => ({
        safe: acc.safe + (p.status === 'safe' ? 1 : 0),
        warning: acc.warning + (p.status === 'warning' ? 1 : 0),
        danger: acc.danger + (p.status === 'danger' ? 1 : 0),
      }),
      { safe: 0, warning: 0, danger: 0 },
    )
    const total = ports.length || 1
    const healthScore = Math.max(0, Math.round(100 - (counts.warning * 8 + counts.danger * 25) * (5 / total)))
    return Response.json({
      ports,
      counts,
      healthScore: Math.min(100, healthScore),
      scannedAt: new Date().toISOString(),
    })
  } catch (err) {
    return Response.json({ error: String(err?.message || err), ports: [] }, { status: 500 })
  }
}
