import mailchimp from '@mailchimp/mailchimp_marketing'
import pg from 'pg'
import fs from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import dotenv from 'dotenv'
import { formatDateForMailchimp, calculateDaysLeft, emailHash, emailHash } from '../utils/mailchimp.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Load environment variables
dotenv.config({ path: join(__dirname, '..', '..', '.env') })

// Configuration
const config = {
  mailchimp: {
    apiKey: process.env.MAILCHIMP_API_KEY,
    server: process.env.MAILCHIMP_SERVER_PREFIX,
    listId: process.env.MAILCHIMP_LIST_ID
  },
  database: {
    connectionString: process.env.DATABASE_URL || 'postgres://postgres:Pass2021!@localhost:5432/postgres',
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
  },
  sync: {
    lookbackDays: parseInt(process.env.LOOKBACK_DAYS || '7'),
    batchSize: 500, // Mailchimp batch operations limit
    dryRun: process.env.DRY_RUN === 'true',
    maxListSize: process.env.MAILCHIMP_MAX_LIST_SIZE ? parseInt(process.env.MAILCHIMP_MAX_LIST_SIZE) : 1000
  }
}

// Initialize Mailchimp client
mailchimp.setConfig({
  apiKey: config.mailchimp.apiKey,
  server: config.mailchimp.server
})

/**
 * Get all members from Mailchimp list (with pagination)
 */
async function getAllMailchimpMembers () {
  const allMembers = []
  let offset = 0
  const count = 1000 // Max per page

  try {
    while (true) {
      const response = await mailchimp.lists.getListMembersInfo(
        config.mailchimp.listId,
        {
          count,
          offset,
          fields: ['members.email_address', 'members.status', 'members.merge_fields', 'members.tags', 'total_items']
        }
      )

      allMembers.push(...response.members)
      console.log(`Fetched ${allMembers.length} of ${response.total_items} Mailchimp members`)

      if (allMembers.length >= response.total_items) {
        break
      }

      offset += count
    }

    return allMembers
  } catch (error) {
    console.error('Failed to fetch Mailchimp members:', error)
    throw error
  }
}

/**
 * Get member data from database
 */
async function getMembersFromDatabase (lookbackDays, maxListSize = config.sync.maxListSize) {
  const client = new pg.Client({
    connectionString: config.database.connectionString,
    ssl: config.database.ssl
  })
  await client.connect()

  try {
    const sqlPath = join(__dirname, '..', '..', 'sql', 'mailchimp-export.sql')
    let sql = await fs.readFile(sqlPath, 'utf-8')

    // Replace parameters
    sql = sql.replace(':lookback_days', lookbackDays.toString()).replace(':max_list_size', maxListSize.toString())

    const result = await client.query(sql)
    console.log(`Retrieved ${result.rows.length} members from database`)
    return result.rows
  } finally {
    await client.end()
  }
}

/**
 * Determine tags for a member based on their data
 */
function determineTags (member) {
  const tags = []

  // Membership status tags
  if (member.membership_status === 'Active') {
    const daysUntilExpiry = member.expiry_date
      ? Math.floor((new Date(member.expiry_date) - new Date()) / (1000 * 60 * 60 * 24))
      : null

    if (daysUntilExpiry !== null && daysUntilExpiry < 1) {
      tags.push('Expiring Today')
    }
    if (daysUntilExpiry !== null && daysUntilExpiry < 7) {
      tags.push('Expiring This Week')
    }
    if (daysUntilExpiry !== null && daysUntilExpiry < 31) {
      tags.push('Expiring This Month')
    }
  } else if (member.membership_status === 'Expired') {
    const daysSinceExpiry = member.expiry_date
      ? Math.floor((new Date() - new Date(member.expiry_date)) / (1000 * 60 * 60 * 24))
      : null

    if (daysSinceExpiry !== null && daysSinceExpiry <= 90) {
      tags.push('Recently Expired')
    } else {
      tags.push('Expired')
    }
  }

  // Volunteer status
  if (member.last_volunteered || member.discount_status === 'Discount Active') {
    tags.push('Working Member')
  }

  // Coordinator status
  if (member.has_coordinator_account) {
    tags.push('Coordinator')
  }

  // Approval status
  if (!member.is_approved) {
    tags.push('Provisional')
  }

  // Concession status
  if (member.concession_type) {
    tags.push(String(member.concession_type))
  }

  // Discount status
  if (member.discount_status) {
    tags.push(String(member.discount_status))
  }

  if (!member.claimed_first_shop) {
    tags.push('Unclaimed First Shop')
  }
  return tags
}

