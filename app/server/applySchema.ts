import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { createSchemaConnection } from './db.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const envFile = process.argv[2] ?? '.env'
dotenv.config({ path: path.resolve(process.cwd(), envFile) })

const schema = await readFile(path.join(__dirname, 'schema.sql'), 'utf8')
const sql = createSchemaConnection()

// sql.unsafe() with no params array defaults to Postgres's "simple" query
// protocol, which — unlike the "extended" protocol every other query in
// this app uses — allows multiple semicolon-separated statements in one
// call. schema.sql is a whole file of them.
await sql.unsafe(schema)
await sql.end()

console.log(`Schema applied from ${envFile}.`)
