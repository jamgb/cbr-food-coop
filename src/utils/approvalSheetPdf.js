export function buildApprovalSheetText ({
  selected,
  signedby1,
  signedby2,
  notes,
  generatedAt = new Date()
}) {
  const generatedLabel = generatedAt.toLocaleString()
  const selectedMembers = selected && selected.length
    ? selected.map(member => `- ${member.name} (${member.email || 'no email'})`).join('\n')
    : '- No members selected'

  return [
    'CBR Food Coop - Approval Sheet',
    `Generated: ${generatedLabel}`,
    '',
    'Selected Members:',
    selectedMembers,
    '',
    `Signed by 1: ${signedby1 || 'Pending'}`,
    `Signed by 2: ${signedby2 || 'Pending'}`,
    `Notes: ${notes || ''}`
  ].join('\n')
}

export async function downloadApprovalSheetAsPdf ({
  content,
  title = 'Approval Sheet',
  fileName = 'approval-sheet.pdf'
}) {
  const { jsPDF: JsPDF } = await import('jspdf')

  const doc = new JsPDF({ unit: 'pt', format: 'a4' })
  const margin = 40
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const maxWidth = pageWidth - (margin * 2)
  const lineHeight = 14
  const lines = doc.splitTextToSize(content, maxWidth)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(11)
  doc.setProperties({ title })

  let y = margin
  for (const line of lines) {
    if (y > pageHeight - margin) {
      doc.addPage()
      y = margin
    }
    doc.text(line, margin, y)
    y += lineHeight
  }

  doc.save(fileName)

  return true
}