/**
 * Convert member data to Mailchimp format
 * @param {object} member - Member data from database
 * @param {object} existingMailchimpMember - Existing member data from Mailchimp (if any)
 *
 * Note on join date preservation:
 * - Preserves JOINED date from Mailchimp if present (including for archived members who are unarchiving)
 * - Mailchimp preserves all member data when archiving, so unarchiving restores the join date
 * - Edge case: Members who expired long ago (outside priority list) and rejoin after initial sync
 *   may have inaccurate join dates if their original join predates the lookback window.
 */
function formatMemberForMailchimp (member, existingMailchimpMember = null) {
  const emailHash = emailHash(member.email)

  const tags = determineTags(member)

  // Preserve existing JOINED date if present in Mailchimp, otherwise use DB value
  const joinedDate = (existingMailchimpMember?.merge_fields?.JOINED && existingMailchimpMember.merge_fields.JOINED !== '')
    ? existingMailchimpMember.merge_fields.JOINED
    : (member.first_action_date ? formatDate(member.first_action_date) : '')

  // Preserve subscription status if member exists and is unsubscribed
  const status = existingMailchimpMember
    ? existingMailchimpMember.status
    : 'subscribed'

  const memberDetails = {
    email_address: member.email,
    email_hash: emailHash,
    status_if_new: 'subscribed',
    status: status, // Preserve existing status
    merge_fields: {
      FNAME: member.firstname || '',
      LNAME: member.lastname || '',
      PHONE: member.phone || '',
      SUBURB: member.suburb || '',
      MTYPE: member.membership_type || '',
      CONCESSION: member.concession_type || '',
      EXPIRY: member.expiry_date ? formatDate(member.expiry_date) : '',
      DAYSLEFT: member.expiry_date
        ? Math.floor((new Date(member.expiry_date) - new Date()) / (1000 * 60 * 60 * 24))
        : null,
      DISCEXP: member.discount_expiry ? formatDate(member.discount_expiry) : '',
      JOINED: joinedDate,
      LASTVOL: member.last_volunteered ? formatDate(member.last_volunteered) : ''
    },
    tags: tags,
    existingTags: existingMailchimpMember?.tags?.map(t => t.name) || []
  }
  return memberDetails
}

/**
 * Format date for Mailchimp (YYYY-MM-DD)
 */
function formatDate (dateString) {
  if (!dateString) return ''
  const date = new Date(dateString)
  return date.toISOString().split('T')[0]
}

/**
 * Sync unsubscribed status back to database
 */
async function syncUnsubscribesToDatabase (mailchimpMembers, dbMembers) {
  const client = new pg.Client({
    connectionString: config.database.connectionString,
    ssl: config.database.ssl
  })
  await client.connect()

  try {
    const unsubscribedEmails = mailchimpMembers
      .filter(m => m.status === 'unsubscribed')
      .map(m => m.email_address.toLowerCase())

    const dbEmailsSet = new Set(dbMembers.map(m => m.email.toLowerCase()))

    // Only update members that are in our database export
    // Note: dbMembers already excludes members with sendemails=false (filtered in SQL)
    const emailsToUpdate = unsubscribedEmails.filter(email => dbEmailsSet.has(email))

    console.log(`Found ${unsubscribedEmails.length} unsubscribed members in Mailchimp`)
    console.log(`${emailsToUpdate.length} of these are in the current database export`)

    if (emailsToUpdate.length === 0) {
      console.log('No unsubscribes to sync back to database')
      return { updated: 0 }
    }

    if (config.sync.dryRun) {
      // In dry run, query to show what would be updated
      const checkQuery = `
        SELECT COUNT(*) as count
        FROM customers c
        LEFT JOIN members_extra me ON c.id = me.id
        WHERE LOWER(TRIM(c.email)) = ANY($1::text[])
      `
      const checkResult = await client.query(checkQuery, [emailsToUpdate])
      const membersFound = parseInt(checkResult.rows[0].count)

      console.log(`DRY RUN - Would update ${membersFound} members' sendemails to false`)
      return { updated: membersFound }
    }

    // Update sendemails field in members_extra table
    const updateQuery = `
      INSERT INTO members_extra (id, sendemails)
      SELECT c.id, false
      FROM customers c
      WHERE LOWER(TRIM(c.email)) = ANY($1::text[])
      ON CONFLICT (id) DO UPDATE
      SET sendemails = false
    `

    const result = await client.query(updateQuery, [emailsToUpdate])
    console.log(`Updated ${result.rowCount} members to sendemails=false in database`)

    return { updated: result.rowCount }
  } catch (error) {
    console.error('Failed to sync unsubscribes to database:', error)
    throw error
  } finally {
    await client.end()
  }
}

