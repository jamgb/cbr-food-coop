import 'dotenv/config'
import pkg from 'pg'
import mailchimp from '@mailchimp/mailchimp_marketing'
import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

// TODO: ensure total list members do not exceed Mailchimp limit.
// Discuss with Josh/Mahesh if we want unsubbed members programatically removed from lists to save costs.
const MAILCHIMP_CUSTOMER_LIMIT = 2500

const { Pool } = pkg

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
})

mailchimp.setConfig({
  apiKey: process.env.MAILCHIMP_API_KEY,
  server: process.env.MAILCHIMP_SERVER_PREFIX
})

// Define which SQL files to use for each Mailchimp list
// In priority order.
const LIST_CONFIGS = [
  {
    sqlFile: 'mailchimp-active-members.sql',
    envVar: 'MAILCHIMP_ACTIVE_MEMBERS_LIST',
    name: 'Active Members'
  },
  {
    sqlFile: 'mailchimp-recently-expired.sql',
    envVar: 'MAILCHIMP_RECENTLY_EXPIRED_LIST',
    name: 'Recently Expired Members'
  },
  {
    sqlFile: 'mailchimp-imminent-expiry.sql',
    envVar: 'MAILCHIMP_IMMINENT_EXPIRY_LIST',
    name: 'Imminently Expiring Members'
  }
]

async function syncMailchimpLists () {
  try {
    console.log('Starting Mailchimp sync...')

    const sqlDir = path.join(__dirname, '..', 'sql')
    const listConfigs = []

    // Load SQL queries from files
    for (const config of LIST_CONFIGS) {
      const listId = process.env[config.envVar]

      if (!listId) {
        console.warn(`⚠ Skipping ${config.name}: ${config.envVar} not set in environment`)
        continue
      }

      const sqlPath = path.join(sqlDir, config.sqlFile)
      const query = await fs.readFile(sqlPath, 'utf-8')

      listConfigs.push({
        listId,
        name: config.name,
        query
      })
    }

    console.log(`Found ${listConfigs.length} Mailchimp list configurations`)

    for (const config of listConfigs) {
      await syncList(config)
    }

    console.log('Mailchimp sync completed successfully')
  } catch (error) {
    console.error('Mailchimp sync failed:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

async function syncList ({ listId, name, query }) {
  console.log(`\nSyncing ${name} list (${listId})...`)

  // Get members from database
  const result = await pool.query(query)
  const dbMembers = result.rows
  const dbEmails = new Set(dbMembers.map(m => m['Email Address'].toLowerCase()))

  console.log(`Found ${dbMembers.length} members in database`)

  // Get current list members from Mailchimp
  const mailchimpMembers = await getAllListMembers(listId)
  const mailchimpEmails = new Map(
    mailchimpMembers.map(m => [m.email_address.toLowerCase(), m.status])
  )

  console.log(`Found ${mailchimpMembers.length} members in Mailchimp`)

  // All operations, which will be executed in batches
  const operations = []

  // Add or update members that should be on the list
  for (const member of dbMembers) {
    const email = member['Email Address'].toLowerCase()
    const currentStatus = mailchimpEmails.get(email)

    // Only add/update if not already subscribed or doesn't exist
    // Skip if user has unsubscribed to respect their choice
    if (currentStatus !== 'unsubscribed') {
      operations.push({
        method: 'PUT',
        path: `/lists/${listId}/members/${md5(email)}`,
        body: JSON.stringify({
          email_address: member['Email Address'],
          status_if_new: 'subscribed', // Only set status if new member
          merge_fields: {
            FNAME: member['First Name'] || '',
            LNAME: member['Last Name'] || '',
            PHONE: member['Phone Number'] || ''
          }
        })
      })
    }
  }

  // Remove members that shouldn't be on the list anymore
  for (const [email, status] of mailchimpEmails) {
    if (!dbEmails.has(email) && status === 'subscribed') {
      operations.push({
        method: 'DELETE',
        path: `/lists/${listId}/members/${md5(email)}`
      })
    }
  }

  console.log(`Operations: ${operations.length} (additions/updates and removals)`)

  // Execute in batches
  const batchSize = 500
  for (let i = 0; i < operations.length; i += batchSize) {
    const batch = operations.slice(i, i + batchSize)

    try {
      const response = await mailchimp.batches.start({ operations: batch })
      console.log(`Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(operations.length / batchSize)} submitted: ${response.id}`)
    } catch (error) {
      console.error('Batch error:', error.response?.body || error.message)
    }
  }

  console.log(`✓ ${name} sync complete`)
}

async function getAllListMembers (listId, count = 1000) {
  const members = []
  let offset = 0

  while (true) {
    const response = await mailchimp.lists.getListMembersInfo(listId, {
      count,
      offset,
      fields: 'members.email_address,members.status,total_items'
    })

    members.push(...response.members)

    if (offset + count >= response.total_items) {
      break
    }
    offset += count
  }

  return members
}

function md5 (str) {
  return crypto.createHash('md5').update(str).digest('hex')
}

syncMailchimpLists()
