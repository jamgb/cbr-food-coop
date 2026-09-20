// Professional, table-based PDF generator for the membership approval sheet.
//
// Fonts: Lato (body) and Alex Brush (faux-signature cursive) are Google Fonts
// released under the SIL Open Font License. They are fetched at runtime from
// /fonts (see public/fonts) and embedded into the PDF so the document looks
// consistent regardless of what fonts are installed on the viewer's machine.
// If a font fails to load (e.g. offline), we fall back to jsPDF's built-in
// Helvetica face so PDF generation never breaks.

const LOGO_URL = '/icons/favicon-128x128.png'

const FONT_FILES = {
  regular: { url: '/fonts/Lato-Regular.ttf', file: 'Lato-Regular.ttf', family: 'Lato', style: 'normal' },
  bold: { url: '/fonts/Lato-Bold.ttf', file: 'Lato-Bold.ttf', family: 'Lato', style: 'bold' },
  italic: { url: '/fonts/Lato-Italic.ttf', file: 'Lato-Italic.ttf', family: 'Lato', style: 'italic' },
  signature: { url: '/fonts/AlexBrush-Regular.ttf', file: 'AlexBrush-Regular.ttf', family: 'AlexBrush', style: 'normal' }
}

const COLUMNS = [
  { key: 'name', label: 'Name', widthFraction: 0.22 },
  { key: 'email', label: 'Email', widthFraction: 0.27 },
  { key: 'postcode', label: 'Postcode', widthFraction: 0.11 },
  { key: 'signupDate', label: 'Signup Date', widthFraction: 0.15 },
  { key: 'notes', label: 'Notes', widthFraction: 0.25 }
]

const COLORS = {
  primary: [25, 118, 210], // matches $primary in quasar.variables.scss
  textMuted: [110, 110, 110],
  border: [180, 180, 180],
  zebra: [245, 247, 250],
  headerFill: [230, 236, 245]
}