/**
 * Archive members in Mailchimp who are no longer in the priority list
 */
async function archiveRemovedMembers (mailchimpMembers, dbMembers) {
  const dbEmailsSet = new Set(dbMembers.map(m => m.email.toLowerCase()))

  const membersToArchive = mailchimpMembers
    .filter(m => !dbEmailsSet.has(m.email_address.toLowerCase()))
    .filter(m => m.status !== 'archived') // Don't re-archive already archived members

  if (membersToArchive.length === 0) {
    console.log('No members to archive')
    return { archived: 0 }
  }

  console.log(`Found ${membersToArchive.length} members to archive (outside priority list)`)

  if (config.sync.dryRun) {
    console.log('DRY RUN - Would archive these members:',
      membersToArchive.slice(0, 5).map(m => m.email_address)
    )
    return { archived: membersToArchive.length }
  }

  // Archive in batches
  const batches = []
  for (let i = 0; i < membersToArchive.length; i += config.sync.batchSize) {
    batches.push(membersToArchive.slice(i, i + config.sync.batchSize))
  }

  let totalArchived = 0

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]
    const operations = batch.map(member => {
      const hash = emailHash(member.email_address)

      return {
        method: 'DELETE',
        path: `/lists/${config.mailchimp.listId}/members/${hash}`
      }
    })

    try {
      const response = await mailchimp.batches.start({ operations })
      console.log(`Archive batch ${i + 1}/${batches.length} started: ${response.id}`)

      // Wait for batch to complete
      let batchStatus
      do {
        await new Promise(resolve => setTimeout(resolve, 2000))
        batchStatus = await mailchimp.batches.status(response.id)
      } while (batchStatus.status !== 'finished')

      totalArchived += batchStatus.finished_operations - batchStatus.errored_operations
    } catch (error) {
      console.error(`Failed to archive batch ${i + 1}:`, error)
    }
  }

  console.log(`Archived ${totalArchived} members from Mailchimp`)
  return { archived: totalArchived }
}

/**
 * Sync members to Mailchimp in batches
 */
async function syncBatchToMailchimp (members) {
  const operations = members.map(member => {
    const body = {
      email_address: member.email_address,
      status_if_new: member.status_if_new,
      merge_fields: member.merge_fields,
      tags: member.tags // Always include tags, even if empty array
    }

    // Only set status if member already exists (to preserve unsubscribed status)
    if (member.status) {
      body.status = member.status
    }

    return {
      method: 'PUT',
      path: `/lists/${config.mailchimp.listId}/members/${member.email_hash}`,
      body: JSON.stringify(body)
    }
  })

  if (config.sync.dryRun) {
    console.log('DRY RUN - Would sync batch:', {
      count: members.length,
      sample: members[0]
    })
    return { success: members.length, errors: 0 }
  }

  try {
    const response = await mailchimp.batches.start({
      operations
    })

    console.log(`Batch operation started: ${response.id}`)

    // Wait for batch to complete
    let batchStatus
    do {
      await new Promise(resolve => setTimeout(resolve, 2000)) // Wait 2 seconds
      batchStatus = await mailchimp.batches.status(response.id)
      console.log(`Batch progress: ${batchStatus.finished_operations}/${batchStatus.total_operations}`)
    } while (batchStatus.status !== 'finished')

    // If there were errors, fetch and display them
    if (batchStatus.errored_operations > 0) {
      console.error(`\n (!)  ${batchStatus.errored_operations} operations failed`)

      // Download the response file to see error details
      const responseUrl = batchStatus.response_body_url
      if (responseUrl) {
        console.log(`Error details available at: ${responseUrl}`)
        console.log('Fetching error details...')

        try {
          const fetch = (await import('node-fetch')).default
          const errorResponse = await fetch(responseUrl)
          const errorData = await errorResponse.text()
          const errors = errorData.split('\n')
            .filter(line => line.trim())
            .map(line => JSON.parse(line))
            .filter(op => op.status_code !== 200)
            .slice(0, 5) // Show first 5 errors

          console.error('Sample errors:')
          errors.forEach((err, idx) => {
            console.error(`\nError ${idx + 1}:`)
            console.error(`  Email: ${err.response?.email_address || 'unknown'}`)
            console.error(`  Status: ${err.status_code}`)
            console.error(`  Title: ${err.response?.title || 'unknown'}`)
            console.error(`  Detail: ${err.response?.detail || 'unknown'}`)
          })
        } catch (fetchError) {
          console.error('Could not fetch error details:', fetchError.message)
        }
      }
    }

    return {
      success: batchStatus.finished_operations - batchStatus.errored_operations,
      errors: batchStatus.errored_operations
    }
  } catch (error) {
    console.error('Batch operation failed:', error)
    throw error
  }
}

