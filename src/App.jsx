import { useEffect, useMemo, useRef, useState } from 'react'
import Chart from 'chart.js/auto'
import './App.css'

const STORAGE_KEY = 'allocationData_v2'

const defaultMeta = {
  headers: [],
  productKey: null,
  branchKey: null,
  areaKey: null,
  itemKey: null,
  metricKey: null,
  productColumns: [],
  syntheticProduct: false,
  syntheticProductLabel: 'All Products',
  rawHeaders: [],
}

function App() {
  const [dataRows, setDataRows] = useState([])
  const [meta, setMeta] = useState(defaultMeta)
  const [filters, setFilters] = useState({
    product: '__all',
    branch: '__all',
    area: '__all',
    group: 'product',
  })
  const [chartEmpty, setChartEmpty] = useState(false)
  const [status, setStatus] = useState({
    message: 'Waiting for a CSV file.',
    isError: false,
  })

  const fileInputRef = useRef(null)
  const chartCanvasRef = useRef(null)
  const chartInstanceRef = useRef(null)

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (!saved) return
      const parsed = JSON.parse(saved)
      if (!parsed.rows || !parsed.rows.length) return
      setDataRows(parsed.rows)
      setMeta(parsed.meta || defaultMeta)
      setFilters(parsed.filters || filters)
      setStatus({
        message: `Restored ${parsed.rows.length} rows from last session.`,
        isError: false,
      })
    } catch (err) {
      console.warn('Could not restore saved data', err)
    }
  }, [])

  useEffect(() => {
    if (!dataRows.length) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ rows: dataRows, meta, filters }))
    } catch (err) {
      console.warn('Unable to persist data', err)
    }
  }, [dataRows, meta, filters])

  const productOptions = useMemo(() => uniqueValues(dataRows, 'product'), [dataRows])
  const areaOptions = useMemo(
    () => (meta.areaKey ? uniqueValues(dataRows, 'area') : []),
    [dataRows, meta.areaKey],
  )
  const branchOptions = useMemo(() => {
    if (!meta.branchKey) return []
    const scopedRows =
      filters.area === '__all' || !meta.areaKey
        ? dataRows
        : dataRows.filter((r) => r.area === filters.area)
    return uniqueValues(scopedRows, 'branch')
  }, [dataRows, filters.area, meta.areaKey, meta.branchKey])

  const groupOptions = useMemo(() => {
    const opts = [{ value: 'product', label: 'Product' }]
    if (meta.branchKey) opts.push({ value: 'branch', label: 'Branch' })
    if (meta.areaKey) opts.push({ value: 'area', label: 'Area' })
    return opts
  }, [meta.areaKey, meta.branchKey])

  useEffect(() => {
    if (!groupOptions.find((opt) => opt.value === filters.group)) {
      const fallback = groupOptions[0]?.value || 'product'
      setFilters((prev) => ({ ...prev, group: fallback }))
    }
  }, [filters.group, groupOptions])

  const filteredRows = useMemo(() => {
    return dataRows.filter((row) => {
      const productOk = filters.product === '__all' || row.product === filters.product
      const branchOk = !meta.branchKey || filters.branch === '__all' || row.branch === filters.branch
      const areaOk = !meta.areaKey || filters.area === '__all' || row.area === filters.area
      return productOk && branchOk && areaOk
    })
  }, [dataRows, filters.area, filters.branch, filters.product, meta.areaKey, meta.branchKey])

  const groupDimension =
    meta.branchKey && filters.branch !== '__all' ? 'product' : filters.group || 'product'

  const summary = useMemo(() => {
    const total = filteredRows.reduce((sum, r) => sum + r.metric, 0)
    return { rows: filteredRows.length, total }
  }, [filteredRows])

  useEffect(() => {
    const ctx = chartCanvasRef.current?.getContext('2d')
    if (!ctx) return
    const aggregated = aggregate(filteredRows, groupDimension)
    if (!aggregated.length) {
      setChartEmpty(true)
      if (chartInstanceRef.current) {
        const chart = chartInstanceRef.current
        chart.data.labels = ['No data']
        chart.data.datasets[0].label = 'No data'
        chart.data.datasets[0].data = [0]
        chart.data.datasets[0].backgroundColor = [pickColor(0)]
        chart.update()
      }
      return
    }

    setChartEmpty(false)

    const labels = aggregated.map((d) => d.label)
    const values = aggregated.map((d) => d.value)
    const colors = aggregated.map((_, idx) => pickColor(idx))

    if (chartInstanceRef.current) {
      const chart = chartInstanceRef.current
      chart.data.labels = labels
      chart.data.datasets[0].label = `Total by ${groupDimension}`
      chart.data.datasets[0].data = values
      chart.data.datasets[0].backgroundColor = colors
      chart.update()
      return
    }

    chartInstanceRef.current = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: `Total by ${groupDimension}`,
            data: values,
            backgroundColor: colors,
            borderRadius: 6,
          },
        ],
      },
      options: {
        animation: { duration: 550, easing: 'easeOutQuart' },
        transitions: {
          active: { animation: { duration: 350 } },
          resize: { animation: { duration: 150 } },
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => `${ctx.formattedValue}` } },
        },
        scales: {
          x: { grid: { color: 'rgba(0,0,0,0.04)' } },
          y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.04)' } },
        },
      },
    })

  }, [filteredRows, groupDimension])

  const handleFileChange = (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const text = e.target?.result
        const parsed = parseCsv(String(text || ''))
        if (!parsed.rows.length) {
          return setStatusState('Could not find data rows in this file.', true)
        }
        const detected = detectColumns(parsed.headers, parsed.rows, parsed.rawHeaders)
        if (!detected.metricKey && !detected.productColumns.length) {
          return setStatusState('Missing required columns. Need at least one numeric column.', true)
        }
        const expandedRows = expandRows(parsed.rows, detected)
        const defaultGroup = detected.branchKey ? 'branch' : detected.areaKey ? 'area' : 'product'
        setDataRows(expandedRows)
        setMeta(detected)
        setFilters({
          product: '__all',
          branch: '__all',
          area: '__all',
          group: defaultGroup,
        })
        setStatusState(`Loaded ${expandedRows.length} rows. Grouping by ${defaultGroup}.`)
      } catch (err) {
        console.error(err)
        setStatusState('Unable to read or parse the file.', true)
      }
    }
    reader.onerror = () => setStatusState('Unable to read the file.', true)
    reader.readAsText(file)
  }

  const resetApp = () => {
    setDataRows([])
    setMeta(defaultMeta)
    setFilters({
      product: '__all',
      branch: '__all',
      area: '__all',
      group: 'product',
    })
    setStatusState('Waiting for a CSV file.')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const filterState = useMemo(() => {
    const parts = []
    if (filters.product !== '__all') parts.push(`Product: ${filters.product}`)
    if (meta.branchKey && filters.branch !== '__all') parts.push(`Branch: ${filters.branch}`)
    if (meta.areaKey && filters.area !== '__all') parts.push(`Area: ${filters.area}`)
    return parts.length ? parts.join(' | ') : 'No filters'
  }, [filters.area, filters.branch, filters.product, meta.areaKey, meta.branchKey])

  const metricLabel = meta.productColumns?.length
    ? 'Metric: product column values'
    : `Metric: ${meta.metricKey || 'first numeric column'}`

  const previewRows = filteredRows.slice(0, 10)

  const setStatusState = (message, isError = false) => setStatus({ message, isError })

  return (
    <div className="app-shell">
      <header>
        <h1>Allocation Visualizer</h1>
        <p className="lede">
          Upload a CSV file and instantly chart totals with filters per product and per branch/area.
          Columns needed: a product label, a branch or area label, and at least one numeric value.
        </p>
      </header>

      <section className="card">
        <div className="upload-row">
          <div className="file-picker">
            <label htmlFor="fileInput">Choose CSV file</label>
            <input
              id="fileInput"
              type="file"
              accept=".csv,text/csv"
              onChange={handleFileChange}
              ref={fileInputRef}
            />
          </div>
          <button className="secondary" type="button" onClick={resetApp}>
            Reset
          </button>
          <div className={`status ${status.isError ? 'error' : ''}`}>{status.message}</div>
        </div>
      </section>

      <section className="card">
        <div className="filters-grid">
          <div>
            <label htmlFor="productFilter">Product</label>
            <select
              id="productFilter"
              value={filters.product}
              onChange={(e) => setFilters((prev) => ({ ...prev, product: e.target.value }))}
              disabled={!productOptions.length}
            >
              <option value="__all">All products</option>
              {productOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="branchFilter">Branch</label>
            <select
              id="branchFilter"
              value={filters.branch}
              onChange={(e) => setFilters((prev) => ({ ...prev, branch: e.target.value }))}
              disabled={!meta.branchKey || !branchOptions.length}
            >
              <option value="__all">{meta.branchKey ? 'All branches' : 'No branch column'}</option>
              {branchOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="areaFilter">Area</label>
            <select
              id="areaFilter"
              value={filters.area}
              onChange={(e) =>
                setFilters((prev) => ({
                  ...prev,
                  area: e.target.value,
                  branch: '__all',
                }))
              }
              disabled={!meta.areaKey || !areaOptions.length}
            >
              <option value="__all">{meta.areaKey ? 'All areas' : 'No area column'}</option>
              {areaOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="groupSelect">Group chart by</label>
            <select
              id="groupSelect"
              value={filters.group}
              onChange={(e) => setFilters((prev) => ({ ...prev, group: e.target.value }))}
              disabled={!groupOptions.length}
            >
              {groupOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <section className="card chart-card">
        <div className="chart-head">
          <div className="pill">{metricLabel}</div>
          <div className="pill">{filterState}</div>
        </div>
        <div className="chart-wrap">
          <canvas ref={chartCanvasRef} height="120" />
          {chartEmpty && <div className="chart-empty">No data for current filters</div>}
        </div>
        <div className="summary">
          <strong>{summary.rows}</strong> rows | <strong>{summary.total.toLocaleString()}</strong> total
        </div>
      </section>

      <section className="card">
        <h3 style={{ margin: '0 0 8px 0' }}>Preview (first 10 rows)</h3>
        {!previewRows.length ? (
          <div className="preview-empty">No rows match your filters yet.</div>
        ) : (
          <div className="preview-table">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Branch</th>
                  <th>Area</th>
                  <th>Metric</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row, idx) => (
                  <tr key={`${row.product}-${row.branch}-${row.area}-${idx}`}>
                    <td>{row.product || '—'}</td>
                    <td>{row.branch || '—'}</td>
                    <td>{row.area || '—'}</td>
                    <td>{row.metric}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

export default App

function parseCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '')
  if (!lines.length) return { headers: [], rows: [], rawHeaders: [] }

  const delimiter = detectDelimiter(lines)
  const split = (line) => splitCsvLine(line, delimiter)
  const allCells = lines.map(split)

  let headerIdx = 0
  let maxCols = 0
  const isHeaderRow = (cells) => {
    const texty = cells.filter((c) => /[A-Za-z]/.test(c)).length
    return texty >= Math.max(2, Math.ceil(cells.length * 0.3))
  }
  for (let i = 0; i < allCells.length; i++) {
    const cells = allCells[i]
    if (isHeaderRow(cells)) {
      headerIdx = i
      maxCols = cells.length
      break
    }
    if (cells.length > maxCols) {
      maxCols = cells.length
      headerIdx = i
    }
  }

  let headerCells = allCells[headerIdx]
  const firstDataCells = allCells.slice(headerIdx + 1).find((c) => c.some((v) => v.trim() !== '')) || []
  if (headerCells[0] && headerCells[0].toLowerCase().includes('branch') && firstDataCells.length === headerCells.length + 1) {
    headerCells = ['Area', ...headerCells]
  }
  if (headerCells.length < maxCols) {
    const extras = Array.from({ length: maxCols - headerCells.length }, (_, i) => `col${headerCells.length + i + 1}`)
    headerCells = [...headerCells, ...extras]
  }

  const rawHeaders = [...headerCells]
  const headers = sanitizeHeaders(headerCells)
  const rows = []
  for (let i = headerIdx + 1; i < allCells.length; i++) {
    const cells = allCells[i]
    if (cells.every((cell) => cell.trim() === '')) continue
    const padded = [...cells]
    while (padded.length < headers.length) padded.push('')
    const row = {}
    headers.forEach((h, idx) => {
      row[h] = padded[idx] !== undefined ? padded[idx] : ''
    })
    rows.push(row)
  }
  return { headers, rows, rawHeaders }
}

function detectDelimiter(lines) {
  const firstLine = lines.find((l) => l.trim() !== '') || ''
  const commaCount = (firstLine.match(/,/g) || []).length
  const tabCount = (firstLine.match(/\t/g) || []).length
  return tabCount > commaCount ? '\t' : ','
}

function splitCsvLine(line, delimiter) {
  if (delimiter === '\t') return line.split('\t')
  const result = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
        continue
      }
      inQuotes = !inQuotes
      continue
    }
    if (ch === delimiter && !inQuotes) {
      result.push(current)
      current = ''
      continue
    }
    current += ch
  }
  result.push(current)
  return result
}

function sanitizeHeaders(headers) {
  const used = new Set()
  return headers.map((h, idx) => {
    const base = (h || '').trim() || `col${idx + 1}`
    let name = base
    let attempt = 1
    while (used.has(name.toLowerCase())) {
      name = `${base}_${attempt++}`
    }
    used.add(name.toLowerCase())
    return name
  })
}

function detectColumns(headers, rows, rawHeaders = []) {
  const lowerHeaders = headers.map((h) => h.toLowerCase())
  const rawLower = rawHeaders.map((h) => (h || '').toLowerCase())
  const findHeader = (candidates) => {
    const idx = lowerHeaders.findIndex((h) => candidates.includes(h))
    return idx >= 0 ? headers[idx] : null
  }

  const looksNumeric = (value) => {
    if (value === null || value === undefined) return false
    const cleaned = String(value).replace(/[,%]/g, '').trim()
    if (cleaned === '') return false
    return !isNaN(Number(cleaned))
  }

  const numericHeaders = headers.filter((h) => rows.some((r) => looksNumeric(r[h])))
  const productKey = findHeader(['product', 'item', 'sku', 'product name', 'material', 'pork bbq'])
  const branchKey = findHeader(['branch', 'store', 'location', 'office'])
  let areaKey = findHeader(['area', 'region', 'zone', 'territory'])
  const itemKey = findHeader(['item description', 'item', 'description', 'item desc'])

  if (!areaKey && branchKey) {
    const firstHeader = headers[0]
    const sampleValues = rows.map((r) => String(r[firstHeader] || '').trim()).filter(Boolean)
    const allNumeric = sampleValues.length > 0 && sampleValues.every((v) => looksNumeric(v))
    if (firstHeader !== branchKey && sampleValues.length > 3 && !allNumeric) {
      areaKey = firstHeader
    }
  }

  const metricKey = findHeader([
    'alloc',
    'average',
    'avg',
    'value',
    'amount',
    'metric',
    'qty',
    'quantity',
    'total',
    'sales',
    'volume',
    'pork bbq',
    'daily sales',
    'kg conversion per pc',
  ])

  const reserved = new Set(
    [productKey, branchKey, areaKey, itemKey].filter(Boolean).map((h) => h.toLowerCase()),
  )
  let productColumns = numericHeaders.filter((h) => !reserved.has(h.toLowerCase()))

  const fixedProducts = ['backribs', 'chicken paa', 'chicken pecho', 'pork bbq', 'spareribs']
  const fixedSlice = headers.slice(2, 7).filter(Boolean)
  const fixedMatch = fixedSlice.filter((h) => fixedProducts.includes(h.toLowerCase()))
  if (fixedMatch.length) {
    productColumns = fixedMatch
  } else if (productColumns.length === 0 && headers.length >= 3) {
    const start = 2
    const end = Math.min(headers.length, 7)
    const slice = headers.slice(start, end).filter((h) => h && h.trim())
    if (slice.length) productColumns = slice
  }
  const finalMetricKey = metricKey || (productColumns.length === 1 ? productColumns[0] : null)

  let syntheticProduct = false
  let syntheticProductLabel = 'All Products'
  if (!productKey && productColumns.length === 0) {
    syntheticProduct = true
    const cleanedRaw = rawHeaders.map((h) => (h || '').trim()).filter(Boolean)
    const banned = [
      'sum',
      'avg',
      'average',
      'alloc',
      'allocation',
      'conversion',
      'target',
      'total',
      'uom',
      'branch',
      'area',
      'metric',
      'value',
      'amount',
      'qty',
      'quantity',
      'sales',
      'volume',
      '%',
      'kg',
    ]
    const isProductish = (h) => {
      const l = h.toLowerCase()
      if (banned.some((b) => l.includes(b))) return false
      return true
    }
    const productish = cleanedRaw.find(isProductish)
    syntheticProductLabel = productish || 'All Products'
    if (!syntheticProductLabel && finalMetricKey) syntheticProductLabel = finalMetricKey
  }

  return {
    headers,
    productKey,
    branchKey,
    areaKey,
    itemKey,
    metricKey: finalMetricKey,
    productColumns,
    syntheticProduct,
    syntheticProductLabel,
    rawHeaders,
  }
}

function normalizeRow(row, meta) {
  const cleanText = (key) => (key ? String(row[key] ?? '').trim() : '')
  const numeric = (val) => {
    const n = Number(String(val).replace(/,/g, '').replace(/%/g, '').trim())
    return isNaN(n) ? 0 : n
  }
  const syntheticLabel = meta.syntheticProductLabel || 'All Products'
  const productValue = meta.productKey ? cleanText(meta.productKey) : syntheticLabel
  return {
    product: productValue,
    item: cleanText(meta.itemKey),
    branch: cleanText(meta.branchKey),
    area: cleanText(meta.areaKey),
    metric: numeric(meta.metricKey ? row[meta.metricKey] : 0),
  }
}

function expandRows(rows, meta) {
  const numeric = (val) => {
    const n = Number(String(val).replace(/,/g, '').replace(/%/g, '').trim())
    return isNaN(n) ? 0 : n
  }
  const cleanText = (row, key) => (key ? String(row[key] ?? '').trim() : '')

  if (meta.productColumns && meta.productColumns.length > 0) {
    const expanded = []
    rows.forEach((row) => {
      const baseArea = cleanText(row, meta.areaKey)
      const baseBranch = cleanText(row, meta.branchKey)
      const baseItem = cleanText(row, meta.itemKey)
      meta.productColumns.forEach((col) => {
        const value = numeric(row[col])
        expanded.push({
          product: col,
          item: baseItem,
          branch: baseBranch,
          area: baseArea,
          metric: value,
        })
      })
    })
    return expanded
  }

  return rows.map((r) => normalizeRow(r, meta))
}

function uniqueValues(rows, key) {
  return Array.from(new Set(rows.map((r) => r[key]).filter(Boolean))).sort()
}

function aggregate(rows, dimension) {
  const key = dimension === 'branch' ? 'branch' : dimension === 'area' ? 'area' : 'product'
  const totals = new Map()
  rows.forEach((r) => {
    const label = r[key] || 'Unspecified'
    totals.set(label, (totals.get(label) || 0) + r.metric)
  })
  return Array.from(totals.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
}

function pickColor(index) {
  const palette = ['#2f80ed', '#56ccf2', '#7bc86c', '#f2994a', '#eb5757', '#bb6bd9', '#6fcf97', '#f2c94c']
  return palette[index % palette.length]
}