async function arrayBufferToBase64 (buffer) {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

async function fetchAsBase64 (url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`)
  const buffer = await response.arrayBuffer()
  return arrayBufferToBase64(buffer)
}

// Attempts to download & register every custom font. Returns which ones
// succeeded so the rest of the document can decide what to fall back to.
async function loadFonts (doc) {
  const entries = Object.entries(FONT_FILES)
  const results = await Promise.all(entries.map(async ([key, cfg]) => {
    try {
      const base64 = await fetchAsBase64(cfg.url)
      doc.addFileToVFS(cfg.file, base64)
      doc.addFont(cfg.file, cfg.family, cfg.style)
      return [key, true]
    } catch (err) {
      console.warn(`Approval sheet PDF: could not load font "${cfg.family}" (${cfg.style}), falling back.`, err)
      return [key, false]
    }
  }))
  return Object.fromEntries(results)
}

async function loadLogo () {
  try {
    const base64 = await fetchAsBase64(LOGO_URL)
    return `data:image/png;base64,${base64}`
  } catch (err) {
    console.warn('Approval sheet PDF: could not load logo image, continuing without it.', err)
    return null
  }
}

function formatDate (value, options = { day: '2-digit', month: 'short', year: 'numeric' }) {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('en-AU', options)
}

function getMemberRow (member) {
  const name = member.name || [member.firstname, member.lastname].filter(Boolean).join(' ') || 'Unknown'
  return {
    name,
    email: member.email || '—',
    postcode: member.postal || member.postcode || '—',
    signupDate: formatDate(member.curdate),
    notes: ''
  }
}

export async function downloadApprovalSheetAsPdf ({
  selected = [],
  signedby1,
  signedby2,
  notes,
  title = 'Membership Approval Sheet',
  fileName = 'approval-sheet.pdf',
  generatedAt = new Date()
}) {
  const { jsPDF: JsPDF } = await import('jspdf')

  const doc = new JsPDF({ unit: 'pt', format: 'a4' })
  doc.setProperties({ title })

  const [fontStatus, logoDataUrl] = await Promise.all([loadFonts(doc), loadLogo()])

  // Only trust the custom Lato faces as a set - if any one of them failed to
  // load we fall back entirely to Helvetica to avoid mismatched styles.
  const latoAvailable = fontStatus.regular && fontStatus.bold && fontStatus.italic
  const fonts = {
    family: latoAvailable ? 'Lato' : 'helvetica',
    signatureFamily: fontStatus.signature ? 'AlexBrush' : (latoAvailable ? 'Lato' : 'helvetica'),
    signatureStyle: fontStatus.signature ? 'normal' : 'italic',
    signatureSize: fontStatus.signature ? 30 : 22
  }

  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 40
  const contentWidth = pageWidth - margin * 2
  const footerHeight = 28

  const columnWidths = COLUMNS.map(col => col.widthFraction * contentWidth)

  function setFont (style = 'normal', size = 10, color = [0, 0, 0]) {
    doc.setFont(fonts.family, style)
    doc.setFontSize(size)
    doc.setTextColor(...color)
  }

  function drawFooter (pageNumber, pageCount) {
    setFont('italic', 8, COLORS.textMuted)
    doc.setDrawColor(...COLORS.border)
    doc.setLineWidth(0.5)
    doc.line(margin, pageHeight - footerHeight, pageWidth - margin, pageHeight - footerHeight)
    doc.text('CBR Food Coop — Membership Approval Sheet', margin, pageHeight - footerHeight + 14)
    doc.text(`Page ${pageNumber} of ${pageCount}`, pageWidth - margin, pageHeight - footerHeight + 14, { align: 'right' })
  }

  function drawHeader () {
    let textX = margin
    const logoSize = 50
    if (logoDataUrl) {
      try {
        doc.addImage(logoDataUrl, 'PNG', margin, margin, logoSize, logoSize)
        textX = margin + logoSize + 14
      } catch (err) {
        console.warn('Approval sheet PDF: failed to draw logo image.', err)
      }
    }

    setFont('bold', 19, [30, 30, 30])
    doc.text('CBR Food Coop', textX, margin + 20)

    setFont('normal', 12, COLORS.textMuted)
    doc.text(title, textX, margin + 38)

    setFont('italic', 9, COLORS.textMuted)
    doc.text(`Generated: ${generatedAt.toLocaleString('en-AU')}`, pageWidth - margin, margin + 14, { align: 'right' })
    doc.text(`Members listed: ${selected.length}`, pageWidth - margin, margin + 28, { align: 'right' })

    const ruleY = margin + logoSize + 12
    doc.setDrawColor(...COLORS.primary)
    doc.setLineWidth(1.5)
    doc.line(margin, ruleY, pageWidth - margin, ruleY)

    return ruleY + 22
  }

  const cellPaddingX = 6
  const cellPaddingY = 6
  const headerRowHeight = 26
  const minBodyRowHeight = 30
  const tableLineHeight = 12

  function drawTableHeaderRow (y) {
    let x = margin
    doc.setFillColor(...COLORS.headerFill)
    doc.setDrawColor(...COLORS.border)
    doc.setLineWidth(0.75)
    doc.rect(margin, y, contentWidth, headerRowHeight, 'FD')
    setFont('bold', 10, [30, 30, 30])
    COLUMNS.forEach((col, i) => {
      doc.text(col.label, x + cellPaddingX, y + headerRowHeight / 2 + 3)
      x += columnWidths[i]
    })
    return y + headerRowHeight
  }

  function measureRowHeight (row) {
    setFont('normal', 9.5)
    let maxLines = 1
    COLUMNS.forEach((col, i) => {
      const value = row[col.key] || ''
      const usableWidth = columnWidths[i] - cellPaddingX * 2
      const lines = doc.splitTextToSize(String(value), usableWidth)
      maxLines = Math.max(maxLines, lines.length)
    })
    return Math.max(minBodyRowHeight, maxLines * tableLineHeight + cellPaddingY * 2)
  }

  function drawTableRow (row, y, rowHeight, isEven) {
    if (isEven) {
      doc.setFillColor(...COLORS.zebra)
      doc.rect(margin, y, contentWidth, rowHeight, 'F')
    }
    doc.setDrawColor(...COLORS.border)
    doc.setLineWidth(0.5)
    doc.rect(margin, y, contentWidth, rowHeight, 'S')

    let x = margin
    setFont('normal', 9.5, [40, 40, 40])
    COLUMNS.forEach((col, i) => {
      if (i > 0) doc.line(x, y, x, y + rowHeight)
      const value = row[col.key] || ''
      const usableWidth = columnWidths[i] - cellPaddingX * 2
      const lines = doc.splitTextToSize(String(value), usableWidth)
      doc.text(lines, x + cellPaddingX, y + cellPaddingY + 8)
      x += columnWidths[i]
    })
    return y + rowHeight
  }

  let y = drawHeader()
  y = drawTableHeaderRow(y)

  const rows = selected.length
    ? selected.map(getMemberRow)
    : []

  if (!rows.length) {
    setFont('italic', 10, COLORS.textMuted)
    doc.text('No members selected.', margin + cellPaddingX, y + 18)
    y += minBodyRowHeight
  }

  rows.forEach((row, index) => {
    const rowHeight = measureRowHeight(row)
    if (y + rowHeight > pageHeight - footerHeight - margin) {
      doc.addPage()
      y = margin
      y = drawTableHeaderRow(y)
    }
    y = drawTableRow(row, y, rowHeight, index % 2 === 1)
  })

  // --- Signature section ---
  const signatureBoxHeight = 92
  const signatureGap = 20
  const signatureSectionHeight = signatureBoxHeight + 50

  if (y + signatureSectionHeight > pageHeight - footerHeight - margin) {
    doc.addPage()
    y = margin
  } else {
    y += 26
  }

  setFont('bold', 12, [30, 30, 30])
  doc.text('Board Approval', margin, y)
  y += 14

  const boxWidth = (contentWidth - signatureGap) / 2

  function drawSignatureBox (x, roleLabel, signedName) {
    setFont('bold', 9.5, COLORS.textMuted)
    doc.text(roleLabel.toUpperCase(), x, y)

    const boxY = y + 6
    doc.setDrawColor(...COLORS.border)
    doc.setLineWidth(0.75)
    doc.rect(x, boxY, boxWidth, signatureBoxHeight, 'S')

    const baselineY = boxY + signatureBoxHeight - 34
    if (signedName) {
      doc.setFont(fonts.signatureFamily, fonts.signatureStyle)
      doc.setFontSize(fonts.signatureSize)
      doc.setTextColor(20, 40, 100)
      doc.text(signedName, x + boxWidth / 2, baselineY - 8, { align: 'center', maxWidth: boxWidth - 16 })
    } else {
      setFont('italic', 9, [190, 190, 190])
      doc.text('Signature', x + 10, baselineY - 8)
    }

    doc.setDrawColor(...COLORS.border)
    doc.setLineWidth(0.5)
    doc.line(x + 10, baselineY, x + boxWidth - 10, baselineY)

    setFont('normal', 8.5, [70, 70, 70])
    doc.text(`Name: ${signedName || '________________________'}`, x + 10, baselineY + 14)
    doc.text(`Date: ${signedName ? formatDate(generatedAt) : '____________'}`, x + 10, baselineY + 26)
  }

  drawSignatureBox(margin, 'Board Member 1 Signing', signedby1)
  drawSignatureBox(margin + boxWidth + signatureGap, 'Board Member 2 Signing', signedby2)

  y += signatureBoxHeight + 20

  // --- Notes ---
  setFont('bold', 11, [30, 30, 30])
  doc.text('Additional Notes', margin, y)
  y += 14
  setFont(notes ? 'normal' : 'italic', 9.5, notes ? [40, 40, 40] : COLORS.textMuted)
  const notesLines = doc.splitTextToSize(notes || 'None provided.', contentWidth)
  doc.text(notesLines, margin, y)

  // --- Footers on every page (needs total page count, so done last) ---
  const pageCount = doc.internal.getNumberOfPages()
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p)
    drawFooter(p, pageCount)
  }

  doc.save(fileName)

  return true
}