/**
 * Main sync function
 */
async function syncMailchimp () {
  console.log('Starting Mailchimp sync...')
  console.log('Configuration:', {
    lookbackDays: config.sync.lookbackDays,
    batchSize: config.sync.batchSize,
    dryRun: config.sync.dryRun,
    maxListSize: config.sync.maxListSize
  })

  try {
    // Step 1: Get all current members from Mailchimp
    console.log('\n=== Fetching existing Mailchimp members ===')
    const mailchimpMembers = await getAllMailchimpMembers()
    const mailchimpMap = new Map(
      mailchimpMembers.map(m => [m.email_address.toLowerCase(), m])
    )
    console.log(`Found ${mailchimpMembers.length} existing members in Mailchimp`)

    // Step 2: Get priority members from database
    console.log('\n=== Fetching members from database ===')
    const dbMembers = await getMembersFromDatabase(config.sync.lookbackDays, config.sync.maxListSize)
    console.log(`Found ${dbMembers.length} members in database export`)

    if (dbMembers.length === 0) {
      console.log('No members to sync')
      return
    }

    // Log sample member data for debugging
    if (dbMembers.length > 0) {
      console.log('\nSample database member:', {
        email: dbMembers[0].email,
        membership_status: dbMembers[0].membership_status,
        expiry_date: dbMembers[0].expiry_date,
        is_approved: dbMembers[0].is_approved,
        concession_type: dbMembers[0].concession_type
      })
    }

    // Step 3: Sync unsubscribed status back to database
    console.log('\n=== Syncing unsubscribes back to database ===')
    await syncUnsubscribesToDatabase(mailchimpMembers, dbMembers)

    // Step 4: Format members for Mailchimp, preserving existing data
    console.log('\n=== Preparing member updates ===')
    const formattedMembers = dbMembers.map(member => {
      const existingMember = mailchimpMap.get(member.email.toLowerCase())
      return formatMemberForMailchimp(member, existingMember)
    })

    // Log sample formatted member
    if (formattedMembers.length > 0) {
      console.log('\nSample formatted member:', {
        email: formattedMembers[0].email_address,
        status: formattedMembers[0].status,
        status_if_new: formattedMembers[0].status_if_new,
        tags: formattedMembers[0].tags,
        merge_fields: formattedMembers[0].merge_fields
      })
    }

    // Step 5: Sync updates/additions to Mailchimp
    console.log('\n=== Syncing members to Mailchimp ===')
    const batches = []
    for (let i = 0; i < formattedMembers.length; i += config.sync.batchSize) {
      batches.push(formattedMembers.slice(i, i + config.sync.batchSize))
    }

    console.log(`Syncing ${formattedMembers.length} members in ${batches.length} batches`)

    let totalSuccess = 0
    let totalErrors = 0

    for (let i = 0; i < batches.length; i++) {
      console.log(`\nProcessing batch ${i + 1}/${batches.length} (${batches[i].length} members)`)
      const result = await syncBatchToMailchimp(batches[i])
      totalSuccess += result.success
      totalErrors += result.errors
    }

    console.log(`\n✅ Sync completed: ${totalSuccess} successful, ${totalErrors} errors`)

    // Step 6: Archive members who are no longer in the priority list
    console.log('\n=== Archiving members outside priority list ===')
    const archiveResult = await archiveRemovedMembers(mailchimpMembers, dbMembers)
    console.log(`Archived ${archiveResult.archived} members`)

    console.log('\n🎉 Mailchimp sync completed successfully!')
  } catch (error) {
    console.error('❌ Sync failed:', error)
    process.exit(1)
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  syncMailchimp()
}

export { syncMailchimp, determineTags }
