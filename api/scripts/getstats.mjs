import fs from 'fs'
import pkg from 'pg'
const { Pool } = pkg
// these arrays will have blank last entry due to a trailling newline
const totalMemberNumbersSql = fs.readFileSync('./sql/current-member-count.sql', 'utf8')
const workingMemberNumbersSql = fs.readFileSync('./sql/member-with-discount-count.sql', 'utf8')
const hoursWorkedSinceLastYear = fs.readFileSync('./sql/total-hours-worked.sql', 'utf8')
const totalVolunteersLastYear = fs.readFileSync('./sql/total-workers.sql', 'utf8')

const config = {
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
}

// don't use SSL in development
if (process.env.NODE_ENV === 'development') {
  delete config.ssl
}

const pool = new Pool(config)

async function main () {
  let client
  try {
    client = await pool.connect()
    const totalMemberNumber = await client.query(totalMemberNumbersSql)
    const workingMemberNumber = await client.query(workingMemberNumbersSql)
    const hoursWorked = await client.query(hoursWorkedSinceLastYear)
    const totalVolunteers = await client.query(totalVolunteersLastYear)
    console.log("Member Count: ", totalMemberNumber.rows[0].current_member_count)
    console.log("Working Member Count: ", workingMemberNumber.rows[0].working_member_count)
    console.log("Hours Worked by Volunteers (past year): ", hoursWorked.rows[0].hours_volunteered)
    console.log("Count of Volunteers (past year): ", totalVolunteers.rows[0].total_volunteers)
  } catch (err) {
    console.error(err.message)
  }
  if (client) client.end()
}

main()
