import { unlinkSync } from 'fs'
import report from '@/helpers/report'

export default function unlincSyncSafe(path: string) {
  try {
    unlinkSync(path)
  } catch (error) {
    report(error, { location: 'deleting downloaded file' })
  }
}
