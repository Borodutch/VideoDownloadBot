import * as dotenv from 'dotenv'
import { cleanEnv, num, str } from 'envalid'

dotenv.config({ path: `${__dirname}/../../.env` })

// eslint-disable-next-line node/no-process-env
export default cleanEnv(process.env, {
  TOKEN: str(),
  MONGO: str(),
  ADMIN_ID: num(),
  BOT_API_URL: str({ default: 'http://localhost:8081' }),
})
