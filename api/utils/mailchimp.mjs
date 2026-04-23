import crypto from 'crypto'

/**
 * Format date for Mailchimp (YYYY-MM-DD)
 */
export function formatDateForMailchimp (dateString) {
  if (!dateString) return ''
  const date = new Date(dateString)
  return date.toISOString().split('T')[0]
}

/**
 * Calculate days until/since expiry
 */
export function calculateDaysLeft (expiryDate) {
  if (!expiryDate) return null
  return Math.floor((new Date(expiryDate) - new Date()) / (1000 * 60 * 60 * 24))
}

/**
 * Generate MD5 hash for email (used by Mailchimp)
 */
export function emailHash (email) {
  return crypto
    .createHash('md5')
    .update(email.toLowerCase())
    .digest('hex')
}

/**
 * Determine tags for a new signup member
 * @param {object} member - Member data
 * @param {object} membership - Membership data
 * @returns {Array<string>} Array of tag names
 */
export function determineSignupTags (member, membership) {
  const tags = ['new_signup']

  // Add provisional tag if not approved
  if (!member.is_approved) {
    tags.push('Provisional')
  }

  // Add concession tag if applicable
  if (member.concession_type) {
    tags.push(String(member.concession_type))
  }

  // Add membership status tag (new signups are always Active)
  tags.push('Active')

  // Add unclaimed first shop tag (new signups haven't shopped yet)
  tags.push('Unclaimed First Shop')

  return tags
}
